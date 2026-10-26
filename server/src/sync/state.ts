import { renameSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { RecordingRow, RecordingsSort } from "@applaud/shared";
import { getDb, rowToRecording, type RecordingDbRow } from "../db.js";
import { folderName } from "./layout.js";
import { historyWindowStart } from "./window.js";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { emit } from "./events.js";
import {
  SOFT_DELETE_RETENTION_MS,
  RECORDINGS_LIST_MAX_LIMIT,
  WEBHOOK_REDRIVE_BASE_DELAY_MS,
  WEBHOOK_REDRIVE_MAX_DELAY_MS,
  WEBHOOK_REDRIVE_MAX_ATTEMPTS,
} from "../constants.js";

export { SOFT_DELETE_RETENTION_MS };

function mainListWhereSql(): string {
  return "user_deleted_at IS NULL";
}

/**
 * Rows that still need asset work (used by the poller): inside the history
 * window or explicitly requested, and missing audio, or missing a transcript
 * or summary Plaud may still produce (`plaud_is_trans` / `plaud_is_summary`).
 */
function assetWorkWhereSql(): string {
  return `user_deleted_at IS NULL
       AND (start_time >= @windowStart OR download_requested_at IS NOT NULL)
       AND (
         audio_downloaded_at IS NULL
         OR (transcript_downloaded_at IS NULL AND plaud_is_trans = 1)
         OR (summary_downloaded_at IS NULL AND plaud_is_summary = 1)
       )`;
}

export function isSyncIgnoredId(id: string): boolean {
  const row = getDb()
    .prepare<[string], { c: number }>("SELECT 1 AS c FROM sync_ignore WHERE id = ?")
    .get(id);
  return (row?.c ?? 0) > 0;
}

export function clearSyncIgnore(): number {
  const r = getDb().prepare("DELETE FROM sync_ignore").run();
  return r.changes;
}

export interface SyncBlocklistRow {
  id: string;
  ignoredAt: number;
}

export function listSyncIgnoreRows(): SyncBlocklistRow[] {
  const rows = getDb()
    .prepare<[], { id: string; ignored_at: number }>(
      "SELECT id, ignored_at FROM sync_ignore ORDER BY ignored_at DESC",
    )
    .all();
  return rows.map((r) => ({ id: r.id, ignoredAt: r.ignored_at }));
}

/** A recording as listed by Plaud, normalised for storage. */
export interface PlaudRecordingMeta {
  id: string;
  filename: string;
  startTime: number;
  durationMs: number;
  serialNumber: string;
}

/**
 * Insert a newly listed recording, or apply a rename to a known one. New rows
 * assume Plaud will produce a transcript and summary (the list carries no such
 * flags); the poller corrects that once it has seen the full record.
 */
export function upsertFromPlaud(item: PlaudRecordingMeta): RecordingRow {
  const db = getDb();
  const existing = db
    .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
    .get(item.id);

  if (existing) {
    if (existing.filename !== item.filename) {
      renameRecordingFolder(existing, item.filename);
    }
    return rowToRecording(
      db.prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?").get(item.id)!,
    );
  }

  const cfg = loadConfig();
  if (!cfg.recordingsDir) throw new Error("recordingsDir not configured");
  const folder = folderName(item.startTime, item.filename, item.id);

  db.prepare(
    `INSERT INTO recordings (
      id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number,
      folder, audio_filename, is_trash, plaud_is_summary, plaud_is_trans
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, 0, 1, 1)`,
  ).run(
    item.id,
    item.filename,
    item.startTime,
    item.startTime + item.durationMs,
    item.durationMs,
    item.serialNumber,
    folder,
  );

  return rowToRecording(
    db
      .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
      .get(item.id)!,
  );
}

/** Whether Plaud may still produce a transcript / summary worth polling for. */
export function setPlaudAvailability(id: string, transcript: boolean, summary: boolean): void {
  getDb()
    .prepare("UPDATE recordings SET plaud_is_trans = ?, plaud_is_summary = ? WHERE id = ?")
    .run(transcript ? 1 : 0, summary ? 1 : 0, id);
}

/** Record the audio basename once its real extension is known from the download URL. */
export function setAudioFilename(id: string, audioFilename: string): void {
  getDb().prepare("UPDATE recordings SET audio_filename = ? WHERE id = ?").run(audioFilename, id);
}

/**
 * Ask for a recording outside the history window to be downloaded in full on
 * the next sync. Also re-arms the transcript/summary checks. Returns the
 * updated row, or null when it doesn't exist.
 */
export function requestDownload(id: string): RecordingRow | null {
  const r = getDb()
    .prepare(
      `UPDATE recordings SET download_requested_at = COALESCE(download_requested_at, ?),
         plaud_is_trans = 1, plaud_is_summary = 1, last_error = NULL
       WHERE id = ? AND user_deleted_at IS NULL`,
    )
    .run(Date.now(), id);
  return r.changes > 0 ? getRecordingById(id) : null;
}

/** Ids already in the library (including soft-deleted rows), for the discovery walk's stop rule. */
export function knownRecordingIds(ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare<string[], { id: string }>(`SELECT id FROM recordings WHERE id IN (${placeholders})`)
    .all(...ids);
  return new Set(rows.map((r) => r.id));
}

function renameRecordingFolder(row: RecordingDbRow, newFilename: string): void {
  const cfg = loadConfig();
  if (!cfg.recordingsDir) return;

  const newFolder = folderName(row.start_time, newFilename, row.id);
  if (newFolder === row.folder) {
    getDb().prepare("UPDATE recordings SET filename = ? WHERE id = ?").run(newFilename, row.id);
    emit("recording_renamed", { recordingId: row.id });
    return;
  }

  const oldAbs = path.join(cfg.recordingsDir, row.folder);
  const newAbs = path.join(cfg.recordingsDir, newFolder);

  if (existsSync(oldAbs)) {
    try {
      renameSync(oldAbs, newAbs);
      logger.info({ id: row.id, oldFolder: row.folder, newFolder }, "renamed recording folder");
    } catch (err) {
      // Rename failed — most commonly a folder-name collision (rare; the 8-char
      // id suffix usually disambiguates). Letting it throw here aborts before the
      // DB update, so the row would re-fail on every poll. Keep the existing
      // folder and update only the display filename so the row settles.
      logger.warn(
        { err, id: row.id, oldFolder: row.folder, newFolder },
        "folder rename failed — keeping existing folder, updating filename only",
      );
      getDb().prepare("UPDATE recordings SET filename = ? WHERE id = ?").run(newFilename, row.id);
      emit("recording_renamed", { recordingId: row.id });
      return;
    }
  }

  // File paths are derived from `folder`, so moving the folder is the only
  // DB change needed (the audio filename travels with it).
  getDb()
    .prepare("UPDATE recordings SET filename = ?, folder = ? WHERE id = ?")
    .run(newFilename, newFolder, row.id);
  emit("recording_renamed", { recordingId: row.id });
}

export function markAudioDownloaded(id: string, sizeBytes: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE recordings SET audio_downloaded_at = ?, filesize_bytes = ?, last_error = NULL WHERE id = ?",
    )
    .run(now, sizeBytes, id);
}

