import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { addVoiceprint, VOICEPRINT_CAP, type NewVoiceprint } from "./library.js";

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  db.prepare("INSERT INTO speakers (id, name, created_at, updated_at) VALUES (1, 'Ann', 0, 0)").run();
});

afterEach(() => teardownTestDb(db));

/** A unit vector at `deg` degrees in the plane: cosine between two is cos(difference). */
const angle = (deg: number): Float32Array => {
  const r = (deg * Math.PI) / 180;
  return new Float32Array([Math.cos(r), Math.sin(r), 0, 0]);
};

const vp = (recordingId: string, vector: Float32Array, over: Partial<NewVoiceprint> = {}): NewVoiceprint => ({
  speakerId: 1,
  recordingId,
  plaudLabel: "Speaker 1",
  segmentKeys: ["a", "b"],
  vector,
  modelId: "m@1",
  speechMs: 30_000,
  source: "confirmed",
  ...over,
});

const rows = (): { recording_id: string; is_anchor: number; low_resemblance: number }[] =>
  db
    .prepare("SELECT recording_id, is_anchor, low_resemblance FROM speaker_embeddings ORDER BY id")
    .all() as { recording_id: string; is_anchor: number; low_resemblance: number }[];

describe("addVoiceprint", () => {
  it("makes the first voiceprint the anchor", () => {
    expect(addVoiceprint(vp("r1", angle(0)), 20_000)).toBe("added");
    expect(addVoiceprint(vp("r2", angle(30)), 20_000)).toBe("added");
    expect(rows().map((r) => r.is_anchor)).toEqual([1, 0]);
  });

  it("refuses too little speech", () => {
    expect(addVoiceprint(vp("r1", angle(0), { speechMs: 19_999 }), 20_000)).toBe("too_short");
    expect(rows()).toEqual([]);
  });

  it("skips a near duplicate", () => {
    addVoiceprint(vp("r1", angle(0)), 20_000);
    // cos(10°) ≈ 0.985 > 0.95
    expect(addVoiceprint(vp("r2", angle(10)), 20_000)).toBe("duplicate");
    expect(rows()).toHaveLength(1);
  });

  it("only compares voiceprints from the same model", () => {
    addVoiceprint(vp("r1", angle(0), { modelId: "old@1" }), 20_000);
    expect(addVoiceprint(vp("r2", angle(0)), 20_000)).toBe("added");
  });

  it("replaces the voiceprint for the same recording and label", () => {
    addVoiceprint(vp("r1", angle(0)), 20_000);
    expect(addVoiceprint(vp("r1", angle(90)), 20_000)).toBe("replaced");
    expect(rows()).toHaveLength(1);
  });

  it("accepts but flags one that resembles none of the person's others", () => {
    addVoiceprint(vp("r1", angle(0)), 20_000);
    addVoiceprint(vp("r2", angle(40)), 20_000);
    // cos(70°) ≈ 0.34 and cos(110°) < 0 against both: flagged.
    expect(addVoiceprint(vp("r3", angle(110)), 20_000)).toBe("added");
    expect(rows().map((r) => r.low_resemblance)).toEqual([0, 0, 1]);
  });

  it("caps at 12, evicting the oldest non-anchor", () => {
    for (let i = 0; i < VOICEPRINT_CAP + 2; i++) {
      // 20° apart (cos ≈ 0.94): never near-duplicates.
      addVoiceprint(vp(`r${i}`, angle(i * 20)), 20_000, 1_000 + i);
    }
    const kept = rows().map((r) => r.recording_id);
    expect(kept).toHaveLength(VOICEPRINT_CAP);
    expect(kept[0]).toBe("r0"); // the anchor survives
    expect(kept).not.toContain("r1");
    expect(kept).not.toContain("r2");
    expect(kept).toContain(`r${VOICEPRINT_CAP + 1}`);
  });
});
