import { describe, it, expect, vi } from "vitest";
import { ApplaudError } from "./applaud.js";
import { fetchCardIfNeeded, fetchCards, type CardDeps } from "./cards.js";
import type { CardResult } from "./plaud.js";

function deps(cards: Record<string, CardResult | Error>, needed = Object.keys(cards)) {
  const saved: [string, unknown][] = [];
  const d: CardDeps = {
    needed: vi.fn(async () => needed),
    readCard: vi.fn(async (id: string) => {
      const c = cards[id]!;
      if (c instanceof Error) throw c;
      return c;
    }),
    save: vi.fn(async (id, body) => {
      saved.push([id, body]);
    }),
    sleep: async () => {},
  };
  return { d, saved };
}

describe("fetchCards", () => {
  it("saves cards, records recordings without one, and leaves unmade ones for later", async () => {
    const { d, saved } = deps({
      a: { status: "found", png: "iVBO" },
      b: { status: "none" },
      c: { status: "not_ready" },
    });
    expect(await fetchCards(d)).toEqual({ found: 1, none: 1, notReady: 1, failed: 0, error: null });
    expect(saved).toEqual([
      ["a", { status: "found", png: "iVBO" }],
      ["b", { status: "none" }],
    ]);
  });

  it("carries on past one failure, but stops when Plaud is signed out", async () => {
    const one = deps({
      a: new Error("Couldn't download the summary card (HTTP 500)"),
      b: { status: "none" },
    });
    expect(await fetchCards(one.d)).toMatchObject({ failed: 1, none: 1 });
    const all = deps({
      a: new Error("You are not signed in to Plaud in this tab"),
      b: { status: "none" },
    });
    expect(await fetchCards(all.d)).toMatchObject({ failed: 1, none: 0 });
    expect(all.d.readCard).toHaveBeenCalledTimes(1);
  });
});

describe("fetchCardIfNeeded", () => {
  it("only reads Plaud when Applaud still needs the card, and never throws", async () => {
    const { d } = deps({ a: { status: "found", png: "x" } }, []);
    await fetchCardIfNeeded(d, "a");
    expect(d.readCard).not.toHaveBeenCalled();

    const failing = deps({ a: new Error("boom") });
    await expect(fetchCardIfNeeded(failing.d, "a")).resolves.toBeUndefined();

    const down = deps({});
    down.d.needed = vi.fn(async () => Promise.reject(new ApplaudError("down", 0)));
    await expect(fetchCardIfNeeded(down.d, "a")).resolves.toBeUndefined();
  });
});
