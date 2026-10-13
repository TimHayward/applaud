import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ensureConfigDir, dbPath } from "./paths.js";
import { logger } from "./logger.js";
import { DEFAULT_AUDIO_FILENAME } from "./sync/layout.js";
import type { RecordingRow, RecordingStatus } from "@applaud/shared";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  ensureConfigDir();
  try {
    db = new Database(dbPath());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Could not locate the bindings file")) {
      throw new Error(
        `${message} — native SQLite bindings are missing or were not built. ` +
        `Run \`pnpm install\` from the repository root, then restart the server.`,
      );
    }
    throw err;
  }
  db.pragma("journal_mode = WAL");
  // Wait for a competing writer (another process on the same volume, or a
  // checkpoint) instead of failing immediately with SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * Test-only: replace the cached DB handle (for in-memory test fixtures).
 * @internal never call from production code paths.
 */
export function setDbForTests(handle: Database.Database | null): void {
  db = handle;
}

/** Apply schema migrations against any DB handle. Exported for tests. */
export function runMigrations(d: Database.Database): void {
  migrate(d);
}

interface Migration {
  version: number;
  name: string;
  up: (d: Database.Database) => void;
}

/**
 * Ordered schema migrations, gated on `PRAGMA user_version`. Each runs once,
 * inside a transaction together with its version bump, so a failure (locked
 * DB, disk full) rolls back cleanly and stops startup with a clear error
 * instead of surfacing later as "no such column". To change the schema,
 * append a migration — never edit one that has shipped.
 */
const MIGRATIONS: Migration[] = [
  { version: 1, name: "baseline schema (pre-versioning history)", up: migrateBaseline },
  {
    version: 2,
    name: "persist Plaud is_trans",
    // Default 1 keeps existing rows eligible for transcript fetches until the
    // next list walk (the first phase of every poll) records the real value.
    up: (d) => addColumn(d, "recordings", "plaud_is_trans", "INTEGER NOT NULL DEFAULT 1"),
  },
  { version: 3, name: "folder-relative file paths", up: migrateRelativePaths },
];

