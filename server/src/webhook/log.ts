import type { WebhookLogEntry } from "@applaud/shared";
import { getDb } from "../db.js";

interface WebhookLogDbRow {
  id: number;
  recording_id: string | null;
  recording_filename: string | null;
  event: string;
  url: string;
  status_code: number | null;
  response_snippet: string | null;
  fired_at: number;
  duration_ms: number | null;
  error: string | null;
}

/** Recent webhook delivery attempts, newest first, with the recording's filename joined in. */
export function listWebhookLog(opts: { limit?: number; offset?: number } = {}): {
  total: number;
  items: WebhookLogEntry[];
} {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const totalRow = db.prepare("SELECT COUNT(*) AS c FROM webhook_log").get() as { c: number } | undefined;
  const rows = db
    .prepare(
      `SELECT wl.*, r.filename AS recording_filename
       FROM webhook_log wl LEFT JOIN recordings r ON r.id = wl.recording_id
       ORDER BY wl.fired_at DESC, wl.id DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as WebhookLogDbRow[];
  return {
    total: totalRow?.c ?? 0,
    items: rows.map((row) => ({
      id: row.id,
      recordingId: row.recording_id,
      recordingFilename: row.recording_filename,
      event: row.event,
      url: row.url,
      statusCode: row.status_code,
      responseSnippet: row.response_snippet,
      firedAt: row.fired_at,
      durationMs: row.duration_ms,
      error: row.error,
    })),
  };
}
