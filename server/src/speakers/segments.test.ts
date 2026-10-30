import { describe, it, expect } from "vitest";
import { normaliseSegments, MISSING_SPEAKER_LABEL } from "./segments.js";

const seg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  segment_uid: "u1",
  start_time: 1000,
  end_time: 4000,
  content: "Hello.",
  speaker: "Speaker 1",
  original_speaker: "Speaker 1",
  ...over,
});

describe("normaliseSegments", () => {
  it("keeps a current Plaud segment as is, keyed by segment_uid", () => {
    expect(normaliseSegments([seg()])).toEqual([
      { key: "u1", label: "Speaker 1", name: "Speaker 1", startMs: 1000, endMs: 4000, text: "Hello." },
    ]);
  });

  it("labels by original_speaker and keeps the renamed speaker as the name", () => {
    const [s] = normaliseSegments([seg({ speaker: "Tim Hayward", original_speaker: "Speaker 2" })]);
    expect(s).toMatchObject({ label: "Speaker 2", name: "Tim Hayward" });
  });

  it("falls back to t<startMs> without a segment_uid", () => {
    const [s] = normaliseSegments([seg({ segment_uid: undefined, start_time: 2500, end_time: 3000 })]);
    expect(s?.key).toBe("t2500");
  });

  it("makes duplicate keys unique", () => {
    const keys = normaliseSegments([seg(), seg({ start_time: 5000, end_time: 6000 })]).map((s) => s.key);
    expect(keys).toEqual(["u1", "u1#2"]);
  });

  it("maps a missing speaker to UU and falls back to speaker for the label", () => {
    const [none, nameOnly] = normaliseSegments([
      seg({ segment_uid: "a", speaker: undefined, original_speaker: "" }),
      seg({ segment_uid: "b", original_speaker: undefined, speaker: "Speaker 3" }),
    ]);
    expect(none?.label).toBe(MISSING_SPEAKER_LABEL);
    expect(nameOnly?.label).toBe("Speaker 3");
  });

  it("drops segments whose end is not after their start, and bad timings", () => {
    const out = normaliseSegments([
      seg({ segment_uid: "ok" }),
      seg({ segment_uid: "zero", start_time: 5000, end_time: 5000 }),
      seg({ segment_uid: "back", start_time: 6000, end_time: 5000 }),
      seg({ segment_uid: "nan", start_time: "x" }),
      seg({ segment_uid: "neg", start_time: -1 }),
      null,
      "text",
    ]);
    expect(out.map((s) => s.key)).toEqual(["ok"]);
  });

  it("accepts an object of segments", () => {
    expect(normaliseSegments({ a: seg() })).toHaveLength(1);
    expect(normaliseSegments(null)).toEqual([]);
  });

  describe("seconds vs milliseconds", () => {
    it("uses the recording duration to read whole-number seconds", () => {
      const out = normaliseSegments([seg({ start_time: 0, end_time: 59 }), seg({ segment_uid: "u2", start_time: 59, end_time: 120 })], 120_000);
      expect(out.map((s) => [s.startMs, s.endMs])).toEqual([
        [0, 59_000],
        [59_000, 120_000],
      ]);
    });

    it("uses the recording duration to keep milliseconds", () => {
      const [s] = normaliseSegments([seg({ start_time: 0, end_time: 31_950 })], 32_000);
      expect(s?.endMs).toBe(31_950);
    });

    it("reads fractional timings as seconds when the duration is unknown", () => {
      const [s] = normaliseSegments([seg({ start_time: 1.25, end_time: 3.5 })]);
      expect([s?.startMs, s?.endMs]).toEqual([1250, 3500]);
    });

    it("reads whole-number timings as milliseconds when the duration is unknown", () => {
      const [s] = normaliseSegments([seg({ start_time: 30, end_time: 8270 })]);
      expect([s?.startMs, s?.endMs]).toEqual([30, 8270]);
    });
  });
});
