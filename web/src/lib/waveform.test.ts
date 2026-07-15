import { describe, it, expect } from "vitest";
import { computePeaks, buildEnvelopePath } from "./waveform.js";

describe("computePeaks", () => {
  it("returns an empty array for zero bars or empty input", () => {
    expect(computePeaks(new Float32Array([0.5]), 0)).toEqual([]);
    expect(computePeaks(new Float32Array([]), 10)).toEqual([]);
  });

  it("produces exactly numBars values", () => {
    const samples = new Float32Array(1000).map(() => Math.random() - 0.5);
    expect(computePeaks(samples, 50)).toHaveLength(50);
  });

  it("normalizes the loudest bar to 1", () => {
    // First half quiet, second half loud → the loud bar should hit 1.
    const samples = new Float32Array(200);
    for (let i = 100; i < 200; i++) samples[i] = 1;
    const peaks = computePeaks(samples, 2);
    expect(Math.max(...peaks)).toBeCloseTo(1, 5);
  });

  it("takes the absolute peak per window (negative samples count)", () => {
    const samples = new Float32Array([-1, -0.5, 0.25, 0.1]);
    const peaks = computePeaks(samples, 2);
    // window 0 = [-1, -0.5] → 1; window 1 = [0.25, 0.1] → 0.25; normalized by 1.
    expect(peaks[0]).toBeCloseTo(1, 5);
    expect(peaks[1]).toBeCloseTo(0.25, 5);
  });

  it("applies a small floor so non-loud bars stay visible", () => {
    const samples = new Float32Array(100);
    samples[50] = 1; // one loud sample; the rest silent
    const peaks = computePeaks(samples, 10);
    for (const p of peaks) expect(p).toBeGreaterThanOrEqual(0.03);
  });

  it("returns all-zero when the signal is pure silence", () => {
    const peaks = computePeaks(new Float32Array(100), 10);
    expect(peaks.every((p) => p === 0)).toBe(true);
  });
});

describe("buildEnvelopePath", () => {
  it("returns an empty string for no data", () => {
    expect(buildEnvelopePath([], 100, 40)).toBe("");
  });

  it("starts at the vertical midline and closes the path", () => {
    const d = buildEnvelopePath([0.5, 1, 0.5], 100, 40);
    expect(d.startsWith("M 0 20.0")).toBe(true);
    expect(d.endsWith(" Z")).toBe(true);
  });

  it("mirrors amplitude above and below the midline", () => {
    // Single-value envelope: top point sits at mid-amp, bottom at mid+amp.
    const d = buildEnvelopePath([1], 10, 40);
    // mid = 20, maxAmp = 18 → top y = 2.0, bottom y = 38.0
    expect(d).toContain("2.0");
    expect(d).toContain("38.0");
  });
});
