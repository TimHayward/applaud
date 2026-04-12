import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ensureConfigDir, dbPath } from "./paths.js";
import type { RecordingRow, RecordingStatus } from "@applaud/shared";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  ensureConfigDir();
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      filesize_bytes INTEGER NOT NULL,
      serial_number TEXT NOT NULL,
      folder TEXT NOT NULL,
      audio_path TEXT,
      transcript_path TEXT,
      summary_path TEXT,
      metadata_path TEXT,
      audio_downloaded_at INTEGER,
      transcript_downloaded_at INTEGER,
      webhook_audio_fired_at INTEGER,
      webhook_transcript_fired_at INTEGER,
      is_historical INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recordings_start_time ON recordings(start_time DESC);

    CREATE TABLE IF NOT EXISTS webhook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT,
      event TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER,
      response_snippet TEXT,
      fired_at INTEGER NOT NULL,
      duration_ms INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_log_fired_at ON webhook_log(fired_at DESC);
  `);

  // v2: add is_trash column
  try {
    d.exec("ALTER TABLE recordings ADD COLUMN is_trash INTEGER NOT NULL DEFAULT 0");
  } catch {
    // column already exists — ignore
  }

  // v3: add transcript_text column for full-text search
  try {
    d.exec("ALTER TABLE recordings ADD COLUMN transcript_text TEXT");
  } catch {
    // column already exists — ignore
  }

  // Backfill transcript_text from existing transcript.txt files on disk
  const pending = d
    .prepare("SELECT id, transcript_path FROM recordings WHERE transcript_downloaded_at IS NOT NULL AND transcript_text IS NULL")
    .all() as { id: string; transcript_path: string | null }[];
  if (pending.length > 0) {
    const update = d.prepare("UPDATE recordings SET transcript_text = ? WHERE id = ?");
    for (const row of pending) {
      if (!row.transcript_path) continue;
      const txtPath = path.join(path.dirname(row.transcript_path), "transcript.txt");
      try {
        if (existsSync(txtPath)) {
          update.run(readFileSync(txtPath, "utf8"), row.id);
        }
      } catch {
        /* best effort */
      }
    }
  }
}

interface RecordingDbRow {
  id: string;
  filename: string;
  start_time: number;
  end_time: number;
  duration_ms: number;
  filesize_bytes: number;
  serial_number: string;
  folder: string;
  audio_path: string | null;
  transcript_path: string | null;
  summary_path: string | null;
  metadata_path: string | null;
  audio_downloaded_at: number | null;
  transcript_downloaded_at: number | null;
  webhook_audio_fired_at: number | null;
  webhook_transcript_fired_at: number | null;
  is_trash: number;
  is_historical: number;
  last_error: string | null;
  metadata_json: string | null;
  transcript_text: string | null;
}

function statusOf(row: RecordingDbRow): RecordingStatus {
  if (row.is_historical && !row.audio_downloaded_at) return "historical";
  if (!row.audio_downloaded_at) return "pending_audio";
  if (row.last_error) return "error";
  if (!row.transcript_downloaded_at) return "pending_transcript";
  return "complete";
}

export function rowToRecording(row: RecordingDbRow): RecordingRow {
  return {
    id: row.id,
    filename: row.filename,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMs: row.duration_ms,
    filesizeBytes: row.filesize_bytes,
    serialNumber: row.serial_number,
    folder: row.folder,
    audioPath: row.audio_path,
    transcriptPath: row.transcript_path,
    summaryPath: row.summary_path,
    metadataPath: row.metadata_path,
    audioDownloadedAt: row.audio_downloaded_at,
    transcriptDownloadedAt: row.transcript_downloaded_at,
    webhookAudioFiredAt: row.webhook_audio_fired_at,
    webhookTranscriptFiredAt: row.webhook_transcript_fired_at,
    isTrash: row.is_trash === 1,
    isHistorical: row.is_historical === 1,
    lastError: row.last_error,
    status: statusOf(row),
  };
}

export type { RecordingDbRow };
