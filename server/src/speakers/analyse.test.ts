import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { FakeEmbedder } from "../test/fixtures/embedder.js";
import { analyseRecording, enrolOwner, observedPlaudNames, reembedRecording, recordingsWithStaleVoiceprints } from "./analyse.js";
import { fromBlob } from "./vectors.js";

let db: Database.Database;
let dir: string;
let embedder: FakeEmbedder;

const MIN_SPEECH = 20_000;

beforeEach(() => {
  db = setupTestDb();
  dir = mkdtempSync(path.join(os.tmpdir(), "applaud-analyse-"));
  embedder = new FakeEmbedder({ modelId: "m@1" });
});

afterEach(() => {
  teardownTestDb(db);
  rmSync(dir, { recursive: true, force: true });
});

interface Seg {
  uid: string;
  start: number;
  end: number;
  label: string;
  name?: string;
}

/** A downloaded recording: DB row, audio placeholder and transcript.json. */
function addRecording(id: string, segs: Seg[], over: { audio?: boolean } = {}): void {
  const folder = `2026-10-29_${id}`;
  mkdirSync(path.join(dir, folder), { recursive: true });
  writeFileSync(path.join(dir, folder, "audio.ogg"), "");
  writeFileSync(
    path.join(dir, folder, "transcript.json"),
    JSON.stringify(
      segs.map((s) => ({
        segment_uid: s.uid,
        start_time: s.start,
        end_time: s.end,
        content: "words",
        speaker: s.name ?? s.label,
        original_speaker: s.label,
      })),
    ),
  );
  db.prepare(
    `INSERT INTO recordings (id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number, folder,
       audio_filename, audio_downloaded_at, transcript_downloaded_at)
     VALUES (?, 'f', 0, 1, ?, 1, 'S', ?, 'audio.ogg', ?, 1)`,
  ).run(id, Math.max(...segs.map((s) => s.end)), folder, over.audio === false ? null : 1);
}

/** Five 5 s segments per label: 25 s of speech each. */
function conversation(owner = "Speaker 1"): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i < 5; i++) {
    segs.push({ uid: `a${i}`, start: i * 20_000, end: i * 20_000 + 5_000, label: "Speaker 1", name: owner });
    segs.push({ uid: `b${i}`, start: i * 20_000 + 10_000, end: i * 20_000 + 15_000, label: "Speaker 2" });
  }
  segs.push({ uid: "uu", start: 200_000, end: 205_000, label: "" });
  return segs;
}

const labels = (): Record<string, unknown>[] =>
  db
    .prepare(
      `SELECT plaud_label, plaud_name, status, speaker_id, assigned_by, speech_ms, segment_keys, model_id
       FROM recording_speakers ORDER BY recording_id, plaud_label`,
    )
    .all() as Record<string, unknown>[];

const ctx = (): { embedder: FakeEmbedder; recordingsDir: string; now: () => number } => ({
  embedder,
  recordingsDir: dir,
  now: () => 1_000,
});

describe("analyseRecording", () => {
  it("stores each label's centroid, speech and source segments, skipping missing speakers", async () => {
    addRecording("r1", conversation("Tim Hayward"));
    expect(await analyseRecording(ctx(), "r1")).toEqual({ done: true, labels: 2, modelId: "m@1" });
    expect(labels()).toEqual([
      {
        plaud_label: "Speaker 1",
        plaud_name: "Tim Hayward",
        status: "unknown",
        speaker_id: null,
        assigned_by: null,
        speech_ms: 25_000,
        segment_keys: JSON.stringify(["a0", "a1", "a2", "a3", "a4"]),
        model_id: "m@1",
      },
      expect.objectContaining({ plaud_label: "Speaker 2", plaud_name: "Speaker 2", speech_ms: 25_000 }),
    ]);
    const c = db.prepare("SELECT centroid FROM recording_speakers WHERE plaud_label = 'Speaker 1'").get() as {
      centroid: Buffer;
    };
    expect(fromBlob(c.centroid)).toHaveLength(embedder.dim);
    expect(db.prepare("SELECT speakers_processed_at FROM recordings").get()).toEqual({ speakers_processed_at: 1_000 });
    // One request for the recording; the UU segment was never embedded.
    expect(embedder.requests).toHaveLength(1);
    expect(embedder.requests[0]!.windows.map((w) => w.id)).not.toContain("uu");
    expect(embedder.requests[0]!.audioPath).toBe(path.join(dir, "2026-10-29_r1", "audio.ogg"));
  });

  it("waits for audio", async () => {
    addRecording("r1", conversation(), { audio: false });
    expect(await analyseRecording(ctx(), "r1")).toEqual({ done: false, reason: "audio or transcript not downloaded" });
    expect(embedder.requests).toHaveLength(0);
  });

  it("re-analysis keeps assignments and drops labels that disappeared unless confirmed", async () => {
    addRecording("r1", [
      ...conversation(),
      { uid: "c0", start: 300_000, end: 305_000, label: "Speaker 3" },
      { uid: "d0", start: 310_000, end: 315_000, label: "Speaker 4" },
    ]);
    await analyseRecording(ctx(), "r1");
    db.prepare("INSERT INTO speakers (id, name, created_at, updated_at) VALUES (7, 'Ann', 0, 0)").run();
    db.prepare("UPDATE recording_speakers SET status = 'confirmed', speaker_id = 7, assigned_by = 'user' WHERE plaud_label IN ('Speaker 2', 'Speaker 4')").run();

    // Plaud re-diarised: Speakers 3 and 4 are gone.
    writeFileSync(path.join(dir, "2026-10-29_r1", "transcript.json"), JSON.stringify(conversation().map((s) => ({
      segment_uid: s.uid, start_time: s.start, end_time: s.end, content: "", speaker: s.label, original_speaker: s.label,
    }))));
    await analyseRecording(ctx(), "r1");
    expect(labels().map((l) => [l.plaud_label, l.status, l.speaker_id])).toEqual([
      ["Speaker 1", "unknown", null],
      ["Speaker 2", "confirmed", 7],
      ["Speaker 4", "confirmed", 7],
    ]);
  });
});

