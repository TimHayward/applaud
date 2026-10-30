import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { buildApplaudTranscript, writeApplaudTranscript, type LabelAssignment } from "./outputs.js";
import type { SpeakerSegment } from "./segments.js";

const seg = (key: string, label: string, name: string, startMs: number): SpeakerSegment => ({
  key,
  label,
  name,
  startMs,
  endMs: startMs + 1_000,
  text: `text ${key}`,
});

describe("buildApplaudTranscript", () => {
  const names = new Map([
    [1, "Tim Hayward"],
    [2, "Ann"],
    [3, "Bob"],
  ]);
  const labels = new Map<string, LabelAssignment>([
    ["Speaker 1", { status: "confirmed", speakerId: 1, confidence: null }],
    ["Speaker 2", { status: "auto", speakerId: 2, confidence: 0.81 }],
    ["Speaker 3", { status: "suggested", speakerId: 3, confidence: 0.6 }],
  ]);

  it("names confirmed and automatic labels, and keeps Plaud's name otherwise", () => {
    const out = buildApplaudTranscript(
      [
        seg("a", "Speaker 1", "Tim Hayward", 0),
        seg("b", "Speaker 2", "Speaker 2", 1_000),
        seg("c", "Speaker 3", "Speaker 3", 2_000),
        seg("d", "Speaker 4", "Speaker 4", 3_000),
      ],
      labels,
      new Map(),
      names,
    );
    expect(out.map((s) => [s.speaker, s.speaker_id, s.label_status, s.suggested_speaker])).toEqual([
      ["Tim Hayward", 1, "confirmed", undefined],
      ["Ann", 2, "auto", undefined],
      ["Speaker 3", null, "suggested", "Bob"],
      ["Speaker 4", null, "unknown", undefined],
    ]);
    expect(out[1]).toEqual({
      segment_key: "b",
      start_time: 1_000,
      end_time: 2_000,
      content: "text b",
      speaker: "Ann",
      speaker_id: 2,
      plaud_speaker: "Speaker 2",
      original_speaker: "Speaker 2",
      label_status: "auto",
      confidence: 0.81,
    });
  });

  it("applies segment overrides over the label", () => {
    const out = buildApplaudTranscript([seg("b", "Speaker 2", "Speaker 2", 0)], labels, new Map([["b", 3]]), names);
    expect(out[0]).toMatchObject({ speaker: "Bob", speaker_id: 3, label_status: "confirmed", segment_override: true });
  });
});

describe("writeApplaudTranscript", () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = setupTestDb();
    dir = mkdtempSync(path.join(os.tmpdir(), "applaud-outputs-"));
    mkdirSync(path.join(dir, "f1"));
    writeFileSync(
      path.join(dir, "f1", "transcript.json"),
      JSON.stringify([
        { segment_uid: "u1", start_time: 0, end_time: 4_000, content: "Hello.", speaker: "Speaker 1", original_speaker: "Speaker 1" },
        { segment_uid: "u2", start_time: 65_000, end_time: 70_000, content: "Hi.", speaker: "Speaker 2", original_speaker: "Speaker 2" },
      ]),
    );
    db.prepare(
      `INSERT INTO recordings (id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number, folder,
         audio_filename, audio_downloaded_at, transcript_downloaded_at, speakers_processed_at)
       VALUES ('r1', 'f', 0, 1, 70000, 1, 'S', 'f1', 'audio.ogg', 1, 1, 1)`,
    ).run();
    db.prepare("INSERT INTO speakers (id, name, created_at, updated_at) VALUES (1, 'Ann', 0, 0)").run();
    db.prepare(
      "INSERT INTO recording_speakers (recording_id, plaud_label, speaker_id, status, updated_at) VALUES ('r1', 'Speaker 1', 1, 'confirmed', 0)",
    ).run();
  });

  afterEach(() => {
    teardownTestDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes both files, and rewrites them only when they change", () => {
    expect(writeApplaudTranscript(dir, "r1")).toBe("written");
    const txt = path.join(dir, "f1", "transcript-Applaud.txt");
    expect(readFileSync(txt, "utf8")).toBe("[00:00] Ann: Hello.\n\n[01:05] Speaker 2: Hi.");
    const json = JSON.parse(readFileSync(path.join(dir, "f1", "transcript-Applaud.json"), "utf8")) as { speaker: string }[];
    expect(json.map((s) => s.speaker)).toEqual(["Ann", "Speaker 2"]);

    const before = statSync(txt).mtimeMs;
    expect(writeApplaudTranscript(dir, "r1")).toBe("unchanged");
    expect(statSync(txt).mtimeMs).toBe(before);

    db.prepare("UPDATE speakers SET name = 'Annie'").run();
    expect(writeApplaudTranscript(dir, "r1")).toBe("written");
    expect(readFileSync(txt, "utf8")).toContain("Annie: Hello.");
  });

  it("skips recordings that have not been analysed", () => {
    db.prepare("UPDATE recordings SET speakers_processed_at = NULL").run();
    expect(writeApplaudTranscript(dir, "r1")).toBe("skipped");
  });
});
