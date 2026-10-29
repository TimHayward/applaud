import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { addVoiceprint, deleteVoiceprint, VOICEPRINT_CAP } from "./library.js";
import { deletePerson, labelsToReview, listPeople, listVoiceprints, mergePeople, renamePerson } from "./people.js";

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

afterEach(() => {
  teardownTestDb(db);
});

function person(id: number, name: string, owner = false): void {
  db.prepare("INSERT INTO speakers (id, name, is_owner, created_at, updated_at) VALUES (?, ?, ?, 0, 0)").run(
    id,
    name,
    owner ? 1 : 0,
  );
}

/** A voiceprint orthogonal-ish to the others so near-duplicate skipping doesn't interfere. */
function voiceprint(speakerId: number, recordingId: string, plaudLabel: string, axis: number, now = 0): void {
  const v = new Float32Array(32);
  v[axis] = 1;
  addVoiceprint(
    { speakerId, recordingId, plaudLabel, segmentKeys: ["k"], vector: v, modelId: "m", speechMs: 30_000, source: "confirmed" },
    20_000,
    now,
  );
}

function label(recordingId: string, plaudLabel: string, speakerId: number | null, status: string): void {
  db.prepare(
    `INSERT INTO recording_speakers (recording_id, plaud_label, speaker_id, status, assigned_by, updated_at)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(recordingId, plaudLabel, speakerId, status, status === "confirmed" ? "user" : null);
}

describe("people", () => {
  it("lists people with their counts, owner first", () => {
    person(1, "Zoe", true);
    person(2, "ann");
    voiceprint(2, "r1", "S1", 0);
    label("r1", "S1", 2, "confirmed");
    label("r2", "S1", 2, "auto");
    label("r3", "S1", 2, "suggested");
    expect(listPeople()).toEqual([
      { id: 1, name: "Zoe", isOwner: true, voiceprints: 0, recordings: 0, lowResemblance: 0 },
      { id: 2, name: "ann", isOwner: false, voiceprints: 1, recordings: 2, lowResemblance: 0 },
    ]);
  });

  it("renames, refusing clashes, placeholders and the owner", () => {
    person(1, "Tim", true);
    person(2, "Ann");
    person(3, "Bob");
    expect(renamePerson(2, " Annie  Lee ")).toEqual({ ok: true });
    expect(db.prepare("SELECT name FROM speakers WHERE id = 2").get()).toEqual({ name: "Annie Lee" });
    expect(renamePerson(2, "annie lee")).toEqual({ ok: true }); // same person, new case
    expect(renamePerson(2, "BOB")).toMatchObject({ ok: false, code: 409 });
    expect(renamePerson(2, "Speaker 3")).toMatchObject({ ok: false, code: 400 });
    expect(renamePerson(1, "Timothy")).toMatchObject({ ok: false, code: 409 });
    expect(renamePerson(9, "X")).toMatchObject({ ok: false, code: 404 });
  });

  it("merges labels, overrides and voiceprints into one person", () => {
    person(1, "Ann");
    person(2, "Annie");
    voiceprint(1, "r1", "S1", 0, 1);
    voiceprint(2, "r2", "S1", 1, 2);
    voiceprint(2, "r1", "S1", 2, 3); // same recording and label as Ann's: Ann's is kept
    label("r2", "S1", 2, "confirmed");
    db.prepare("INSERT INTO segment_overrides (recording_id, segment_key, speaker_id, updated_at) VALUES ('r3', 'k', 2, 0)").run();

    expect(mergePeople(2, 1)).toEqual({ ok: true });
    expect(db.prepare("SELECT id, name FROM speakers").all()).toEqual([{ id: 1, name: "Ann" }]);
    expect(db.prepare("SELECT recording_id, is_anchor FROM speaker_embeddings WHERE speaker_id = 1 ORDER BY id").all()).toEqual([
      { recording_id: "r1", is_anchor: 1 },
      { recording_id: "r2", is_anchor: 0 },
    ]);
    expect(db.prepare("SELECT speaker_id FROM recording_speakers").all()).toEqual([{ speaker_id: 1 }]);
    expect(db.prepare("SELECT speaker_id FROM segment_overrides").all()).toEqual([{ speaker_id: 1 }]);
  });

  it("keeps the cap after a merge, and never merges the owner away", () => {
    person(1, "Tim", true);
    person(2, "Ann");
    for (let i = 0; i < VOICEPRINT_CAP; i++) voiceprint(1, `a${i}`, "S1", i, i);
    for (let i = 0; i < 4; i++) voiceprint(2, `b${i}`, "S1", 16 + i, 100 + i);
    expect(mergePeople(1, 2)).toMatchObject({ ok: false, code: 409 });
    expect(mergePeople(2, 1)).toEqual({ ok: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM speaker_embeddings").get()).toEqual({ n: VOICEPRINT_CAP });
    expect(db.prepare("SELECT recording_id FROM speaker_embeddings WHERE is_anchor = 1").all()).toEqual([
      { recording_id: "a0" },
    ]);
    expect(mergePeople(1, 1)).toMatchObject({ code: 400 });
  });

  it("deletes a person, their voiceprints and overrides, and frees their labels", () => {
    person(1, "Tim", true);
    person(2, "Ann");
    voiceprint(2, "r1", "S1", 0);
    label("r1", "S1", 2, "confirmed");
    expect(deletePerson(1)).toMatchObject({ ok: false, code: 409 });
    expect(deletePerson(2)).toEqual({ ok: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM speaker_embeddings").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT status, speaker_id, assigned_by FROM recording_speakers").get()).toEqual({
      status: "unknown",
      speaker_id: null,
      assigned_by: null,
    });
  });

  it("lists and deletes voiceprints, promoting a new anchor", () => {
    person(1, "Ann");
    voiceprint(1, "r1", "S1", 0, 1);
    voiceprint(1, "r2", "S1", 1, 2);
    const prints = listVoiceprints(1);
    expect(prints.map((p) => [p.recordingId, p.isAnchor])).toEqual([
      ["r1", true],
      ["r2", false],
    ]);
    expect(deleteVoiceprint(prints[0]!.id)).toBe(1);
    expect(listVoiceprints(1).map((p) => [p.recordingId, p.isAnchor])).toEqual([["r2", true]]);
    expect(deleteVoiceprint(999)).toBeNull();
  });

  it("counts labels to review per recording, leaving out Trash", () => {
    db.prepare(
      `INSERT INTO recordings (id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number, folder, user_deleted_at)
       VALUES ('r1', 'f', 0, 1, 1, 1, 'S', 'f1', NULL), ('r2', 'f', 0, 1, 1, 1, 'S', 'f2', 5)`,
    ).run();
    label("r1", "S1", null, "unknown");
    label("r1", "S2", null, "suggested");
    label("r1", "S3", null, "ignored");
    label("r2", "S1", null, "unknown");
    expect(labelsToReview()).toEqual({ r1: 2 });
  });
});
