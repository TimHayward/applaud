import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { WebhookPayload, WebhookEvent, RecordingRow, WebhookAssetType } from "@applaud/shared";
import { sanitizePlaudSummaryMarkdown } from "@applaud/shared";
import { loadConfig } from "../config.js";
import { getDb } from "../db.js";
import { logger } from "../logger.js";
import { signPayload } from "./sign.js";
import { assertWebhookTargetAllowed, redirectFailureMessage } from "../security/ssrf.js";
import { WEBHOOK_RETRY_BACKOFF_MS, HTTP_FETCH_TIMEOUT_MS, WEBHOOK_MEDIA_URL_TTL_MS } from "../constants.js";
import { issueTicket, withTicket } from "../auth/ticket.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".svg"]);

interface DiscoveredAsset {
  name: string;
  type: WebhookAssetType;
}

const CORE_FILENAMES = new Set(["audio.ogg", "transcript.json", "transcript.txt", "summary.md", "metadata.json"]);

function readIfExists(absPath: string): string | null {
  try {
    if (!existsSync(absPath)) return null;
    return readFileSync(absPath, "utf8");
  } catch (err) {
    logger.warn({ err, absPath }, "failed to read file for webhook inline content");
    return null;
  }
}

function detectAssetType(filename: string): WebhookAssetType | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".md") return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return null;
}

function discoverAssets(folderAbs: string): DiscoveredAsset[] {
  if (!existsSync(folderAbs)) return [];
  const assets: DiscoveredAsset[] = [];
  try {
    const walk = (dirAbs: string, relDir = ""): void => {
      for (const name of readdirSync(dirAbs)) {
        const abs = path.join(dirAbs, name);
        const relPath = relDir ? path.posix.join(relDir, name) : name;
        const stat = statSync(abs);
        if (stat.isDirectory()) {
          walk(abs, relPath);
          continue;
        }
        if (!stat.isFile()) continue;
        if (CORE_FILENAMES.has(relPath)) continue;
        const type = detectAssetType(relPath);
        if (!type) continue;
        assets.push({ name: relPath, type });
      }
    };
    walk(folderAbs);
  } catch (err) {
    logger.warn({ err, folderAbs }, "failed to discover webhook assets");
    return [];
  }
  assets.sort((a, b) => a.name.localeCompare(b.name));
  return assets;
}

/**
 * Builds the `http_urls` for one recording folder: rooted at `publicBaseUrl`
 * (falling back to the bind address, reachable only from this machine) and,
 * when a LAN token is set, carrying a ticket that grants read access to just
 * this folder for WEBHOOK_MEDIA_URL_TTL_MS — so receivers can fetch the files
 * without ever being handed the LAN token itself.
 */
function mediaUrlBuilder(folder: string): (file: string) => string {
  const cfg = loadConfig();
  const host = cfg.bind.host === "0.0.0.0" ? "127.0.0.1" : cfg.bind.host;
  const origin = cfg.publicBaseUrl ?? `http://${host}:${cfg.bind.port}`;
  const base = `${origin}/media/${encodeURI(folder)}`;
  const issued = issueTicket(`/media/${folder}/`, WEBHOOK_MEDIA_URL_TTL_MS);
  return (file) => {
    const url = `${base}/${encodeURIComponent(file)}`;
    return issued ? withTicket(url, issued.ticket) : url;
  };
}

