import type { RecordingRow, PlaudRawRecording } from "@applaud/shared";
import { getDb, rowToRecording, type RecordingDbRow } from "../db.js";
import { folderName, recordingPaths } from "./layout.js";
import { loadConfig } from "../config.js";

export interface UpsertOptions {
  isHistorical?: boolean;
}

export function upsertFromPlaud(item: PlaudRawRecording, opts: UpsertOptions = {}): RecordingRow {
  const db = getDb();
  const existing = db
    .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
    .get(item.id);
  if (existing) return rowToRecording(existing);

  const cfg = loadConfig();
  if (!cfg.recordingsDir) throw new Error("recordingsDir not configured");
  const folder = folderName(item.start_time, item.filename, item.id);
  const paths = recordingPaths(cfg.recordingsDir, folder);

  db.prepare(
    `INSERT INTO recordings (
      id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number,
      folder, audio_path, transcript_path, summary_path, metadata_path,
      audio_downloaded_at, transcript_downloaded_at, webhook_audio_fired_at,
      webhook_transcript_fired_at, is_historical, last_error, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
  ).run(
    item.id,
    item.filename,
    item.start_time,
    item.end_time,
    item.duration,
    item.filesize,
    item.serial_number,
    folder,
    paths.audioPath,
    paths.transcriptJsonPath,
    paths.summaryMdPath,
    paths.metadataPath,
    opts.isHistorical ? 1 : 0,
  );

  return rowToRecording(
    db
      .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
      .get(item.id)!,
  );
}

export function markAudioDownloaded(id: string, sizeBytes: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE recordings SET audio_downloaded_at = ?, filesize_bytes = ?, last_error = NULL WHERE id = ?",
    )
    .run(now, sizeBytes, id);
}

export function markTranscriptDownloaded(id: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE recordings SET transcript_downloaded_at = ?, last_error = NULL WHERE id = ?",
    )
    .run(now, id);
}

export function markWebhookFired(id: string, event: "audio_ready" | "transcript_ready"): void {
  const col = event === "audio_ready" ? "webhook_audio_fired_at" : "webhook_transcript_fired_at";
  getDb().prepare(`UPDATE recordings SET ${col} = ? WHERE id = ?`).run(Date.now(), id);
}

export function recordError(id: string, message: string): void {
  getDb()
    .prepare("UPDATE recordings SET last_error = ? WHERE id = ?")
    .run(message.slice(0, 500), id);
}

export function clearError(id: string): void {
  getDb().prepare("UPDATE recordings SET last_error = NULL WHERE id = ?").run(id);
}

export function listRecordingRows(
  opts: { limit?: number; offset?: number; search?: string } = {},
): { total: number; items: RecordingRow[] } {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const search = opts.search?.trim();

  let totalRow: { c: number } | undefined;
  let rows: RecordingDbRow[];
  if (search) {
    const like = `%${search}%`;
    totalRow = db
      .prepare<[string], { c: number }>(
        "SELECT COUNT(*) AS c FROM recordings WHERE filename LIKE ?",
      )
      .get(like);
    rows = db
      .prepare<[string, number, number], RecordingDbRow>(
        "SELECT * FROM recordings WHERE filename LIKE ? ORDER BY start_time DESC LIMIT ? OFFSET ?",
      )
      .all(like, limit, offset);
  } else {
    totalRow = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM recordings").get();
    rows = db
      .prepare<[number, number], RecordingDbRow>(
        "SELECT * FROM recordings ORDER BY start_time DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset);
  }
  return {
    total: totalRow?.c ?? 0,
    items: rows.map(rowToRecording),
  };
}

export function getRecordingById(id: string): RecordingRow | null {
  const row = getDb()
    .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
    .get(id);
  return row ? rowToRecording(row) : null;
}

export function deleteRecording(id: string): void {
  getDb().prepare("DELETE FROM recordings WHERE id = ?").run(id);
}

export function countPendingTranscripts(): number {
  const row = getDb()
    .prepare<[], { c: number }>(
      "SELECT COUNT(*) AS c FROM recordings WHERE audio_downloaded_at IS NOT NULL AND transcript_downloaded_at IS NULL",
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

export function findPendingTranscriptIds(): string[] {
  const rows = getDb()
    .prepare<[], { id: string }>(
      "SELECT id FROM recordings WHERE audio_downloaded_at IS NOT NULL AND transcript_downloaded_at IS NULL AND is_historical = 0",
    )
    .all();
  return rows.map((r) => r.id);
}
