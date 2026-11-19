import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SpeakerFilter } from "@applaud/shared";

vi.mock("../config.js", () => ({ loadConfig: vi.fn(() => ({})), updateConfig: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { listRecordingRows } from "./state.js";

describe("listRecordingRows speaker filter", () => {
  let db: Database.Database;
  let start = 0;

  /** A recording with these label statuses, and Plaud still missing `pending` names. */
  const recording = (
    id: string,
    labels: string[],
    opts: { pending?: number; processed?: boolean; transcript?: boolean; trash?: boolean } = {},
  ): void => {
    db.prepare(
      `INSERT INTO recordings (id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number, folder,
         audio_filename, audio_downloaded_at, transcript_downloaded_at, speakers_processed_at, is_trash)
       VALUES (?, ?, ?, ?, 1000, 1, 'S', ?, 'audio.ogg', 1, ?, ?, ?)`,
    ).run(
      id,
      id,
      ++start,
      start + 1,
      id,
      opts.transcript === false ? null : 1,
      opts.processed === false ? null : 1,
      opts.trash ? 1 : 0,
    );
    labels.forEach((status, i) =>
      db
        .prepare(
          `INSERT INTO recording_speakers (recording_id, plaud_label, status, updated_at) VALUES (?, ?, ?, 0)`,
        )
        .run(id, `Speaker ${i + 1}`, status),
    );
    if (opts.pending != null) {
      db.prepare(
        `INSERT INTO plaud_writeback (recording_id, pending_segments, changes, updated_at) VALUES (?, ?, '[]', 0)`,
      ).run(id, opts.pending);
    }
  };

  const ids = (filter: SpeakerFilter, sendToPlaud = true): string[] =>
    listRecordingRows({ sort: "date_asc", speakers: { filter, sendToPlaud } }).items.map(
      (r) => r.id,
    );

  beforeEach(() => {
    db = setupTestDb();
    start = 0;
    recording("label", ["unknown", "auto", "confirmed"], { pending: 2 });
    recording("suggested", ["suggested"]);
    recording("confirm", ["auto", "confirmed"], { pending: 1 });
    recording("sync", ["confirmed", "ignored"], { pending: 3 });
    recording("synced", ["confirmed"], { pending: 0 });
    recording("synced-no-row", ["confirmed", "ignored"]);
    recording("ignored-only", ["ignored"]);
    recording("unanalysed", [], { processed: false });
    recording("no-transcript", [], { processed: false, transcript: false });
    recording("trashed", ["unknown"], { trash: true });
  });

  afterEach(() => {
    teardownTestDb(db);
  });

  it("matches the most urgent state each recording is in", () => {
    expect(ids("label")).toEqual(["label", "suggested"]);
    expect(ids("confirm")).toEqual(["confirm"]);
    expect(ids("sync")).toEqual(["sync"]);
    expect(ids("synced")).toEqual(["synced", "synced-no-row"]);
    expect(ids("unanalysed")).toEqual(["unanalysed"]);
  });

  it("counts confirmed names as synced while sending to Plaud is off", () => {
    expect(ids("sync", false)).toEqual([]);
    expect(ids("synced", false)).toEqual(["sync", "synced", "synced-no-row"]);
  });

  it("reports the filtered total", () => {
    const out = listRecordingRows({ limit: 1, speakers: { filter: "label", sendToPlaud: true } });
    expect(out.total).toBe(2);
    expect(out.items).toHaveLength(1);
  });
});