export function markTranscriptDownloaded(id: string, transcriptText?: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE recordings SET transcript_downloaded_at = ?, transcript_text = ?, last_error = NULL WHERE id = ?",
    )
    .run(now, transcriptText ?? null, id);
}

export function markSummaryDownloaded(id: string): void {
  getDb()
    .prepare("UPDATE recordings SET summary_downloaded_at = ?, last_error = NULL WHERE id = ?")
    .run(Date.now(), id);
}

/**
 * Resync should refresh transcript/summary artifacts without forcing audio redownload.
 * Also clears any local display-name override — a resync re-pulls from
 * Plaud, so Plaud's filename becomes authoritative again.
 */
export function resetDownloadStateForResync(id: string): void {
  getDb()
    .prepare(
      "UPDATE recordings SET transcript_downloaded_at = NULL, summary_downloaded_at = NULL, last_error = NULL, display_name = NULL WHERE id = ?",
    )
    .run(id);
}

/** Set (or clear, with `null`) a local title override. Cleared automatically on the next resync. */
export function setRecordingDisplayName(id: string, displayName: string | null): RecordingRow | null {
  const trimmed = displayName?.trim();
  const value = trimmed && trimmed.length > 0 ? trimmed.slice(0, 300) : null;
  getDb().prepare("UPDATE recordings SET display_name = ? WHERE id = ?").run(value, id);
  return getRecordingById(id);
}

