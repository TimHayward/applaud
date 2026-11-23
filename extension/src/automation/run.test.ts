import { describe, it, expect, vi } from "vitest";
import type {
  PlaudAutomationHeartbeat,
  PlaudAutomationNextResponse,
  PlaudDocument,
  PlaudWritebackPlanResponse,
} from "@applaud/shared";
import type { CardResult } from "../plaud.js";
import { loadCredential } from "./client.js";
import { runOnce, type RunDeps } from "./run.js";

const doc: PlaudDocument = {
  kind: "transcript",
  objectId: "o",
  contentId: "c",
  version: 1,
  content: "[]",
};

function plan(id: string): PlaudWritebackPlanResponse {
  return {
    planId: `${id}`.padEnd(24, "0"),
    status: "ready",
    reason: null,
    documents: [
      { kind: "transcript", objectId: "o", contentId: "c", originVersion: 1, content: "[]" },
    ],
    changes: [],
    changedSegments: 1,
    summaryReplacements: 0,
  };
}

function deps(
  over: {
    next?: Partial<PlaudAutomationNextResponse>;
    pending?: string[];
    cards?: Record<string, CardResult>;
    signedIn?: boolean;
    tabOpen?: boolean;
    write?: (id: string) => "applied" | "conflict" | Error;
  } = {},
) {
  const heartbeats: PlaudAutomationHeartbeat[] = [];
  const plaud: string[] = [];
  const needed = new Set(Object.keys(over.cards ?? {}));
  let tabOpen = over.tabOpen ?? false;
  const d: RunDeps = {
    next: vi.fn(async () => ({
      enabled: true,
      due: true,
      names: true,
      cards: true,
      paused: null,
      ...over.next,
    })),
    pending: vi.fn(async () =>
      (over.pending ?? []).map((recordingId) => ({ recordingId, title: recordingId })),
    ),
    cardsNeeded: vi.fn(async () => [...needed]),
    saveCard: vi.fn(async (id: string) => {
      needed.delete(id);
    }),
    heartbeat: vi.fn(async (hb: PlaudAutomationHeartbeat) => {
      heartbeats.push(hb);
    }),
    flushUnreported: vi.fn(async () => 0),
    send: {
      readPlaud: vi.fn(async (id: string) => {
        plaud.push(`read ${id}`);
        return { documents: [doc] };
      }),
      writePlaud: vi.fn(async (id: string) => {
        plaud.push(`write ${id}`);
        const out = over.write?.(id) ?? "applied";
        if (out instanceof Error) throw out;
        return [
          {
            kind: "transcript" as const,
            outcome: out,
            ...(out === "applied" ? { newVersion: 2 } : {}),
          },
        ];
      }),
      plan: vi.fn(async (id: string) => plan(id)),
      undo: vi.fn(async () => {
        throw new Error("never");
      }),
      report: vi.fn(async () => ({ ok: true })),
      keepUnreported: vi.fn(async () => {}),
    },
    readCard: vi.fn(async (id: string) => {
      plaud.push(`card ${id}`);
      return over.cards![id]!;
    }),
    openPlaud: vi.fn(async () => {
      plaud.push("open");
      if (tabOpen) return false;
      tabOpen = true;
      return true;
    }),
    closePlaud: vi.fn(async () => {
      plaud.push("close");
      tabOpen = false;
    }),
    signedIn: vi.fn(async () => {
      plaud.push("diagnose");
      return over.signedIn ?? true;
    }),
    openTabSignedIn: vi.fn(async () => (tabOpen ? (over.signedIn ?? true) : null)),
    sleep: async () => {},
  };
  return { d, heartbeats, plaud };
}

