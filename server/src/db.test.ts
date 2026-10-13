import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations, SCHEMA_VERSION } from "./db.js";

const userVersion = (d: Database.Database): number => d.pragma("user_version", { simple: true }) as number;
const columns = (d: Database.Database): string[] =>
  (d.prepare("PRAGMA table_info(recordings)").all() as { name: string }[]).map((c) => c.name);

/**
 * A database as the pre-versioning code left it: `user_version` 0, absolute
 * file paths, and only some of the later columns (old installs could be at any
 * point in that history).
 */
function legacyDb(): Database.Database {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE recordings (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL, duration_ms INTEGER NOT NULL, filesize_bytes INTEGER NOT NULL,
      serial_number TEXT NOT NULL, folder TEXT NOT NULL, audio_path TEXT, transcript_path TEXT,
      summary_path TEXT, metadata_path TEXT, audio_downloaded_at INTEGER,
      transcript_downloaded_at INTEGER, webhook_audio_fired_at INTEGER,
      webhook_transcript_fired_at INTEGER, last_error TEXT, metadata_json TEXT,
      is_trash INTEGER NOT NULL DEFAULT 0, display_name TEXT
    );
    CREATE TABLE webhook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recording_id TEXT, event TEXT NOT NULL,
      url TEXT NOT NULL, status_code INTEGER, response_snippet TEXT, fired_at INTEGER NOT NULL,
      duration_ms INTEGER, error TEXT
    );
  `);
  const insert = d.prepare(
    `INSERT INTO recordings (id, filename, start_time, end_time, duration_ms, filesize_bytes,
       serial_number, folder, audio_path, transcript_path, summary_path, metadata_path, display_name)
     VALUES (?, 'x', 1, 2, 1, 1, 'S', ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    "posix",
    "2026-04-11_A__posix000",
    "/old/root/2026-04-11_A__posix000/audio.mp3",
    "/old/root/2026-04-11_A__posix000/transcript.json",
    "/old/root/2026-04-11_A__posix000/summary.md",
    "/old/root/2026-04-11_A__posix000/metadata.json",
    "Kept title",
  );
  insert.run(
    "windows",
    "2026-04-11_B__windows0",
    "C:\\Recordings\\2026-04-11_B__windows0\\audio.m4a",
    null,
    null,
    null,
    null,
  );
  insert.run("noaudio", "2026-04-11_C__noaudio0", null, null, null, null, null);
  return d;
}

describe("database migrations", () => {
  it("brings a fresh database to the current schema version", () => {
    const d = new Database(":memory:");
    runMigrations(d);
    expect(userVersion(d)).toBe(SCHEMA_VERSION);
    const cols = columns(d);
    expect(cols).toEqual(expect.arrayContaining(["audio_filename", "plaud_is_trans", "webhook_audio_attempts"]));
    expect(cols).not.toContain("audio_path");
    expect(cols).not.toContain("transcript_path");
  });

  it("is a no-op when run again", () => {
    const d = new Database(":memory:");
    runMigrations(d);
    const before = columns(d);
    expect(() => runMigrations(d)).not.toThrow();
    expect(columns(d)).toEqual(before);
    expect(userVersion(d)).toBe(SCHEMA_VERSION);
  });

  it("upgrades a pre-versioning database, keeping data and relativising paths", () => {
    const d = legacyDb();
    runMigrations(d);
    expect(userVersion(d)).toBe(SCHEMA_VERSION);

    const rows = d
      .prepare("SELECT id, audio_filename, display_name, plaud_is_trans, is_starred FROM recordings ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "noaudio", audio_filename: null, display_name: null, plaud_is_trans: 1, is_starred: 0 },
      { id: "posix", audio_filename: "audio.mp3", display_name: "Kept title", plaud_is_trans: 1, is_starred: 0 },
      // Split on both separators: a DB written on Windows, read on Linux.
      { id: "windows", audio_filename: "audio.m4a", display_name: null, plaud_is_trans: 1, is_starred: 0 },
    ]);
    const cols = columns(d);
    for (const gone of ["audio_path", "transcript_path", "summary_path", "metadata_path"]) {
      expect(cols).not.toContain(gone);
    }
    expect(JSON.stringify(d.prepare("SELECT * FROM recordings").all())).not.toMatch(/Recordings|old\/root/);
  });

  it("surfaces a failed migration and rolls it back instead of swallowing it", () => {
    const d = new Database(":memory:");
    runMigrations(d);
    // Pretend v3 never ran, but its source column is already gone: v3 must
    // fail loudly rather than leave a half-migrated schema behind.
    d.pragma("user_version = 2");
    expect(() => runMigrations(d)).toThrow(/database migration 3 \(folder-relative file paths\) failed/);
    expect(userVersion(d)).toBe(2);
  });

  it("leaves a database from a newer version alone", () => {
    const d = new Database(":memory:");
    runMigrations(d);
    d.pragma("user_version = 999");
    expect(() => runMigrations(d)).not.toThrow();
    expect(userVersion(d)).toBe(999);
  });
});