type WebhookReadyEvent = "audio_ready" | "transcript_ready";

/** Column prefix shared by `<p>_downloaded_at` and `webhook_<p>_*` for an event. */
function webhookColumnPrefix(event: WebhookReadyEvent): "audio" | "transcript" {
  return event === "audio_ready" ? "audio" : "transcript";
}

/** Marks a delivery confirmed and clears its re-delivery back-off. */
export function markWebhookFired(id: string, event: WebhookReadyEvent): void {
  const p = webhookColumnPrefix(event);
  getDb()
    .prepare(
      `UPDATE recordings SET webhook_${p}_fired_at = ?, webhook_${p}_attempts = 0, webhook_${p}_next_at = NULL WHERE id = ?`,
    )
    .run(Date.now(), id);
}

/** Back-off before re-delivery attempt number `attempts + 1`: BASE × 3^(attempts-1), capped. */
export function webhookRedriveDelayMs(attempts: number): number {
  return Math.min(WEBHOOK_REDRIVE_BASE_DELAY_MS * 3 ** Math.max(0, attempts - 1), WEBHOOK_REDRIVE_MAX_DELAY_MS);
}

/**
 * Records a failed delivery: bumps the attempt count and schedules the next
 * automatic re-delivery. Once the count reaches WEBHOOK_REDRIVE_MAX_ATTEMPTS,
 * Phase 2b stops picking the row up (manual Redeliver still works).
 */
export function recordWebhookFailure(id: string, event: WebhookReadyEvent, now = Date.now()): void {
  const p = webhookColumnPrefix(event);
  const db = getDb();
  const row = db
    .prepare<[string], { attempts: number }>(`SELECT webhook_${p}_attempts AS attempts FROM recordings WHERE id = ?`)
    .get(id);
  if (!row) return;
  const attempts = row.attempts + 1;
  db.prepare(`UPDATE recordings SET webhook_${p}_attempts = ?, webhook_${p}_next_at = ? WHERE id = ?`).run(
    attempts,
    now + webhookRedriveDelayMs(attempts),
    id,
  );
}

export function recordError(id: string, message: string): void {
  getDb()
    .prepare("UPDATE recordings SET last_error = ? WHERE id = ?")
    .run(message.slice(0, 500), id);
}

export function clearError(id: string): void {
  getDb().prepare("UPDATE recordings SET last_error = NULL WHERE id = ?").run(id);
}

const SORT_COLUMNS: Record<RecordingsSort, string> = {
  date_desc: "start_time DESC",
  date_asc: "start_time ASC",
  duration_desc: "duration_ms DESC",
  duration_asc: "duration_ms ASC",
  size_desc: "filesize_bytes DESC",
  size_asc: "filesize_bytes ASC",
};

