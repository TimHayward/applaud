import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { labelCandidates, matchRecording, loadLibrary, rematchAll, setLabel, setSegmentSpeaker } from "./assign.js";
import { addVoiceprint, removeLabelVoiceprints } from "./library.js";
import type { MatchThresholds } from "./matcher.js";
import { toBlob } from "./vectors.js";

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

afterEach(() => {
  teardownTestDb(db);
});

const T: MatchThresholds = { autoThreshold: 0.75, autoMargin: 0.1, minSpeechMs: 20_000, suggestThreshold: 0.55 };
const MODEL = "m@1";
const A = new Float32Array([1, 0, 0]);
const B = new Float32Array([0, 1, 0]);
const C = new Float32Array([0, 0, 1]);

function person(id: number, name: string): void {
  db.prepare("INSERT INTO speakers (id, name, created_at, updated_at) VALUES (?, ?, 0, 0)").run(id, name);
}

function labelRow(
  recordingId: string,
  plaudLabel: string,
  vector: Float32Array,
  over: { status?: string; speakerId?: number | null; assignedBy?: string | null; modelId?: string; speechMs?: number } = {},
): void {
  db.prepare(
    `INSERT INTO recording_speakers
       (recording_id, plaud_label, plaud_name, speaker_id, status, assigned_by, speech_ms, segment_keys, centroid, model_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    recordingId,
    plaudLabel,
    plaudLabel,
    over.speakerId ?? null,
    over.status ?? "unknown",
    over.assignedBy ?? null,
    over.speechMs ?? 30_000,
    JSON.stringify([`${plaudLabel}-k1`]),
    toBlob(vector),
    over.modelId ?? MODEL,
  );
}

function voiceprint(speakerId: number, recordingId: string, plaudLabel: string, vector: Float32Array): void {
  addVoiceprint(
    { speakerId, recordingId, plaudLabel, segmentKeys: ["k"], vector, modelId: MODEL, speechMs: 30_000, source: "confirmed" },
    20_000,
  );
}

const row = (recordingId: string, plaudLabel: string): Record<string, unknown> =>
  db
    .prepare(
      "SELECT status, speaker_id, assigned_by FROM recording_speakers WHERE recording_id = ? AND plaud_label = ?",
    )
    .get(recordingId, plaudLabel) as Record<string, unknown>;

describe("matchRecording", () => {
  it("labels open labels and leaves decided ones alone", () => {
    person(1, "Ann");
    person(2, "Bob");
    voiceprint(1, "old", "S1", A);
    voiceprint(2, "old", "S2", B);
    labelRow("r1", "S1", A);
    labelRow("r1", "S2", B, { status: "confirmed", speakerId: 1, assignedBy: "user" });
    labelRow("r1", "S3", B, { status: "ignored", assignedBy: "user" });
    labelRow("r1", "S4", C);

    expect(matchRecording("r1", loadLibrary(MODEL), MODEL, T)).toBe(true);
    // Ann is confirmed on S2 by the user, so S1 is only a suggestion.
    expect(row("r1", "S1")).toEqual({ status: "suggested", speaker_id: 1, assigned_by: "matcher" });
    expect(row("r1", "S2")).toEqual({ status: "confirmed", speaker_id: 1, assigned_by: "user" });
    expect(row("r1", "S3")).toEqual({ status: "ignored", speaker_id: null, assigned_by: "user" });
    expect(row("r1", "S4")).toEqual({ status: "unknown", speaker_id: null, assigned_by: null });
    expect(matchRecording("r1", loadLibrary(MODEL), MODEL, T)).toBe(false);
  });

  it("only compares centroids from the active model", () => {
    person(1, "Ann");
    voiceprint(1, "old", "S1", A);
    labelRow("r1", "S1", A, { modelId: "m@0" });
    matchRecording("r1", loadLibrary(MODEL), MODEL, T);
    expect(row("r1", "S1")).toEqual({ status: "unknown", speaker_id: null, assigned_by: null });
  });

  it("drops a match once the person's voiceprints are gone", () => {
    person(1, "Ann");
    voiceprint(1, "old", "S1", A);
    labelRow("r1", "S1", A);
    expect(rematchAll(MODEL, T)).toEqual(["r1"]);
    expect(row("r1", "S1")).toMatchObject({ status: "auto", speaker_id: 1 });
    removeLabelVoiceprints("old", "S1");
    expect(rematchAll(MODEL, T)).toEqual(["r1"]);
    expect(row("r1", "S1")).toEqual({ status: "unknown", speaker_id: null, assigned_by: null });
  });

  it("ranks candidates for the labelling UI", () => {
    person(1, "Ann");
    person(2, "Bob");
    voiceprint(1, "old", "S1", A);
    voiceprint(2, "old", "S2", B);
    labelRow("r1", "S1", new Float32Array([0.9, 0.1, 0]));
    expect(labelCandidates("r1", "S1", MODEL).map((c) => c.speakerId)).toEqual([1, 2]);
    expect(labelCandidates("r1", "S1", "m@other")).toEqual([]);
  });
});

describe("setLabel", () => {
  it("confirms a label as a new person and adds their voiceprint", () => {
    labelRow("r1", "S1", A);
    expect(setLabel("r1", "S1", { status: "confirmed", person: { name: "  Ann   Lee " } }, 20_000)).toEqual({
      ok: true,
      speakerId: 1,
      voiceprint: "added",
    });
    expect(db.prepare("SELECT name FROM speakers").all()).toEqual([{ name: "Ann Lee" }]);
    expect(row("r1", "S1")).toEqual({ status: "confirmed", speaker_id: 1, assigned_by: "user" });
    expect(db.prepare("SELECT speaker_id, source, is_anchor FROM speaker_embeddings").all()).toEqual([
      { speaker_id: 1, source: "confirmed", is_anchor: 1 },
    ]);
    // The same name in another case is the same person.
    labelRow("r2", "S1", B);
    expect(setLabel("r2", "S1", { status: "confirmed", person: { name: "ann lee" } }, 20_000)).toMatchObject({ speakerId: 1 });
  });

  it("moves the voiceprint when a label is reassigned, and removes it when ignored or reset", () => {
    person(1, "Ann");
    person(2, "Bob");
    labelRow("r1", "S1", A);
    setLabel("r1", "S1", { status: "confirmed", person: { speakerId: 1 } }, 20_000);
    setLabel("r1", "S1", { status: "confirmed", person: { speakerId: 2 } }, 20_000);
    expect(db.prepare("SELECT speaker_id FROM speaker_embeddings").all()).toEqual([{ speaker_id: 2 }]);

    setLabel("r1", "S1", { status: "ignored" }, 20_000);
    expect(row("r1", "S1")).toEqual({ status: "ignored", speaker_id: null, assigned_by: "user" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM speaker_embeddings").get()).toEqual({ n: 0 });

    setLabel("r1", "S1", { status: "unknown" }, 20_000);
    expect(row("r1", "S1")).toEqual({ status: "unknown", speaker_id: null, assigned_by: null });
  });

  it("confirms without a voiceprint when there is too little speech", () => {
    labelRow("r1", "S1", A, { speechMs: 5_000 });
    expect(setLabel("r1", "S1", { status: "confirmed", person: { name: "Ann" } }, 20_000)).toMatchObject({
      ok: true,
      voiceprint: "too_short",
    });
    expect(row("r1", "S1")).toMatchObject({ status: "confirmed" });
  });

  it("rejects placeholders, unknown people and unknown labels", () => {
    labelRow("r1", "S1", A);
    expect(setLabel("r1", "S1", { status: "confirmed", person: { name: "Speaker 3" } }, 20_000)).toMatchObject({
      ok: false,
      code: 400,
    });
    expect(setLabel("r1", "S1", { status: "confirmed", person: { name: "   " } }, 20_000)).toMatchObject({ code: 400 });
    expect(setLabel("r1", "S1", { status: "confirmed", person: { speakerId: 99 } }, 20_000)).toMatchObject({ code: 404 });
    expect(setLabel("r1", "S9", { status: "ignored" }, 20_000)).toMatchObject({ code: 404 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM speakers").get()).toEqual({ n: 0 });
  });
});

describe("removeLabelVoiceprints", () => {
  it("promotes the oldest remaining voiceprint when the anchor goes", () => {
    person(1, "Ann");
    voiceprint(1, "r1", "S1", A);
    voiceprint(1, "r2", "S1", B);
    voiceprint(1, "r3", "S1", C);
    expect(removeLabelVoiceprints("r1", "S1")).toBe(1);
    expect(db.prepare("SELECT recording_id, is_anchor FROM speaker_embeddings ORDER BY id").all()).toEqual([
      { recording_id: "r2", is_anchor: 1 },
      { recording_id: "r3", is_anchor: 0 },
    ]);
  });
});

describe("setSegmentSpeaker", () => {
  it("sets and clears a segment override", () => {
    expect(setSegmentSpeaker("r1", "seg-1", { name: "Ann" })).toEqual({ ok: true, speakerId: 1 });
    expect(db.prepare("SELECT segment_key, speaker_id FROM segment_overrides").all()).toEqual([
      { segment_key: "seg-1", speaker_id: 1 },
    ]);
    expect(setSegmentSpeaker("r1", "seg-1", null)).toEqual({ ok: true, speakerId: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM segment_overrides").get()).toEqual({ n: 0 });
    expect(setSegmentSpeaker("r1", "seg-1", { speakerId: 42 })).toMatchObject({ ok: false, code: 404 });
  });
});