describe("runOnce", () => {
  it("does nothing when Applaud says a run isn't due", async () => {
    const { d, heartbeats, plaud } = deps({ next: { due: false }, pending: ["a"] });
    expect(await runOnce(d)).toBe("not_due");
    expect(d.pending).not.toHaveBeenCalled();
    expect(heartbeats).toEqual([]);
    expect(plaud).toEqual([]);
  });

  it("checks in without touching Plaud when there is no work", async () => {
    const { d, heartbeats, plaud } = deps();
    expect(await runOnce(d)).toBe("idle");
    expect(plaud).toEqual([]);
    expect(heartbeats).toEqual([
      { plaudSignedIn: null, ran: false, sent: 0, conflicts: 0, failed: 0, cards: 0 },
    ]);
  });

  it("reports the sign-in of a Plaud tab that's already open, without opening one", async () => {
    const { d, heartbeats, plaud } = deps({ tabOpen: true });
    expect(await runOnce(d)).toBe("idle");
    expect(plaud).toEqual([]);
    expect(heartbeats[0]).toMatchObject({ plaudSignedIn: true, ran: false });
  });

  it("asks only for what Applaud allows", async () => {
    const { d } = deps({ next: { names: false }, pending: ["a"] });
    await runOnce(d);
    expect(d.pending).not.toHaveBeenCalled();
    expect(d.send.readPlaud).not.toHaveBeenCalled();
  });

  it("reports a signed-out Plaud and writes nothing", async () => {
    const { d, heartbeats, plaud } = deps({ pending: ["a"], signedIn: false });
    expect(await runOnce(d)).toBe("signed_out");
    expect(plaud).toEqual(["open", "diagnose", "close"]);
    expect(heartbeats[0]).toMatchObject({ plaudSignedIn: false, ran: true, sent: 0 });
  });

  it("sends each recording with its card first, then fetches the remaining cards, and closes the tab it opened", async () => {
    const { d, heartbeats, plaud } = deps({
      pending: ["a", "b"],
      cards: { a: { status: "found", png: "iVBO" }, z: { status: "found", png: "iVBO" } },
      write: (id) => (id === "b" ? "conflict" : "applied"),
    });
    expect(await runOnce(d)).toBe("ran");
    expect(plaud).toEqual([
      "open",
      "diagnose",
      "card a",
      "read a",
      "write a",
      "read b",
      "write b",
      "card z",
      "close",
    ]);
    expect(heartbeats).toEqual([
      expect.objectContaining({
        plaudSignedIn: true,
        ran: true,
        sent: 1,
        conflicts: 1,
        failed: 0,
        cards: 2,
      }),
    ]);
    expect(heartbeats[0]!.shapeError).toBeUndefined();
  });

  it("leaves a Plaud tab it didn't open", async () => {
    const { d, plaud } = deps({ pending: ["a"], tabOpen: true });
    await runOnce(d);
    expect(plaud).not.toContain("close");
  });

  it("asks Applaud to pause when Plaud answers in an unexpected shape", async () => {
    const { d, heartbeats } = deps({
      pending: ["a"],
      write: () => new Error("Plaud's reply has no document list"),
    });
    await runOnce(d);
    expect(heartbeats[0]).toMatchObject({ shapeError: true, failed: 1 });
  });

  it("still checks in when the run fails outright", async () => {
    const { d, heartbeats, plaud } = deps({ pending: ["a"] });
    d.signedIn = vi.fn(async () => {
      throw new Error("The Plaud tab isn't ready for the extension. Reload it and try again");
    });
    expect(await runOnce(d)).toBe("error");
    expect(heartbeats[0]).toMatchObject({ ran: true, error: expect.stringMatching(/isn't ready/) });
    expect(plaud).toContain("close");
  });
});

describe("loadCredential", () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("reads the credential Applaud left for the browser", async () => {
    const token = "a".repeat(64);
    expect(
      await loadCredential(
        "x",
        respond(200, { applaudUrl: "http://applaud.internal:44471/", token }),
      ),
    ).toEqual({ applaudUrl: "http://applaud.internal:44471", token });
  });

  it("treats a missing or malformed file as automatic sync being off", async () => {
    expect(await loadCredential("x", respond(404, {}))).toBeNull();
    expect(await loadCredential("x", respond(200, { applaudUrl: "x", token: "short" }))).toBeNull();
    expect(
      await loadCredential(
        "x",
        vi.fn(async () => Promise.reject(new Error("no file"))),
      ),
    ).toBeNull();
  });
});
