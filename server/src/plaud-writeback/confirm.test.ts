import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { confirmOutstanding, setConfirmationForTests } from "./confirm.js";

describe("confirmOutstanding", () => {
  let db: Database.Database;
  const confirmed: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    db = setupTestDb();
    confirmed.length = 0;
    setConfirmationForTests((id) => confirmed.push(id));
    const row = db.prepare(
      `INSERT INTO plaud_writeback (recording_id, pending_segments, changes, last_result, last_attempt_at, pending_transcript_at, updated_at)
       VALUES (?, ?, '[]', ?, ?, ?, 0)`,
    );
    row.run("sent_unconfirmed", 3, "sent", 1000, null); // sent before automatic confirmation
    row.run("sent_counted_before", 3, "sent", 1000, 900); // counted from an older download
    row.run("sent_recounted", 3, "sent", 1000, 2000); // already re-read: Plaud didn't take it
    row.run("in_plaud", 0, "sent", 1000, 2000);
    row.run("never_sent", 3, null, null, 500);
  });

  afterEach(() => {
    teardownTestDb(db);
    vi.useRealTimers();
  });

  it("re-reads only sends not yet counted from a later download, spaced out", () => {
    expect(confirmOutstanding()).toBe(2);
    vi.advanceTimersByTime(0);
    expect(confirmed).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(confirmed.sort()).toEqual(["sent_counted_before", "sent_unconfirmed"]);
  });
});
