import { describe, it, expect, vi } from "vitest";
import type {
  PlaudDocumentWrite,
  PlaudWritebackPlanResponse,
  PlaudWritebackResult,
} from "@applaud/shared";
import { send, undo, type SendDeps } from "./send.js";

const ready: PlaudWritebackPlanResponse = {
  planId: "p".repeat(24),
  status: "ready",
  reason: null,
  documents: [
    { kind: "transcript", objectId: "o", contentId: "c", originVersion: 1, content: "[]" },
    { kind: "summary", objectId: "o2", contentId: "c2", originVersion: 2, content: "#" },
  ],
  changes: [],
  changedSegments: 3,
  summaryReplacements: 1,
};

function deps(
  over: Partial<SendDeps> = {},
): SendDeps & { reported: PlaudWritebackResult[][]; kept: PlaudWritebackResult[][] } {
  const reported: PlaudWritebackResult[][] = [];
  const kept: PlaudWritebackResult[][] = [];
  return {
    readPlaud: vi.fn(async () => ({ documents: [] })),
    writePlaud: vi.fn(async (_id: string, writes: PlaudDocumentWrite[]) =>
      writes.map((w, i) => ({ kind: w.kind, outcome: "applied" as const, newVersion: 10 + i })),
    ),
    plan: vi.fn(async () => ready),
    undo: vi.fn(async () => ready),
    report: vi.fn(async (_p: string, r: PlaudWritebackResult[]) => {
      reported.push(r);
    }),
    keepUnreported: vi.fn(async (_p: string, r: PlaudWritebackResult[]) => {
      kept.push(r);
    }),
    reported,
    kept,
    ...over,
  };
}

describe("send", () => {
  it("reads, plans, writes and reports", async () => {
    const d = deps();
    const out = await send(d, "f_1");
    expect(out).toMatchObject({ status: "applied", reported: true, changedSegments: 3 });
    expect(d.reported).toEqual([out.results]);
  });

  it("writes nothing for a stale or empty plan", async () => {
    const d = deps({
      plan: vi.fn(async () => ({
        ...ready,
        planId: null,
        status: "stale" as const,
        reason: "changed",
        documents: [],
      })),
    });
    expect(await send(d, "f_1")).toMatchObject({ status: "stale", reason: "changed" });
    expect(d.writePlaud).not.toHaveBeenCalled();
    expect(d.report).not.toHaveBeenCalled();
  });

  it("reports a partial write and says why", async () => {
    const d = deps({
      writePlaud: vi.fn(async () => [
        { kind: "transcript" as const, outcome: "applied" as const, newVersion: 5 },
        { kind: "summary" as const, outcome: "conflict" as const, error: "changed" },
      ]),
    });
    expect(await send(d, "f_1")).toMatchObject({ status: "partial", reason: "summary: changed" });
    expect(d.reported).toHaveLength(1);
  });

  it("reports nothing applied when the tab fails, so the next send completes it", async () => {
    const d = deps({
      writePlaud: vi.fn(async () => Promise.reject(new Error("The Plaud tab didn't answer"))),
    });
    expect(await send(d, "f_1")).toMatchObject({
      status: "failed",
      reason: "The Plaud tab didn't answer",
    });
    expect(d.reported).toEqual([[]]);
  });

  it("keeps results Applaud couldn't be told about", async () => {
    const d = deps({ report: vi.fn(async () => Promise.reject(new Error("down"))) });
    const out = await send(d, "f_1");
    expect(out).toMatchObject({ status: "applied", reported: false });
    expect(d.kept).toEqual([out.results]);
  });
});

describe("undo", () => {
  it("writes what Applaud returns without reading or planning", async () => {
    const d = deps();
    expect(await undo(d, "f_1")).toMatchObject({ status: "applied" });
    expect(d.readPlaud).not.toHaveBeenCalled();
    expect(d.plan).not.toHaveBeenCalled();
  });
});