export function listRecordingRows(
  opts: {
    limit?: number;
    offset?: number;
    search?: string;
    includeInactive?: boolean;
    from?: number;
    to?: number;
    sort?: RecordingsSort;
    starred?: boolean;
  } = {},
): { total: number; totalBytes: number; items: RecordingRow[] } {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 100, RECORDINGS_LIST_MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  const search = opts.search?.trim();
  const activeOnly = !opts.includeInactive;
  const orderBy = SORT_COLUMNS[opts.sort ?? "date_desc"] ?? SORT_COLUMNS.date_desc;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (activeOnly) conditions.push(mainListWhereSql());
  if (search) {
    conditions.push("(filename LIKE ? OR transcript_text LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like);
  }
  if (opts.from != null) {
    conditions.push("start_time >= ?");
    params.push(opts.from);
  }
  if (opts.to != null) {
    conditions.push("start_time <= ?");
    params.push(opts.to);
  }
  if (opts.starred) {
    conditions.push("is_starred = 1");
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const aggRow = db
    .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(filesize_bytes), 0) AS b FROM recordings ${whereSql}`)
    .get(...params) as { c: number; b: number } | undefined;

  const rows = db
    .prepare(`SELECT * FROM recordings ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as RecordingDbRow[];

  return {
    total: aggRow?.c ?? 0,
    totalBytes: aggRow?.b ?? 0,
    items: rows.map(rowToRecording),
  };
}

export function listSoftDeletedRows(
  opts: { limit?: number; offset?: number } = {},
): { total: number; totalBytes: number; items: RecordingRow[] } {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 100, RECORDINGS_LIST_MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  const aggRow = db
    .prepare<[], { c: number; b: number }>(
      "SELECT COUNT(*) AS c, COALESCE(SUM(filesize_bytes), 0) AS b FROM recordings WHERE user_deleted_at IS NOT NULL",
    )
    .get();
  const rows = db
    .prepare<[number, number], RecordingDbRow>(
      "SELECT * FROM recordings WHERE user_deleted_at IS NOT NULL ORDER BY user_deleted_at DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset);
  return {
    total: aggRow?.c ?? 0,
    totalBytes: aggRow?.b ?? 0,
    items: rows.map(rowToRecording),
  };
}

export function getRecordingById(id: string): RecordingRow | null {
  const row = getDb()
    .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
    .get(id);
  return row ? rowToRecording(row) : null;
}

/** Permanently remove the DB row (after files removed). Used by purge only. */
export function removeRecordingRow(id: string): void {
  getDb().prepare("DELETE FROM recordings WHERE id = ?").run(id);
}

export function softDeleteRecording(id: string): void {
  const now = Date.now();
  getDb()
    .prepare("UPDATE recordings SET user_deleted_at = ?, user_purge_at = ? WHERE id = ?")
    .run(now, now + SOFT_DELETE_RETENTION_MS, id);
}

export function restoreRecording(id: string): void {
  getDb()
    .prepare("UPDATE recordings SET user_deleted_at = NULL, user_purge_at = NULL WHERE id = ?")
    .run(id);
}

/** @returns false if disk removal was required and failed (DB row kept). */
function purgeOneSoftDeletedRow(row: RecordingDbRow, now: number): boolean {
  const cfg = loadConfig();
  if (cfg.recordingsDir) {
    const folderAbs = path.join(cfg.recordingsDir, row.folder);
    try {
      rmSync(folderAbs, { recursive: true, force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, id: row.id, folderAbs },
        "purge: failed to remove folder; retaining DB row to avoid orphan data on disk",
      );
      getDb()
        .prepare("UPDATE recordings SET last_error = ? WHERE id = ?")
        .run(`Purge failed (disk): ${msg}`.slice(0, 500), row.id);
      return false;
    }
  }
  try {
    getDb().prepare("INSERT OR REPLACE INTO sync_ignore (id, ignored_at) VALUES (?, ?)").run(row.id, now);
  } catch (err) {
    logger.warn({ err, id: row.id }, "purge: failed to insert sync_ignore");
  }
  removeRecordingRow(row.id);
  logger.info({ id: row.id }, "soft-delete purge complete; id added to sync_ignore");
  return true;
}

export function purgeExpiredSoftDeletes(): void {
  const now = Date.now();
  const rows = getDb()
    .prepare<[number], RecordingDbRow>(
      "SELECT * FROM recordings WHERE user_deleted_at IS NOT NULL AND user_purge_at IS NOT NULL AND user_purge_at <= ?",
    )
    .all(now) as RecordingDbRow[];

  for (const row of rows) {
    purgeOneSoftDeletedRow(row, now);
  }
}

/** Permanently remove a soft-deleted row immediately (same as scheduled purge). */
export function purgeSoftDeletedRecordingNow(
  id: string,
): "ok" | "not_found" | "not_in_trash" | "disk_error" {
  const row = getDb()
    .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
    .get(id);
  if (!row) return "not_found";
  if (row.user_deleted_at == null) return "not_in_trash";
  return purgeOneSoftDeletedRow(row, Date.now()) ? "ok" : "disk_error";
}

export function countPendingTranscripts(): number {
  const row = getDb()
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM recordings WHERE audio_downloaded_at IS NOT NULL AND transcript_downloaded_at IS NULL
       AND plaud_is_trans = 1 AND user_deleted_at IS NULL`,
    )
    .get();
  return row?.c ?? 0;
}

export function countPendingSummaries(): number {
  const row = getDb()
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM recordings WHERE audio_downloaded_at IS NOT NULL AND transcript_downloaded_at IS NOT NULL
       AND summary_downloaded_at IS NULL AND plaud_is_summary = 1 AND user_deleted_at IS NULL`,
    )
    .get();
  return row?.c ?? 0;
}

export function countErrorsLast24h(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const row = getDb()
    .prepare<[number, number], { c: number }>(
      "SELECT COUNT(*) AS c FROM recordings WHERE last_error IS NOT NULL AND (audio_downloaded_at > ? OR transcript_downloaded_at > ?)",
    )
    .get(cutoff, cutoff);
  return row?.c ?? 0;
}

export function findRecordingsNeedingAssets(): RecordingRow[] {
  const w = assetWorkWhereSql();
  const rows = getDb()
    .prepare<{ windowStart: number }, RecordingDbRow>(`SELECT * FROM recordings WHERE ${w} ORDER BY start_time DESC`)
    .all({ windowStart: historyWindowStart(loadConfig()) });
  return rows.map(rowToRecording);
}

/** SQL predicate: this row's `p` webhook is due for automatic re-delivery. */
function webhookDueSql(p: "audio" | "transcript"): string {
  return `(${p}_downloaded_at IS NOT NULL AND ${p}_downloaded_at >= @cutoff
           AND webhook_${p}_fired_at IS NULL
           AND webhook_${p}_attempts < @maxAttempts
           AND (webhook_${p}_next_at IS NULL OR webhook_${p}_next_at <= @now))`;
}

/** JS mirror of `webhookDueSql`, used to split a matched row into its due events. */
function isWebhookDue(
  row: RecordingDbRow,
  p: "audio" | "transcript",
  opts: { cutoff: number; now: number },
): boolean {
  const downloadedAt = p === "audio" ? row.audio_downloaded_at : row.transcript_downloaded_at;
  const firedAt = p === "audio" ? row.webhook_audio_fired_at : row.webhook_transcript_fired_at;
  const attempts = p === "audio" ? row.webhook_audio_attempts : row.webhook_transcript_attempts;
  const nextAt = p === "audio" ? row.webhook_audio_next_at : row.webhook_transcript_next_at;
  return (
    downloadedAt != null &&
    downloadedAt >= opts.cutoff &&
    firedAt == null &&
    attempts < WEBHOOK_REDRIVE_MAX_ATTEMPTS &&
    (nextAt == null || nextAt <= opts.now)
  );
}

/**
 * Deliveries due for automatic re-delivery (poller Phase 2b): an asset that was
 * downloaded at or after `cutoff` (when the webhook was enabled), has never
 * been confirmed delivered, is under the attempt cap, and is past its back-off.
 * Mirrors the download path's fire semantics: audio_ready for any downloaded
 * audio, transcript_ready for any downloaded transcript. At most `limit` events.
 */
export function findRecordingsNeedingWebhook(opts: {
  cutoff: number;
  now: number;
  limit: number;
}): {
  row: RecordingRow;
  event: WebhookReadyEvent;
}[] {
  const rows = getDb()
    .prepare<{ cutoff: number; now: number; maxAttempts: number; limit: number }, RecordingDbRow>(
      `SELECT * FROM recordings
       WHERE user_deleted_at IS NULL
         AND (${webhookDueSql("audio")} OR ${webhookDueSql("transcript")})
       ORDER BY start_time DESC
       LIMIT @limit`,
    )
    .all({ cutoff: opts.cutoff, now: opts.now, maxAttempts: WEBHOOK_REDRIVE_MAX_ATTEMPTS, limit: opts.limit });
  const out: { row: RecordingRow; event: WebhookReadyEvent }[] = [];
  for (const dbRow of rows) {
    const row = rowToRecording(dbRow);
    if (isWebhookDue(dbRow, "audio", opts)) out.push({ row, event: "audio_ready" });
    if (isWebhookDue(dbRow, "transcript", opts)) {
      out.push({ row, event: "transcript_ready" });
    }
  }
  return out.slice(0, opts.limit);
}
