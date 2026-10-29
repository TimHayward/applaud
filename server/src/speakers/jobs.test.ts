import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import {
  claimNextJob,
  completeJob,
  enqueueBackfill,
  enqueueJob,
  failJob,
  jobCounts,
  MAX_ATTEMPTS,
  nextDueAt,
  requeueRunning,
} from "./jobs.js";

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});
afterEach(() => teardownTestDb(db));

function insertRecording(id: string, over: Record<string, unknown> = {}): void {
  const row = {
    audio_downloaded_at: 1,
    transcript_downloaded_at: 1,
    speakers_processed_at: null,
    user_deleted_at: null,
    is_trash: 0,
    ...over,
  };
  db.prepare(
    `INSERT INTO recordings (id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number, folder,
       audio_downloaded_at, transcript_downloaded_at, speakers_processed_at, user_deleted_at, is_trash)
     VALUES (?, 'f', 0, 1, 1, 1, 'S', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    row.audio_downloaded_at,
    row.transcript_downloaded_at,
    row.speakers_processed_at,
    row.user_deleted_at,
    row.is_trash,
  );
}

const status = (recordingId: string): unknown =>
  db.prepare("SELECT status, attempts, next_attempt_at, last_error FROM speaker_jobs WHERE recording_id = ?").get(recordingId);

describe("speaker jobs", () => {
  it("claims queued jobs oldest first, re-embedding before analysis", () => {
    enqueueJob("analyse", "a", 100);
    enqueueJob("analyse", "b", 200);
    enqueueJob("reembed", "c", 300);
    expect(claimNextJob(1000)?.recordingId).toBe("c");
    expect(claimNextJob(1000)?.recordingId).toBe("a");
    expect(claimNextJob(1000)?.recordingId).toBe("b");
    expect(claimNextJob(1000)).toBeNull();
  });

  it("de-duplicates on kind and recording, re-queueing from scratch", () => {
    enqueueJob("analyse", "a", 100);
    const job = claimNextJob(100)!;
    failJob(job, "boom", {}, 100);
    enqueueJob("analyse", "a", 200);
    expect(status("a")).toEqual({ status: "queued", attempts: 0, next_attempt_at: 200, last_error: null });
    expect(jobCounts()).toEqual({ queued: 1, failed: 0 });
  });

  it("backs off after a failure, and gives up after the last attempt", () => {
    enqueueJob("analyse", "a", 0);
    let now = 0;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const job = claimNextJob(now)!;
      failJob(job, `fail ${i}`, {}, now);
      const s = status("a") as { status: string; next_attempt_at: number };
      expect(s.status).toBe("queued");
      expect(claimNextJob(now)).toBeNull(); // not due yet
      now = s.next_attempt_at;
    }
    failJob(claimNextJob(now)!, "last", {}, now);
    expect(status("a")).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, last_error: "last" });
    expect(jobCounts()).toEqual({ queued: 0, failed: 1 });
  });

  it("can re-queue without using up an attempt", () => {
    enqueueJob("analyse", "a", 0);
    failJob(claimNextJob(0)!, "host down", { countAttempt: false }, 0);
    expect(status("a")).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("completes a job", () => {
    enqueueJob("analyse", "a", 0);
    completeJob(claimNextJob(0)!);
    expect(status("a")).toMatchObject({ status: "done" });
    expect(nextDueAt()).toBeNull();
  });

  it("puts jobs left running back in the queue", () => {
    enqueueJob("analyse", "a", 0);
    claimNextJob(0);
    requeueRunning(50);
    expect(status("a")).toMatchObject({ status: "queued", next_attempt_at: 50 });
  });

  it("backfills only recordings with audio and a transcript, not yet analysed, not deleted", () => {
    insertRecording("ready");
    insertRecording("no-audio", { audio_downloaded_at: null });
    insertRecording("no-transcript", { transcript_downloaded_at: null });
    insertRecording("done", { speakers_processed_at: 5 });
    insertRecording("deleted", { user_deleted_at: 5 });
    insertRecording("trash", { is_trash: 1 });
    expect(enqueueBackfill(0)).toBe(1);
    expect(enqueueBackfill(0)).toBe(0); // already queued
    expect(claimNextJob(0)?.recordingId).toBe("ready");
  });
});
