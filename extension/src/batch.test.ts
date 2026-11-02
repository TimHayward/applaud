import { describe, it, expect, vi } from "vitest";
import { ApplaudError } from "./applaud.js";
import { newBatch, runBatch, stopsBatch, type BatchDeps } from "./batch.js";
import type { ApplyReply } from "./messages.js";

const reply = (status: ApplyReply["status"], reason: string | null = null): ApplyReply => ({
  status,
  reason,
  results: [],
  reported: true,
  changedSegments: 0,
  summaryReplacements: 0,
});

const items = ["a", "b", "c"].map((id) => ({ recordingId: id, title: `Recording ${id}` }));

function deps(send: BatchDeps["send"], stop = () => false) {
  const saves: number[] = [];
  const d: BatchDeps = {
    send,
    save: vi.fn(async (s) => {
      saves.push(s.done.length);
    }),
    stopRequested: stop,
    sleep: async () => {},
    now: () => 42,
  };
  return { d, saves };
}

describe("runBatch", () => {
  it("sends each recording in turn and records the outcome", async () => {
    const send = vi.fn(async (id: string) =>
      reply(id === "b" ? "stale" : "applied", id === "b" ? "changed" : null),
    );
    const state = await runBatch(newBatch(items, 1), deps(send).d);
    expect(send.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    expect(state.done.map((e) => [e.recordingId, e.status])).toEqual([
      ["a", "applied"],
      ["b", "stale"],
      ["c", "applied"],
    ]);
    expect(state).toMatchObject({
      running: false,
      current: null,
      stoppedBecause: null,
      finishedAt: 42,
    });
  });

  it("carries on past a recording-specific problem", async () => {
    const send = vi.fn(async (id: string) => {
      if (id === "a") throw new ApplaudError("recording not found", 404);
      if (id === "b")
        return reply("partial", "summary: Plaud: version conflict, re-fetch and retry");
      return reply("applied");
    });
    const state = await runBatch(newBatch(items, 1), deps(send).d);
    expect(state.done.map((e) => e.status)).toEqual(["error", "partial", "applied"]);
    expect(state.stoppedBecause).toBeNull();
  });

  it("stops at a problem that would fail every recording", async () => {
    const send = vi.fn(async (id: string) => {
      if (id === "b")
        throw new ApplaudError(
          "sending names to Plaud is off in Applaud (Settings → Speakers)",
          409,
        );
      return reply("applied");
    });
    const state = await runBatch(newBatch(items, 1), deps(send).d);
    expect(send).toHaveBeenCalledTimes(2);
    expect(state.stoppedBecause).toMatch(/is off/);
  });

  it("stops when a send finds the Plaud tab signed out", async () => {
    const send = vi.fn(async () =>
      reply("failed", "transcript: Plaud says this tab is signed out"),
    );
    const state = await runBatch(newBatch(items, 1), deps(send).d);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.stoppedBecause).toMatch(/signed out/);
  });

  it("stops before the next recording when asked", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      return reply("applied");
    });
    const state = await runBatch(newBatch(items, 1), deps(send, () => calls >= 1).d);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.stoppedBecause).toBe("stopped");
  });

  it("saves progress as it goes", async () => {
    const { d, saves } = deps(async () => reply("applied"));
    await runBatch(newBatch(items, 1), d);
    expect(saves).toEqual([0, 1, 2, 3]);
  });
});

describe("stopsBatch", () => {
  it("separates problems for one recording from problems for all", () => {
    expect(stopsBatch(new ApplaudError("Couldn't reach Applaud at http://x", 0))).toBe(true);
    expect(
      stopsBatch(
        new ApplaudError("Applaud no longer recognises this extension. Pair it again", 401),
      ),
    ).toBe(true);
    expect(stopsBatch(new Error("You are not signed in to Plaud in this tab"))).toBe(true);
    expect(stopsBatch(new ApplaudError("recording not found", 404))).toBe(false);
    expect(stopsBatch(new Error("Plaud has no transcript for this recording"))).toBe(false);
  });
});
