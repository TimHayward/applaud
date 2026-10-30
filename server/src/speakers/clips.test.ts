import { describe, it, expect } from "vitest";
import { selectClips } from "./clips.js";
import type { SpeakerSegment } from "./segments.js";

const seg = (key: string, startS: number, lenS: number, words = 10): SpeakerSegment => ({
  key,
  label: "Speaker 1",
  name: "Speaker 1",
  startMs: startS * 1000,
  endMs: (startS + lenS) * 1000,
  text: Array.from({ length: words }, () => "word").join(" "),
});

describe("selectClips", () => {
  it("prefers segments around 8 s, spread at least 20 s apart", () => {
    const clips = selectClips([
      seg("short", 0, 1),
      seg("ideal", 100, 8),
      seg("near-ideal", 110, 7), // within 20 s of "ideal"
      seg("ok", 200, 4),
      seg("long", 300, 40),
    ], 3);
    expect(clips.map((c) => c.segmentKey)).toEqual(["ideal", "ok", "long"]);
  });

  it("fills from the remaining segments when a label speaks little", () => {
    const clips = selectClips([seg("a", 0, 8), seg("b", 5, 8), seg("c", 10, 1)], 5);
    expect(clips.map((c) => c.segmentKey)).toEqual(["a", "b", "c"]);
  });

  it("cuts long segments to 12 s", () => {
    expect(selectClips([seg("long", 10, 60)])).toEqual([
      { segmentKey: "long", startMs: 10_000, endMs: 22_000, text: expect.any(String) },
    ]);
  });

  it("uses word count to break ties in length", () => {
    expect(selectClips([seg("few", 0, 8, 2), seg("many", 100, 8, 25)], 1)[0]!.segmentKey).toBe("many");
  });
});
