import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  PLAUD_AUTOMATION_CLIENT_FILE,
  plaudAutomationConfig,
  type AppConfig,
  type PlaudAutomationClientFile,
  type PlaudAutomationHeartbeat,
  type PlaudAutomationNextResponse,
  type PlaudAutomationStatus,
  type PlaudWritebackRecording,
} from "@applaud/shared";
import { getDb } from "../db.js";
import { writeFileAtomic } from "../fsAtomic.js";
import { logger } from "../logger.js";
import { AUTOMATION_APPLAUD_URL, AUTOMATION_DIR, AUTOMATION_VIEWER_PORT } from "../constants.js";
import { hashToken } from "./clients.js";
import { listPending } from "./store.js";

/**
 * Automatic Plaud sync (docs/plans/plaud-write-back-extension.md, "Unattended
 * mode"). An always-on browser container runs the Applaud automation
 * extension. While Settings → Automatic Plaud sync is on, Applaud gives that
 * browser its own client token through a folder both containers mount
 * (`APPLAUD_AUTOMATION_DIR`); turning it off deletes the file and revokes the
 * token. There is no pairing code.
 *
 * Applaud decides when the browser runs (P2): it checks in every minute and
 * runs when `next()` says it is due, which is every few minutes or on "Run
 * now". It only contacts Plaud when Applaud has work for it.
 */

/** A routine run is due this long after the previous one. */
export const RUN_INTERVAL_MS = 5 * 60 * 1000;
/** A recording whose last attempt failed or conflicted waits this long before an automatic retry. */
export const RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** Settings and the Dashboard warn when the browser hasn't checked in for this long. */
export const NOT_SEEN_MS = 30 * 60 * 1000;

const CLIENT_NAME = "Applaud browser (automatic)";

let dirOverride: string | null | undefined;
let runRequestedAt: number | null = null;

function automationDir(): string | null {
  return dirOverride !== undefined ? dirOverride : AUTOMATION_DIR;
}

/** Tests only: point at a temporary folder (or null for "not available"). */
export function setAutomationDirForTests(dir: string | null | undefined): void {
  dirOverride = dir;
  runRequestedAt = null;
}

export function automationAvailable(): boolean {
  return automationDir() !== null;
}

function clientFile(): string | null {
  const dir = automationDir();
  return dir ? path.join(dir, PLAUD_AUTOMATION_CLIENT_FILE) : null;
}

interface AutomationRow {
  id: number;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
  last_heartbeat_at: number | null;
  last_heartbeat: string | null;
  last_run_at: number | null;
  paused_reason: string | null;
}

function activeRow(): AutomationRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, token_hash, created_at, last_used_at, last_heartbeat_at, last_heartbeat, last_run_at, paused_reason
         FROM plaud_writeback_clients WHERE kind = 'automation' AND revoked_at IS NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as AutomationRow | undefined) ?? null
  );
}

function revokeAll(now: number): void {
  getDb()
    .prepare(
      "UPDATE plaud_writeback_clients SET revoked_at = ? WHERE kind = 'automation' AND revoked_at IS NULL",
    )
    .run(now);
}

function readClientFile(file: string): PlaudAutomationClientFile | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PlaudAutomationClientFile>;
    return typeof parsed.token === "string" && typeof parsed.applaudUrl === "string"
      ? { token: parsed.token, applaudUrl: parsed.applaudUrl }
      : null;
  } catch {
    return null;
  }
}

/**
 * Make the credential match the setting: on, a live automation client whose
 * token is in the shared file; off (or the folder not configured), no file
 * and no live client. Called at startup and whenever the setting changes.
 */
export function applyAutomation(cfg: Pick<AppConfig, "plaudAutomation">, now = Date.now()): void {
  const file = clientFile();
  const enabled = plaudAutomationConfig(cfg).enabled && file !== null;
  if (!enabled) {
    revokeAll(now);
    if (file && existsSync(file)) {
      try {
        rmSync(file);
      } catch (err) {
        logger.warn({ err }, "could not delete the automation browser's credential file");
      }
    }
    return;
  }
  const row = activeRow();
  const onDisk = readClientFile(file);
  if (row && onDisk && hashToken(onDisk.token) === row.token_hash) return;

  const token = randomBytes(32).toString("hex");
  mkdirSync(path.dirname(file), { recursive: true });
  const body: PlaudAutomationClientFile = { applaudUrl: AUTOMATION_APPLAUD_URL, token };
  getDb().transaction(() => {
    // Keep what the browser last reported across a re-issue (a lost file, say).
    revokeAll(now);
    getDb()
      .prepare(
        `INSERT INTO plaud_writeback_clients
           (name, token_hash, created_at, kind, last_heartbeat_at, last_heartbeat, last_run_at, paused_reason)
         VALUES (?, ?, ?, 'automation', ?, ?, ?, ?)`,
      )
      .run(
        CLIENT_NAME,
        hashToken(token),
        now,
        row?.last_heartbeat_at ?? null,
        row?.last_heartbeat ?? null,
        row?.last_run_at ?? null,
        row?.paused_reason ?? null,
      );
  })();
  // The browser container runs as the same uid (docs/portainer.md), so 0600 is enough.
  writeFileAtomic(file, JSON.stringify(body), { mode: 0o600 });
  logger.info("issued the automation browser's credential for automatic Plaud sync");
}