describe("enrolOwner", () => {
  it("confirms the owner's labels and enrols voiceprints with enough speech", async () => {
    addRecording("r1", conversation("Tim Hayward"));
    addRecording("r2", conversation("Tim Hayward").map((s) => (s.label === "Speaker 1" ? { ...s, end: s.start + 2_000 } : s)));
    await analyseRecording(ctx(), "r1");
    await analyseRecording(ctx(), "r2");

    expect(enrolOwner("tim hayward", MIN_SPEECH, 2_000)).toBe(1); // r2's owner label has only 10 s
    expect(db.prepare("SELECT name, is_owner FROM speakers").all()).toEqual([{ name: "tim hayward", is_owner: 1 }]);
    const owner = labels().filter((l) => l.plaud_label === "Speaker 1");
    expect(owner.map((l) => [l.status, l.assigned_by])).toEqual([
      ["confirmed", "plaud_owner"],
      ["confirmed", "plaud_owner"],
    ]);
    expect(db.prepare("SELECT recording_id, source, is_anchor FROM speaker_embeddings").all()).toEqual([
      { recording_id: "r1", source: "plaud_owner", is_anchor: 1 },
    ]);
  });

  it("leaves labels the user assigned to someone else", async () => {
    addRecording("r1", conversation("Tim Hayward"));
    await analyseRecording(ctx(), "r1");
    db.prepare("INSERT INTO speakers (id, name, created_at, updated_at) VALUES (7, 'Ann', 0, 0)").run();
    db.prepare("UPDATE recording_speakers SET status = 'confirmed', speaker_id = 7, assigned_by = 'user'").run();
    expect(enrolOwner("Tim Hayward", MIN_SPEECH)).toBe(0);
    expect(labels().every((l) => l.speaker_id === 7)).toBe(true);
  });

  it("undoes owner labels when the owner name changes or is cleared", async () => {
    addRecording("r1", conversation("Tim Hayward"));
    await analyseRecording(ctx(), "r1");
    enrolOwner("Tim Hayward", MIN_SPEECH);
    expect(enrolOwner("Someone Else", MIN_SPEECH)).toBe(0);
    expect(labels().map((l) => [l.status, l.assigned_by])).toEqual([
      ["unknown", null],
      ["unknown", null],
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM speaker_embeddings").get()).toEqual({ n: 0 });

    enrolOwner("Tim Hayward", MIN_SPEECH);
    enrolOwner(null, MIN_SPEECH);
    expect(db.prepare("SELECT COUNT(*) AS n FROM speaker_embeddings").get()).toEqual({ n: 0 });
  });

  it("never treats a placeholder as the owner", async () => {
    addRecording("r1", conversation());
    await analyseRecording(ctx(), "r1");
    expect(enrolOwner("Speaker 1", MIN_SPEECH)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM speakers").get()).toEqual({ n: 0 });
  });
});

describe("reembedRecording", () => {
  it("re-embeds voiceprints from their source segments with the new model", async () => {
    addRecording("r1", conversation("Tim Hayward"));
    await analyseRecording(ctx(), "r1");
    enrolOwner("Tim Hayward", MIN_SPEECH);
    expect(recordingsWithStaleVoiceprints("m@2")).toEqual(["r1"]);

    embedder.modelId = "m@2";
    expect(await reembedRecording(ctx(), "r1")).toEqual({ done: true, labels: 1, modelId: "m@2" });
    expect(embedder.requests.at(-1)!.windows.map((w) => w.id)).toEqual(["a0", "a1", "a2", "a3", "a4"]);
    expect(db.prepare("SELECT model_id FROM speaker_embeddings").all()).toEqual([{ model_id: "m@2" }]);
    expect(recordingsWithStaleVoiceprints("m@2")).toEqual([]);
  });
});

describe("observedPlaudNames", () => {
  it("lists names Plaud tagged, not placeholders, by recordings", async () => {
    addRecording("r1", conversation("Tim Hayward"));
    addRecording("r2", conversation("Tim Hayward"));
    addRecording("r3", conversation("Jo"));
    for (const id of ["r1", "r2", "r3"]) await analyseRecording(ctx(), id);
    expect(observedPlaudNames()).toEqual([
      { name: "Tim Hayward", recordings: 2 },
      { name: "Jo", recordings: 1 },
    ]);
  });
});