function buildPayload(event: WebhookEvent, row: RecordingRow): WebhookPayload {
  const cfg = loadConfig();
  const mediaUrl = mediaUrlBuilder(row.folder);
  const payload: WebhookPayload = {
    event,
    recording: {
      id: row.id,
      filename: row.filename,
      start_time_ms: row.startTime,
      end_time_ms: row.endTime,
      duration_ms: row.durationMs,
      filesize_bytes: row.filesizeBytes,
      serial_number: row.serialNumber,
    },
    files: {
      folder: row.folder,
      audio: `${row.folder}/${row.audioFilename}`,
      transcript: `${row.folder}/transcript.json`,
      summary: `${row.folder}/summary.md`,
    },
    http_urls: {
      audio: mediaUrl(row.audioFilename),
      transcript: mediaUrl("transcript.json"),
      summary: mediaUrl("summary.md"),
    },
  };

  if (event === "transcript_ready" && cfg.recordingsDir) {
    const folderAbs = path.join(cfg.recordingsDir, row.folder);
    const assets = discoverAssets(folderAbs);
    const rawSummary = readIfExists(path.join(folderAbs, "summary.md"));
    payload.content = {
      transcript_text: readIfExists(path.join(folderAbs, "transcript.txt")),
      summary_markdown:
        rawSummary != null
          ? sanitizePlaudSummaryMarkdown(rawSummary, {
              startTimeMs: row.startTime,
              endTimeMs: row.endTime,
            })
          : null,
    };
    if (assets.length > 0) {
      payload.files.assets = assets.map((asset) => ({
        name: asset.name,
        type: asset.type,
        path: `${row.folder}/${asset.name}`,
      }));
      payload.http_urls.assets = assets.map((asset) => ({
        name: asset.name,
        type: asset.type,
        url: mediaUrl(asset.name),
      }));
      payload.content.assets = assets.map((asset) => {
        const relPath = `${row.folder}/${asset.name}`;
        const url = mediaUrl(asset.name);
        if (asset.type === "markdown") {
          return {
            name: asset.name,
            type: asset.type,
            path: relPath,
            url,
            markdown_text: readIfExists(path.join(folderAbs, asset.name)),
          };
        }
        return {
          name: asset.name,
          type: asset.type,
          path: relPath,
          url,
        };
      });
    }
  }

  return payload;
}

function logAttempt(
  recordingId: string | null,
  event: WebhookEvent,
  url: string,
  statusCode: number | null,
  snippet: string | null,
  durationMs: number,
  error: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO webhook_log (recording_id, event, url, status_code, response_snippet, fired_at, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(recordingId, event, url, statusCode, snippet, Date.now(), durationMs, error);
}

export interface FireOptions {
  /**
   * Cap on delivery attempts for this call, clamped to the retry schedule's
   * length. Automatic re-delivery passes 1: its back-off lives in the DB, so it
   * must not also sit in the in-process retry loop.
   */
  maxAttempts?: number;
}

export async function fireWebhookForRecording(
  event: WebhookEvent,
  row: RecordingRow,
  opts: FireOptions = {},
): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.webhook || !cfg.webhook.enabled || !cfg.webhook.url) return false;
  const payload = buildPayload(event, row);
  return fireRaw(cfg.webhook.url, payload, row.id, event, cfg.webhook.secret, opts);
}

export async function fireRaw(
  url: string,
  payload: WebhookPayload,
  recordingId: string | null,
  event: WebhookEvent,
  secret?: string,
  opts: FireOptions = {},
): Promise<boolean> {
  const body = JSON.stringify(payload);
  // Same timestamp/signature is reused across retries — they're the same
  // logical delivery attempt, not a fresh request each time.
  const timestampSec = Math.floor(Date.now() / 1000);
  const signature = secret ? signPayload(secret, timestampSec, body) : null;
  // A rejected target is a permanent condition — don't burn the retry schedule.
  try {
    await assertWebhookTargetAllowed(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logAttempt(recordingId, event, url, null, null, 0, message);
    logger.warn({ url, message }, "webhook target rejected");
    return false;
  }
  const maxAttempts = Math.max(
    1,
    Math.min(opts.maxAttempts ?? WEBHOOK_RETRY_BACKOFF_MS.length, WEBHOOK_RETRY_BACKOFF_MS.length),
  );
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        redirect: "manual",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "applaud/0.1.0",
          "x-applaud-event": event,
          ...(signature
            ? { "x-applaud-signature": signature, "x-applaud-timestamp": String(timestampSec) }
            : {}),
        },
        body,
        signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
      });
      const redirected = redirectFailureMessage(res);
      const text = redirected ? null : (await res.text().catch(() => "")).slice(0, 500);
      const ok = !redirected && res.status >= 200 && res.status < 300;
      logAttempt(
        recordingId,
        event,
        url,
        res.status,
        text,
        Date.now() - started,
        ok ? null : (redirected ?? `HTTP ${res.status}`),
      );
      if (ok) return true;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, WEBHOOK_RETRY_BACKOFF_MS[attempt]));
        continue;
      }
      return false;
    } catch (err) {
      logAttempt(
        recordingId,
        event,
        url,
        null,
        null,
        Date.now() - started,
        err instanceof Error ? err.message : String(err),
      );
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, WEBHOOK_RETRY_BACKOFF_MS[attempt]));
        continue;
      }
      logger.warn({ err, url }, "webhook fired up all retries");
      return false;
    }
  }
  return false;
}