function lastHeartbeat(
  row: Pick<AutomationRow, "last_heartbeat"> | null,
): PlaudAutomationHeartbeat | null {
  if (!row?.last_heartbeat) return null;
  try {
    return JSON.parse(row.last_heartbeat) as PlaudAutomationHeartbeat;
  } catch {
    return null;
  }
}

/** Whether the automation browser should run now, and what it may do. */
export function next(
  cfg: Pick<AppConfig, "plaudAutomation">,
  now = Date.now(),
): PlaudAutomationNextResponse {
  const a = plaudAutomationConfig(cfg);
  const row = activeRow();
  const paused = row?.paused_reason ?? null;
  const last = row?.last_heartbeat_at ?? null;
  const requested = runRequestedAt !== null && (last === null || runRequestedAt > last);
  const due =
    a.enabled &&
    paused === null &&
    (a.names || a.cards) &&
    (requested || last === null || now - last >= RUN_INTERVAL_MS);
  return { enabled: a.enabled, due, names: a.names, cards: a.cards, paused };
}

/** "Run now" in Settings: the browser runs at its next check-in, within a minute. */
export function requestRun(now = Date.now()): void {
  runRequestedAt = now;
}

export function recordHeartbeat(
  clientId: number,
  hb: PlaudAutomationHeartbeat,
  now = Date.now(),
): void {
  const pause = hb.shapeError
    ? (hb.error?.slice(0, 500) ?? "Plaud answered in a shape Applaud doesn't recognise")
    : null;
  // Settings' "Last run" shows the last run that did something; an idle
  // check-in only refreshes the sign-in state. Sign-in "unknown" (no Plaud
  // tab was looked at) keeps the last known state.
  const prevRow = getDb()
    .prepare("SELECT last_heartbeat FROM plaud_writeback_clients WHERE id = ?")
    .get(clientId) as { last_heartbeat: string | null } | undefined;
  const prev = lastHeartbeat(prevRow ?? null);
  const plaudSignedIn = hb.plaudSignedIn ?? prev?.plaudSignedIn ?? null;
  const stored: PlaudAutomationHeartbeat =
    hb.ran || !prev ? { ...hb, plaudSignedIn } : { ...prev, plaudSignedIn };
  getDb()
    .prepare(
      `UPDATE plaud_writeback_clients
       SET last_heartbeat_at = ?, last_heartbeat = ?,
           last_run_at = CASE WHEN ? THEN ? ELSE last_run_at END,
           paused_reason = COALESCE(?, paused_reason)
       WHERE id = ?`,
    )
    .run(now, JSON.stringify(stored), hb.ran ? 1 : 0, now, pause, clientId);
  if (pause) logger.warn({ reason: pause }, "automatic Plaud sync paused");
}

export function resume(): void {
  getDb()
    .prepare(
      "UPDATE plaud_writeback_clients SET paused_reason = NULL WHERE kind = 'automation' AND revoked_at IS NULL",
    )
    .run();
}

/**
 * What the automation browser may send now: recordings ready to send, less
 * those already sent and awaiting Applaud's re-read (W7), and those whose last
 * attempt failed or conflicted recently. Every attempt starts from a fresh read
 * of Plaud (W5), so the back-off only caps how often one is retried.
 */
export function automationPending(now = Date.now()): PlaudWritebackRecording[] {
  return listPending().filter(
    (r) =>
      (r.state === "to_send" || r.state === "partial") &&
      !(
        r.lastError !== null &&
        r.lastAttemptAt !== null &&
        now - r.lastAttemptAt < RETRY_BACKOFF_MS
      ),
  );
}

export function automationStatus(
  cfg: Pick<AppConfig, "plaudAutomation">,
  now = Date.now(),
): PlaudAutomationStatus {
  const a = plaudAutomationConfig(cfg);
  const row = a.enabled ? activeRow() : null;
  const last = lastHeartbeat(row);
  const lastSeenAt = row?.last_used_at ?? null;
  const paused = row?.paused_reason ?? null;
  const plaudSignedIn = last?.plaudSignedIn ?? null;
  let needsAttention: PlaudAutomationStatus["needsAttention"] = null;
  if (a.enabled && automationAvailable()) {
    if (paused) needsAttention = "paused";
    else if (now - (lastSeenAt ?? row?.created_at ?? now) > NOT_SEEN_MS)
      needsAttention = "not_seen";
    else if (plaudSignedIn === false) needsAttention = "signed_out";
  }
  return {
    available: automationAvailable(),
    enabled: a.enabled,
    names: a.names,
    cards: a.cards,
    viewerUrl: a.viewerUrl,
    viewerPort: AUTOMATION_VIEWER_PORT,
    lastSeenAt,
    lastRunAt: row?.last_run_at ?? null,
    plaudSignedIn,
    last,
    paused,
    needsAttention,
  };
}
