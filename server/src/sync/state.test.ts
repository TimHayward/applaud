import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { AppConfig, PlaudRawRecording } from "@applaud/shared";

// Hoisted mocks. Must be set up before importing state.ts.
const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
const fsMocks = vi.hoisted(() => ({
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));
vi.mock("../config.js", () => ({ loadConfig, updateConfig: vi.fn() }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, ...fsMocks };
});
vi.mock("./events.js", () => ({ emit: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  upsertFromPlaud,
  softDeleteRecording,
  purgeExpiredSoftDeletes,
  purgeSoftDeletedRecordingNow,
  isSyncIgnoredId,
  SOFT_DELETE_RETENTION_MS,
  resetDownloadStateForResync,
  setRecordingDisplayName,
  getRecordingById,
  findRecordingsNeedingWebhook,
  findRecordingsNeedingAssets,
  countPendingTranscripts,
  markWebhookFired,
  recordWebhookFailure,
  webhookRedriveDelayMs,
} from "./state.js";
import { WEBHOOK_REDRIVE_MAX_ATTEMPTS } from "../constants.js";
import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";

const baseConfig: AppConfig = {
  version: 1,
  setupComplete: true,
  token: "t",
  tokenExp: null,
  tokenEmail: null,
  plaudRegion: null,
  recordingsDir: "/test/recordings",
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  publicBaseUrl: null,
  lanToken: null,
  authMode: null,
  ut: null,
  utExp: null,
  urt: null,
  urtExp: null,
  plaudWorkspaceId: null,
  importPlaudDeleted: false,
};

function makePlaudItem(overrides: Partial<PlaudRawRecording> = {}): PlaudRawRecording {
  return {
    id: "abcdef0123456789",
    filename: "Standup",
    fullname: "Standup",
    filesize: 12345,
    file_md5: "deadbeef",
    start_time: Date.UTC(2026, 3, 11, 12, 0),
    end_time: Date.UTC(2026, 3, 11, 12, 1),
    duration: 60_000,
    version: 1,
    version_ms: 0,
    edit_time: 0,
    is_trash: false,
    is_trans: false,
    is_summary: true,
    serial_number: "S1",
    ...overrides,
  };
}

describe("upsertFromPlaud", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
    loadConfig.mockReset();
    loadConfig.mockReturnValue(baseConfig);
    fsMocks.renameSync.mockReset();
    fsMocks.rmSync.mockReset();
    fsMocks.existsSync.mockReset();
    fsMocks.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    teardownTestDb(db);
  });

  it("inserts a new recording with computed folder and a folder-relative audio name", () => {
    const out = upsertFromPlaud(makePlaudItem());
    expect(out.id).toBe("abcdef0123456789");
    expect(out.folder).toBe("2026-04-11_Standup__abcdef01");
    expect(out.filesizeBytes).toBe(12345);
    expect(out.isTrash).toBe(false);
    expect(out.plaudIsSummary).toBe(true);

    // Default (no filetype) keeps the historical audio.ogg name.
    expect(out.audioFilename).toBe("audio.ogg");

    // No absolute paths are persisted — only names relative to the folder.
    const row = db
      .prepare<[string], Record<string, unknown>>("SELECT * FROM recordings WHERE id = ?")
      .get("abcdef0123456789");
    expect(row?.audio_filename).toBe("audio.ogg");
    expect(JSON.stringify(row)).not.toContain("/test/recordings");
  });

  it("derives the audio filename from Plaud's filetype", () => {
    const out = upsertFromPlaud(makePlaudItem({ filetype: "mp3" }));
    expect(out.audioFilename).toBe("audio.mp3");
  });

  it("preserves the derived audio filename across a folder rename", () => {
    upsertFromPlaud(makePlaudItem({ filetype: "mp3" }));
    const renamed = upsertFromPlaud(makePlaudItem({ filename: "Standup renamed", filetype: "mp3" }));
    expect(renamed.audioFilename).toBe("audio.mp3");
    expect(renamed.folder).toBe("2026-04-11_Standup_renamed__abcdef01");
  });

  it("records Plaud's is_trans and only queues a transcript fetch once it is true", () => {
    upsertFromPlaud(makePlaudItem({ is_trans: false, is_summary: false }));
    db.prepare("UPDATE recordings SET audio_downloaded_at = 1 WHERE id = ?").run("abcdef0123456789");
    expect(getRecordingById("abcdef0123456789")?.plaudIsTrans).toBe(false);
    expect(findRecordingsNeedingAssets()).toEqual([]);
    expect(countPendingTranscripts()).toBe(0);

    upsertFromPlaud(makePlaudItem({ is_trans: true, is_summary: false }));
    expect(getRecordingById("abcdef0123456789")?.plaudIsTrans).toBe(true);
    expect(findRecordingsNeedingAssets().map((r) => r.id)).toEqual(["abcdef0123456789"]);
    expect(countPendingTranscripts()).toBe(1);
  });

  it("renames folder on disk + DB when filename changes (different sanitized output)", () => {
    upsertFromPlaud(makePlaudItem({ filename: "Standup" }));
    fsMocks.renameSync.mockClear();
    upsertFromPlaud(makePlaudItem({ filename: "Standup renamed" }));

    expect(fsMocks.renameSync).toHaveBeenCalledTimes(1);
    const [oldAbs, newAbs] = fsMocks.renameSync.mock.calls[0]!;
    expect(oldAbs).toContain("2026-04-11_Standup__abcdef01");
    expect(newAbs).toContain("2026-04-11_Standup_renamed__abcdef01");

    const row = db
      .prepare<[string], { folder: string; filename: string }>(
        "SELECT folder, filename FROM recordings WHERE id = ?",
      )
      .get("abcdef0123456789");
    expect(row?.folder).toBe("2026-04-11_Standup_renamed__abcdef01");
    expect(row?.filename).toBe("Standup renamed");
  });

  it("survives a folder-rename collision by updating the filename only (no throw)", () => {
    upsertFromPlaud(makePlaudItem({ filename: "Standup" }));
    fsMocks.renameSync.mockClear();
    // Simulate the target folder already existing: renameSync throws (as it does
    // on a real collision) instead of silently succeeding.
    fsMocks.renameSync.mockImplementationOnce(() => {
      throw new Error("EEXIST: file already exists");
    });

    // Must not throw — a throw here would re-fail the row on every poll.
    expect(() => upsertFromPlaud(makePlaudItem({ filename: "Standup renamed" }))).not.toThrow();

    const row = db
      .prepare<[string], { folder: string; filename: string }>(
        "SELECT folder, filename FROM recordings WHERE id = ?",
      )
      .get("abcdef0123456789");
    // Filename is updated, but the folder stays put (files remain where they are).
    expect(row?.filename).toBe("Standup renamed");
    expect(row?.folder).toBe("2026-04-11_Standup__abcdef01");
  });

  it("skips rename when filename change does not affect sanitized folder name", () => {
    upsertFromPlaud(makePlaudItem({ filename: "Stand:up" }));
    fsMocks.renameSync.mockClear();
    // Both "Stand:up" and "Stand|up" sanitize to "Stand_up" ÔÇö folder is unchanged.
    upsertFromPlaud(makePlaudItem({ filename: "Stand|up" }));
    expect(fsMocks.renameSync).not.toHaveBeenCalled();
    const row = db
      .prepare<[string], { filename: string }>("SELECT filename FROM recordings WHERE id = ?")
      .get("abcdef0123456789");
    expect(row?.filename).toBe("Stand|up");
  });

  it("flips is_trash and plaud_is_summary on subsequent upsert", () => {
    upsertFromPlaud(makePlaudItem({ is_trash: false, is_summary: true }));
    const after = upsertFromPlaud(makePlaudItem({ is_trash: true, is_summary: false }));
    expect(after.isTrash).toBe(true);
    expect(after.plaudIsSummary).toBe(false);
  });

  it("does not call renameSync when the on-disk folder is missing (existsSync false)", () => {
    upsertFromPlaud(makePlaudItem({ filename: "Original" }));
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.renameSync.mockClear();
    upsertFromPlaud(makePlaudItem({ filename: "New" }));
    // Folder didn't exist on disk ÔåÆ no rename. DB is still updated.
    expect(fsMocks.renameSync).not.toHaveBeenCalled();
    const row = db
      .prepare<[string], { folder: string }>("SELECT folder FROM recordings WHERE id = ?")
      .get("abcdef0123456789");
    expect(row?.folder).toBe("2026-04-11_New__abcdef01");
  });

  it("throws when recordingsDir is not configured", () => {
    loadConfig.mockReturnValue({ ...baseConfig, recordingsDir: null });
    expect(() => upsertFromPlaud(makePlaudItem())).toThrow(/recordingsDir/);
  });

  it("resetDownloadStateForResync clears transcript/summary flags but keeps audio flag", () => {
    upsertFromPlaud(makePlaudItem());
    db
      .prepare(
        `UPDATE recordings
         SET audio_downloaded_at = ?, transcript_downloaded_at = ?, summary_downloaded_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(111, 222, 333, "network failure", "abcdef0123456789");

    resetDownloadStateForResync("abcdef0123456789");

    const row = db
      .prepare<
        [string],
        {
          audio_downloaded_at: number | null;
          transcript_downloaded_at: number | null;
          summary_downloaded_at: number | null;
          last_error: string | null;
        }
      >(
        "SELECT audio_downloaded_at, transcript_downloaded_at, summary_downloaded_at, last_error FROM recordings WHERE id = ?",
      )
      .get("abcdef0123456789");

    expect(row?.audio_downloaded_at).toBe(111);
    expect(row?.transcript_downloaded_at).toBeNull();
    expect(row?.summary_downloaded_at).toBeNull();
    expect(row?.last_error).toBeNull();
  });

  it("resetDownloadStateForResync clears a local display-name override (source is authoritative on resync)", () => {
    upsertFromPlaud(makePlaudItem());
    setRecordingDisplayName("abcdef0123456789", "My Custom Title");
    expect(getRecordingById("abcdef0123456789")?.displayName).toBe("My Custom Title");

    resetDownloadStateForResync("abcdef0123456789");

    expect(getRecordingById("abcdef0123456789")?.displayName).toBeNull();
  });

  it("setRecordingDisplayName trims whitespace and treats empty/whitespace-only as clearing", () => {
    upsertFromPlaud(makePlaudItem());
    setRecordingDisplayName("abcdef0123456789", "  Padded Title  ");
    expect(getRecordingById("abcdef0123456789")?.displayName).toBe("Padded Title");

    setRecordingDisplayName("abcdef0123456789", "   ");
    expect(getRecordingById("abcdef0123456789")?.displayName).toBeNull();
  });
});

describe("webhook re-delivery queue", () => {
  let db: Database.Database;
  const NOW = Date.UTC(2026, 9, 13, 12, 0);
  const ID = "abcdef0123456789";

  const markDownloaded = (id: string, at: number, transcript = true): void => {
    db.prepare(
      "UPDATE recordings SET audio_downloaded_at = ?, transcript_downloaded_at = ? WHERE id = ?",
    ).run(at, transcript ? at : null, id);
  };
  const due = (cutoff = 0, now = NOW, limit = 100) =>
    findRecordingsNeedingWebhook({ cutoff, now, limit }).map((d) => `${d.row.id}:${d.event}`);

  beforeEach(() => {
    db = setupTestDb();
    loadConfig.mockReset();
    loadConfig.mockReturnValue(baseConfig);
  });

  afterEach(() => {
    teardownTestDb(db);
  });

  it("returns both events for a downloaded, never-delivered recording", () => {
    upsertFromPlaud(makePlaudItem());
    markDownloaded(ID, NOW - 1000);
    expect(due()).toEqual([`${ID}:audio_ready`, `${ID}:transcript_ready`]);
  });

  it("skips assets downloaded before the webhook was enabled (no first-enable flood)", () => {
    upsertFromPlaud(makePlaudItem());
    markDownloaded(ID, NOW - 60_000);
    expect(due(NOW - 1000)).toEqual([]);
  });

  it("re-drives a transcript that landed after enablement even if the audio predates it", () => {
    upsertFromPlaud(makePlaudItem());
    db.prepare(
      "UPDATE recordings SET audio_downloaded_at = ?, transcript_downloaded_at = ? WHERE id = ?",
    ).run(NOW - 60_000, NOW - 10, ID);
    expect(due(NOW - 1000)).toEqual([`${ID}:transcript_ready`]);
  });

  it("recordWebhookFailure backs the event off until next_at, then it is due again", () => {
    upsertFromPlaud(makePlaudItem());
    markDownloaded(ID, NOW - 1000);
    recordWebhookFailure(ID, "audio_ready", NOW);
    expect(due()).toEqual([`${ID}:transcript_ready`]);
    expect(due(0, NOW + webhookRedriveDelayMs(1))).toEqual([`${ID}:audio_ready`, `${ID}:transcript_ready`]);
  });

  it("back-off grows with each failure and is capped", () => {
    expect(webhookRedriveDelayMs(2)).toBe(webhookRedriveDelayMs(1) * 3);
    expect(webhookRedriveDelayMs(50)).toBe(webhookRedriveDelayMs(51));
  });

  it("stops re-driving after the attempt cap", () => {
    upsertFromPlaud(makePlaudItem());
    markDownloaded(ID, NOW - 1000, false);
    for (let i = 0; i < WEBHOOK_REDRIVE_MAX_ATTEMPTS; i++) recordWebhookFailure(ID, "audio_ready", NOW);
    expect(due(0, NOW + 365 * 24 * 60 * 60 * 1000)).toEqual([]);
  });

  it("markWebhookFired removes the event and clears its back-off", () => {
    upsertFromPlaud(makePlaudItem());
    markDownloaded(ID, NOW - 1000, false);
    recordWebhookFailure(ID, "audio_ready", NOW);
    markWebhookFired(ID, "audio_ready");
    const row = db
      .prepare<[string], { attempts: number; next_at: number | null }>(
        "SELECT webhook_audio_attempts AS attempts, webhook_audio_next_at AS next_at FROM recordings WHERE id = ?",
      )
      .get(ID);
    expect(row).toEqual({ attempts: 0, next_at: null });
    expect(due()).toEqual([]);
  });

  it("caps the number of events returned per call", () => {
    for (let i = 0; i < 5; i++) {
      const id = `rec${i}000000000000`;
      upsertFromPlaud(makePlaudItem({ id, filename: `R${i}` }));
      markDownloaded(id, NOW - 1000);
    }
    expect(due(0, NOW, 3)).toHaveLength(3);
  });
});

describe("softDeleteRecording ÔåÆ purge flow", () => {
  let db: Database.Database;
  const NOW = Date.UTC(2026, 3, 28, 12, 0);

  beforeEach(() => {
    db = setupTestDb();
    loadConfig.mockReset();
    loadConfig.mockReturnValue(baseConfig);
    fsMocks.renameSync.mockReset();
    fsMocks.rmSync.mockReset();
    fsMocks.existsSync.mockReset();
    fsMocks.existsSync.mockReturnValue(true);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    teardownTestDb(db);
  });

  it("softDeleteRecording stamps user_deleted_at and user_purge_at = now + retention", () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording("abcdef0123456789");
    const row = db
      .prepare<[string], { user_deleted_at: number; user_purge_at: number }>(
        "SELECT user_deleted_at, user_purge_at FROM recordings WHERE id = ?",
      )
      .get("abcdef0123456789");
    expect(row?.user_deleted_at).toBe(NOW);
    expect(row?.user_purge_at).toBe(NOW + SOFT_DELETE_RETENTION_MS);
  });

  it("purgeExpiredSoftDeletes leaves rows alone before retention has elapsed", () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording("abcdef0123456789");
    // Advance just shy of the retention window.
    vi.setSystemTime(NOW + SOFT_DELETE_RETENTION_MS - 1);
    purgeExpiredSoftDeletes();
    expect(fsMocks.rmSync).not.toHaveBeenCalled();
    const row = db.prepare("SELECT id FROM recordings WHERE id = ?").get("abcdef0123456789");
    expect(row).toBeDefined();
  });

  it("purgeExpiredSoftDeletes removes files, inserts sync_ignore, and deletes the row after retention", () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording("abcdef0123456789");
    vi.setSystemTime(NOW + SOFT_DELETE_RETENTION_MS + 1);
    purgeExpiredSoftDeletes();

    expect(fsMocks.rmSync).toHaveBeenCalledTimes(1);
    expect(fsMocks.rmSync.mock.calls[0]![0]).toContain("2026-04-11_Standup__abcdef01");
    expect(isSyncIgnoredId("abcdef0123456789")).toBe(true);
    const row = db.prepare("SELECT id FROM recordings WHERE id = ?").get("abcdef0123456789");
    expect(row).toBeUndefined();
  });

  it("purge keeps the DB row when disk removal fails (no orphan-on-disk)", () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording("abcdef0123456789");
    fsMocks.rmSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    vi.setSystemTime(NOW + SOFT_DELETE_RETENTION_MS + 1);
    purgeExpiredSoftDeletes();

    // Row still present, sync_ignore NOT inserted, last_error captured.
    const row = db
      .prepare<[string], { id: string; last_error: string | null }>(
        "SELECT id, last_error FROM recordings WHERE id = ?",
      )
      .get("abcdef0123456789");
    expect(row).toBeDefined();
    expect(row?.last_error).toContain("Purge failed");
    expect(isSyncIgnoredId("abcdef0123456789")).toBe(false);
  });

  it("purgeSoftDeletedRecordingNow returns 'not_found' for unknown id", () => {
    expect(purgeSoftDeletedRecordingNow("missing-id")).toBe("not_found");
  });

  it("purgeSoftDeletedRecordingNow returns 'not_in_trash' when row was never soft-deleted", () => {
    upsertFromPlaud(makePlaudItem());
    expect(purgeSoftDeletedRecordingNow("abcdef0123456789")).toBe("not_in_trash");
  });

  it("purgeSoftDeletedRecordingNow purges immediately regardless of retention window", () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording("abcdef0123456789");
    // No time advance ÔÇö should still succeed.
    expect(purgeSoftDeletedRecordingNow("abcdef0123456789")).toBe("ok");
    expect(fsMocks.rmSync).toHaveBeenCalledTimes(1);
    expect(isSyncIgnoredId("abcdef0123456789")).toBe(true);
  });
});