/** Schema version this build writes. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

function migrate(d: Database.Database): void {
  const current = d.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    logger.warn(
      { dbVersion: current, supported: SCHEMA_VERSION },
      "database was written by a newer Applaud — running without migrating; downgrades are not supported",
    );
    return;
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    try {
      d.transaction(() => {
        m.up(d);
        d.pragma(`user_version = ${m.version}`);
      })();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`database migration ${m.version} (${m.name}) failed: ${message}`, { cause: err });
    }
    if (current > 0 || m.version > 1) logger.info({ version: m.version, name: m.name }, "applied database migration");
  }
}

/** `ALTER TABLE … ADD COLUMN` only when the column is missing — no blanket catch. */
function addColumn(d: Database.Database, table: string, column: string, definition: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * v3: the DB used to store absolute paths (audio/transcript/summary/metadata)
 * under whatever `recordingsDir` was set at insert time, so moving the library
 * or changing the mount path broke every row. Keep only the audio filename
 * (its extension varies per recording); everything else is derived from
 * `recordingsDir` + `folder` at use time (see `sync/layout.ts`).
 */
function migrateRelativePaths(d: Database.Database): void {
  addColumn(d, "recordings", "audio_filename", "TEXT");
  const rows = d.prepare("SELECT id, audio_path FROM recordings").all() as {
    id: string;
    audio_path: string | null;
  }[];
  const update = d.prepare("UPDATE recordings SET audio_filename = ? WHERE id = ?");
  for (const row of rows) {
    // Split on both separators: the DB may have been written on another OS.
    const name = row.audio_path?.split(/[\\/]/).pop() || null;
    update.run(name, row.id);
  }
  for (const col of ["audio_path", "transcript_path", "summary_path", "metadata_path"]) {
    d.exec(`ALTER TABLE recordings DROP COLUMN ${col}`);
  }
}

/**
 * v1: every schema change made before migrations were versioned. Idempotent
 * (`addColumn` checks first), because pre-versioning databases are at
 * `user_version` 0 with any subset of these already applied.
 */
function migrateBaseline(d: Database.Database): void {
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

  // Plaud trash flag.
  addColumn(d, "recordings", "is_trash", "INTEGER NOT NULL DEFAULT 0");

  // Transcript text for search.
  addColumn(d, "recordings", "transcript_text", "TEXT");

  // summary_downloaded_at: the dashboard previously used `summary_path` as a
  // "has summary" signal, but that field was set speculatively at insert time
  // — so it lit up the pill even for recordings where Plaud never produced a
  // summary. This timestamp is only set when summary.md is actually written.
  addColumn(d, "recordings", "summary_downloaded_at", "INTEGER");

  // Backfill summary_downloaded_at for existing rows: if the summary.md file
  // is on disk, use transcript_downloaded_at as the timestamp (best proxy we
  // have since the two were written together).
  const summaryBackfill = d
    .prepare(
      "SELECT id, summary_path, transcript_downloaded_at FROM recordings WHERE transcript_downloaded_at IS NOT NULL AND summary_downloaded_at IS NULL",
    )
    .all() as { id: string; summary_path: string | null; transcript_downloaded_at: number }[];
  if (summaryBackfill.length > 0) {
    const update = d.prepare("UPDATE recordings SET summary_downloaded_at = ? WHERE id = ?");
    for (const row of summaryBackfill) {
      if (!row.summary_path) continue;
      try {
        if (existsSync(row.summary_path)) {
          update.run(row.transcript_downloaded_at, row.id);
        }
      } catch {
        /* best effort */
      }
    }
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

  d.exec(`
    CREATE TABLE IF NOT EXISTS sync_ignore (
      id TEXT PRIMARY KEY,
      ignored_at INTEGER NOT NULL
    );
  `);

  addColumn(d, "recordings", "user_deleted_at", "INTEGER");
  addColumn(d, "recordings", "user_purge_at", "INTEGER");
  addColumn(d, "recordings", "plaud_is_summary", "INTEGER NOT NULL DEFAULT 0");
  // Rows that already have summary.md on disk should not show as "missing summary"
  // until the next Plaud sync; align plaud_is_summary with summary_downloaded_at.
  d.exec(
    "UPDATE recordings SET plaud_is_summary = 1 WHERE summary_downloaded_at IS NOT NULL",
  );
  addColumn(d, "recordings", "trash_asset_probe_at", "INTEGER");
  // Plaud's is_markmemo (starred/favorite) and filetag_id_list (JSON array of
  // tag ids) so the UI can show favorites and filter by them.
  addColumn(d, "recordings", "is_starred", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "recordings", "plaud_tags", "TEXT");
  // Local display-name override. NULL means "use Plaud's filename" (the
  // default). Resyncing a recording clears this — the source is authoritative.
  addColumn(d, "recordings", "display_name", "TEXT");
  // Per-event webhook re-delivery back-off (poller Phase 2b). Attempts count
  // failed deliveries; next_at is the earliest time to try again.
  for (const event of ["audio", "transcript"]) {
    addColumn(d, "recordings", `webhook_${event}_attempts`, "INTEGER NOT NULL DEFAULT 0");
    addColumn(d, "recordings", `webhook_${event}_next_at`, "INTEGER");
  }
}

function statusOf(row: RecordingDbRow): RecordingStatus {
  if (row.last_error) return "error";
  if (!row.audio_downloaded_at) return "pending_audio";
  if (!row.transcript_downloaded_at) return "audio_only";
  return "complete";
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
  /** Audio basename within `folder` (e.g. `audio.mp3`); NULL means the default. */
  audio_filename: string | null;
  audio_downloaded_at: number | null;
  transcript_downloaded_at: number | null;
  summary_downloaded_at: number | null;
  webhook_audio_fired_at: number | null;
  webhook_transcript_fired_at: number | null;
  webhook_audio_attempts: number;
  webhook_audio_next_at: number | null;
  webhook_transcript_attempts: number;
  webhook_transcript_next_at: number | null;
  is_trash: number;
  last_error: string | null;
  metadata_json: string | null;
  transcript_text: string | null;
  user_deleted_at: number | null;
  user_purge_at: number | null;
  plaud_is_summary: number;
  plaud_is_trans: number;
  trash_asset_probe_at: number | null;
  is_starred: number;
  plaud_tags: string | null;
  display_name: string | null;
}

function parseTagIds(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
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
    // Set per-recording from Plaud's filetype at insert. Absolute paths are
    // never stored: callers resolve recordingsDir + folder + name at use time.
    audioFilename: row.audio_filename ?? DEFAULT_AUDIO_FILENAME,
    audioDownloadedAt: row.audio_downloaded_at,
    transcriptDownloadedAt: row.transcript_downloaded_at,
    summaryDownloadedAt: row.summary_downloaded_at,
    webhookAudioFiredAt: row.webhook_audio_fired_at,
    webhookTranscriptFiredAt: row.webhook_transcript_fired_at,
    isTrash: row.is_trash === 1,
    lastError: row.last_error,
    status: statusOf(row),
    userDeletedAt: row.user_deleted_at ?? null,
    userPurgeAt: row.user_purge_at ?? null,
    plaudIsSummary: (row.plaud_is_summary ?? 0) === 1,
    plaudIsTrans: (row.plaud_is_trans ?? 1) === 1,
    isStarred: (row.is_starred ?? 0) === 1,
    plaudTagIds: parseTagIds(row.plaud_tags),
    displayName: row.display_name ?? null,
  };
}

export type { RecordingDbRow };
