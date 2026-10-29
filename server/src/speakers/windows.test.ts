import { describe, it, expect } from "vitest";
import { selectWindows, LABEL_BUDGET_MS, WINDOW_MAX_MS } from "./windows.js";
import type { SpeakerSegment } from "./segments.js";

const seg = (key: string, startMs: number, lengthMs: number): SpeakerSegment => ({
  key,
  label: "Speaker 1",
  name: "Speaker 1",
  startMs,
  endMs: startMs + lengthMs,
  text: "",
});

const total = (ws: { startMs: number; endMs: number }[]): number => ws.reduce((n, w) => n + w.endMs - w.startMs, 0);

describe("selectWindows", () => {
  it("drops segments under 1.5 s and cuts long ones to 10 s", () => {
    const out = selectWindows([seg("short", 0, 1_000), seg("ok", 5_000, 3_000), seg("long", 20_000, 25_000)]);
    expect(out).toEqual([
      { id: "ok", startMs: 5_000, endMs: 8_000 },
      { id: "long", startMs: 20_000, endMs: 20_000 + WINDOW_MAX_MS },
    ]);
  });

  it("takes everything when it fits in the budget", () => {
    const segs = Array.from({ length: 5 }, (_, i) => seg(`s${i}`, i * 60_000, 8_000));
    expect(selectWindows(segs).map((w) => w.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("stops near the budget and spreads picks across the recording", () => {
    // 60 segments of 5 s over an hour: 300 s available, 60 s wanted.
    const segs = Array.from({ length: 60 }, (_, i) => seg(`s${i}`, i * 60_000, 5_000));
    const out = selectWindows(segs);
    expect(total(out)).toBeGreaterThanOrEqual(LABEL_BUDGET_MS);
    expect(total(out)).toBeLessThan(LABEL_BUDGET_MS + WINDOW_MAX_MS);
    // Every sixth of the hour contributes, not just the start.
    const sixths = new Set(out.map((w) => Math.floor(w.startMs / 600_000)));
    expect(sixths.size).toBe(6);
    expect(out.map((w) => w.startMs)).toEqual([...out.map((w) => w.startMs)].sort((a, b) => a - b));
  });

  it("prefers longer segments within a stretch", () => {
    const segs = [
      ...Array.from({ length: 20 }, (_, i) => seg(`short${i}`, i * 10_000, 2_000)),
      seg("long", 100_000, 9_000),
    ];
    const ids = selectWindows([...segs, ...Array.from({ length: 10 }, (_, i) => seg(`pad${i}`, 300_000 + i * 10_000, 9_000))]).map(
      (w) => w.id,
    );
    expect(ids).toContain("long");
  });

  it("returns nothing for a label with no usable speech", () => {
    expect(selectWindows([seg("a", 0, 500)])).toEqual([]);
  });
});
