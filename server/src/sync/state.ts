import { renameSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { RecordingRow, PlaudRawRecording, RecordingsSort } from "@applaud/shared";
import { getDb, rowToRecording, type RecordingDbRow } from "../db.js";
import { folderName, recordingPaths, audioFilenameForFiletype } from "./layout.js";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { emit } from "./events.js";
import {
  SOFT_DELETE_RETENTION_MS,
  PLAUD_TRASH_ASSET_PROBE_INTERVAL_MS,
  PLAUD_TRASH_ASSET_PROBE_SCHEDULED_LIMIT,
  PLAUD_TRASH_ASSET_PROBE_MANUAL_SYNC_LIMIT,
  RECORDINGS_LIST_MAX_LIMIT,
} from "../constants.js";

export {
  SOFT_DELETE_RETENTION_MS,
  PLAUD_TRASH_ASSET_PROBE_INTERVAL_MS,
  PLAUD_TRASH_ASSET_PROBE_SCHEDULED_LIMIT,
  PLAUD_TRASH_ASSET_PROBE_MANUAL_SYNC_LIMIT,
};

function mainListWhereSql(): string {
  if (loadConfig().importPlaudDeleted) {
    return "user_deleted_at IS NULL";
  }
  return "user_deleted_at IS NULL AND is_trash = 0";
}

/** Rows that still need cloud asset work (used by the poller). */
function assetWorkWhereSql(): string {
  const cfg = loadConfig();
  const trashOk = cfg.importPlaudDeleted ? "" : " AND is_trash = 0";
  // Plaud-trashed files (is_trash=1): only sync audio when import is enabled — never transcript/summary.
  return `user_deleted_at IS NULL${trashOk}
       AND (
         audio_downloaded_at IS NULL
         OR (is_trash = 0 AND (
              transcript_downloaded_at IS NULL
              OR (summary_downloaded_at IS NULL AND plaud_is_summary = 1)
            ))
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

export function upsertFromPlaud(item: PlaudRawRecording): RecordingRow {
  const db = getDb();
  const existing = db
    .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
    .get(item.id);
  const starredVal = item.is_markmemo ? 1 : 0;
  const tagsJson = item.filetag_id_list && item.filetag_id_list.length > 0 ? JSON.stringify(item.filetag_id_list) : null;

  if (existing) {
    if (existing.filename !== item.filename) {
      renameRecordingFolder(existing, item.filename);
    }
    const trashVal = item.is_trash ? 1 : 0;
    const summVal = item.is_summary ? 1 : 0;
    if (
      existing.is_trash !== trashVal ||
      existing.plaud_is_summary !== summVal ||
      (existing.is_starred ?? 0) !== starredVal ||
      (existing.plaud_tags ?? null) !== tagsJson
    ) {
      db.prepare(
        "UPDATE recordings SET is_trash = ?, plaud_is_summary = ?, is_starred = ?, plaud_tags = ? WHERE id = ?",
      ).run(trashVal, summVal, starredVal, tagsJson, item.id);
    }
    return rowToRecording(
      db.prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?").get(item.id)!,
    );
  }

  const cfg = loadConfig();
  if (!cfg.recordingsDir) throw new Error("recordingsDir not configured");
  const folder = folderName(item.start_time, item.filename, item.id);
  const paths = recordingPaths(cfg.recordingsDir, folder, audioFilenameForFiletype(item.filetype));

  db.prepare(
    `INSERT INTO recordings (
      id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number,
      folder, audio_path, transcript_path, summary_path, metadata_path,
      audio_downloaded_at, transcript_downloaded_at, webhook_audio_fired_at,
      webhook_transcript_fired_at, is_trash, last_error, metadata_json,
      user_deleted_at, user_purge_at, plaud_is_summary, summary_downloaded_at,
      is_starred, plaud_tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
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
    item.is_trash ? 1 : 0,
    item.is_summary ? 1 : 0,
    starredVal,
    tagsJson,
  );

  return rowToRecording(
    db
      .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
      .get(item.id)!,
  );
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
    renameSync(oldAbs, newAbs);
    logger.info({ id: row.id, oldFolder: row.folder, newFolder }, "renamed recording folder");
  }

  // Preserve the recording's actual audio filename (e.g. audio.mp3) across the
  // folder move — don't recompute it back to the default.
  const audioFilename = row.audio_path ? path.basename(row.audio_path) : undefined;
  const newPaths = recordingPaths(cfg.recordingsDir, newFolder, audioFilename);
  getDb()
    .prepare(
      `UPDATE recordings
         SET filename = ?, folder = ?, audio_path = ?, transcript_path = ?, summary_path = ?, metadata_path = ?
       WHERE id = ?`,
    )
    .run(
      newFilename,
      newFolder,
      newPaths.audioPath,
      newPaths.transcriptJsonPath,
      newPaths.summaryMdPath,
      newPaths.metadataPath,
      row.id,
    );
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
       AND user_deleted_at IS NULL AND is_trash = 0`,
    )
    .get();
  return row?.c ?? 0;
}

export function countPendingSummaries(): number {
  const row = getDb()
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM recordings WHERE audio_downloaded_at IS NOT NULL AND transcript_downloaded_at IS NOT NULL
       AND summary_downloaded_at IS NULL AND plaud_is_summary = 1 AND user_deleted_at IS NULL AND is_trash = 0`,
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
    .prepare<[], RecordingDbRow>(`SELECT * FROM recordings WHERE ${w} ORDER BY start_time DESC`)
    .all();
  return rows.map(rowToRecording);
}

export function findPlaudTrashAssetProbeCandidates(probeOlderThan: number, limit: number): RecordingRow[] {
  if (!loadConfig().importPlaudDeleted) return [];
  const rows = getDb()
    .prepare<[number, number], RecordingDbRow>(
      `SELECT * FROM recordings
       WHERE user_deleted_at IS NULL
         AND is_trash = 1
         AND audio_downloaded_at IS NOT NULL
         AND (
           transcript_downloaded_at IS NULL
           OR (summary_downloaded_at IS NULL AND plaud_is_summary = 1)
         )
         AND (trash_asset_probe_at IS NULL OR trash_asset_probe_at < ?)
       ORDER BY trash_asset_probe_at ASC, start_time DESC
       LIMIT ?`,
    )
    .all(probeOlderThan, limit);
  return rows.map(rowToRecording);
}

export function markTrashAssetProbed(id: string): void {
  getDb().prepare("UPDATE recordings SET trash_asset_probe_at = ? WHERE id = ?").run(Date.now(), id);
}

/** Clears probe timers so the next Phase-3 pass can consider all eligible Plaud-trash rows (e.g. after Sync Now). */
export function resetPlaudTrashAssetProbeTimestamps(): number {
  const r = getDb()
    .prepare(
      `UPDATE recordings SET trash_asset_probe_at = NULL
       WHERE user_deleted_at IS NULL
         AND is_trash = 1
         AND audio_downloaded_at IS NOT NULL
         AND (
           transcript_downloaded_at IS NULL
           OR (summary_downloaded_at IS NULL AND plaud_is_summary = 1)
         )`,
    )
    .run();
  return r.changes;
}