function buildTestPayload(): WebhookPayload & { test: true } {
  const folder = "2026-04-11_Sample_recording__sample00";
  // Same URL shape as a real delivery (public base URL + signed ticket), so a
  // receiver can be wired up against the test payload.
  const mediaUrl = mediaUrlBuilder(folder);
  const now = Date.now();
  return {
    test: true,
    event: "transcript_ready",
    recording: {
      id: "sample-recording-id",
      filename: "sample.ogg",
      start_time_ms: now - 60_000,
      end_time_ms: now,
      duration_ms: 60_000,
      filesize_bytes: 123456,
      serial_number: "SAMPLE1234",
    },
    files: {
      folder,
      audio: `${folder}/audio.ogg`,
      transcript: `${folder}/transcript.json`,
      summary: `${folder}/summary.md`,
      assets: [
        { name: "summary.md", type: "markdown", path: `${folder}/summary.md` },
        { name: "Speech_Summary.md", type: "markdown", path: `${folder}/Speech_Summary.md` },
        { name: "Highlights.md", type: "markdown", path: `${folder}/Highlights.md` },
        { name: "thumbnail.png", type: "image", path: `${folder}/thumbnail.png` },
      ],
    },
    http_urls: {
      audio: mediaUrl("audio.ogg"),
      transcript: mediaUrl("transcript.json"),
      summary: mediaUrl("summary.md"),
      assets: [
        { name: "summary.md", type: "markdown", url: mediaUrl("summary.md") },
        { name: "Speech_Summary.md", type: "markdown", url: mediaUrl("Speech_Summary.md") },
        { name: "Highlights.md", type: "markdown", url: mediaUrl("Highlights.md") },
        { name: "thumbnail.png", type: "image", url: mediaUrl("thumbnail.png") },
      ],
    },
    content: {
      transcript_text: "This is a sample transcript from an Applaud test webhook.",
      summary_markdown: "# Sample Summary\n\nThis is a sample summary from an Applaud test webhook.",
      assets: [
        {
          name: "summary.md",
          type: "markdown",
          path: `${folder}/summary.md`,
          url: mediaUrl("summary.md"),
          markdown_text: "# Sample Summary\\n\\nThis is a sample summary from an Applaud test webhook.",
        },
        {
          name: "Speech_Summary.md",
          type: "markdown",
          path: `${folder}/Speech_Summary.md`,
          url: mediaUrl("Speech_Summary.md"),
          markdown_text: "# Speech Summary\\n\\nConcise recap.",
        },
        {
          name: "Highlights.md",
          type: "markdown",
          path: `${folder}/Highlights.md`,
          url: mediaUrl("Highlights.md"),
          markdown_text: "# Highlights\\n\\n- Insight 1",
        },
        {
          name: "thumbnail.png",
          type: "image",
          path: `${folder}/thumbnail.png`,
          url: mediaUrl("thumbnail.png"),
        },
      ],
    },
  };
}

/** Test a webhook URL without retries, for UI validation. */
export async function testWebhook(
  url: string,
): Promise<{ ok: boolean; statusCode?: number; bodySnippet?: string; error?: string; durationMs: number }> {
  const started = Date.now();
  const body = JSON.stringify(buildTestPayload());
  const cfg = loadConfig();
  const secret = cfg.webhook?.secret;
  const timestampSec = Math.floor(Date.now() / 1000);
  const signature = secret ? signPayload(secret, timestampSec, body) : null;
  try {
    // This route hands the response body back to the caller, so an unchecked
    // URL would make it a read oracle for anything the server can reach.
    await assertWebhookTargetAllowed(url);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
  try {
    const res = await fetch(url, {
      redirect: "manual",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "applaud/0.1.0",
        "x-applaud-event": "transcript_ready",
        "x-applaud-test": "1",
        ...(signature
          ? { "x-applaud-signature": signature, "x-applaud-timestamp": String(timestampSec) }
          : {}),
      },
      body,
      signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
    });
    const redirected = redirectFailureMessage(res);
    if (redirected) {
      return {
        ok: false,
        statusCode: res.status,
        error: redirected,
        durationMs: Date.now() - started,
      };
    }
    const text = (await res.text().catch(() => "")).slice(0, 500);
    return {
      ok: res.status >= 200 && res.status < 300,
      statusCode: res.status,
      bodySnippet: text,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}
