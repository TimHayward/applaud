import { describe, it, expect } from "vitest";
import { WindowCollector } from "./pcm.js";

/** f32le bytes for samples 0, 1, 2, ... n-1 (each sample's value is its index). */
function ramp(n: number, from = 0): Buffer {
  const b = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) b.writeFloatLE(from + i, i * 4);
  return b;
}

const values = (a: Float32Array | undefined): number[] => Array.from(a ?? []);

describe("WindowCollector", () => {
  // A 1 kHz rate makes 1 ms = 1 sample, so window bounds read directly.
  it("keeps only the requested windows", () => {
    const c = new WindowCollector(
      [
        { id: "a", startMs: 2, endMs: 5 },
        { id: "b", startMs: 7, endMs: 9 },
      ],
      1000,
    );
    c.push(ramp(10));
    expect(c.results().map((r) => [r.id, values(r.samples)])).toEqual([
      ["a", [2, 3, 4]],
      ["b", [7, 8]],
    ]);
    expect(c.samplesSeen).toBe(10);
  });

  it("joins windows that span chunks, including chunks that split a sample", () => {
    const c = new WindowCollector([{ id: "a", startMs: 1, endMs: 6 }], 1000);
    const all = ramp(8);
    for (const [s, e] of [
      [0, 6],
      [6, 13],
      [13, 14],
      [14, 32],
    ] as const) {
      c.push(all.subarray(s, e));
    }
    expect(values(c.results()[0]?.samples)).toEqual([1, 2, 3, 4, 5]);
    expect(c.samplesSeen).toBe(8);
  });

  it("returns a short or empty window when the audio ends early", () => {
    const c = new WindowCollector(
      [
        { id: "cut", startMs: 3, endMs: 10 },
        { id: "past", startMs: 20, endMs: 25 },
      ],
      1000,
    );
    c.push(ramp(5));
    const [cut, past] = c.results();
    expect(values(cut?.samples)).toEqual([3, 4]);
    expect(past?.samples.length).toBe(0);
  });

  it("converts milliseconds to samples at 16 kHz", () => {
    const c = new WindowCollector([{ id: "a", startMs: 1, endMs: 2 }]);
    c.push(ramp(40));
    expect(values(c.results()[0]?.samples)).toEqual(Array.from({ length: 16 }, (_, i) => 16 + i));
  });
});
