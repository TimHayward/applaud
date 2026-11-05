/**
 * Fetching summary cards from the Plaud tab into Applaud. Read only in Plaud.
 * Runs alongside a dry run or send of a recording that needs its card, and
 * for a batch when the user asks (Fetch summary cards).
 */
import type { PlaudCardRequest } from "@applaud/shared";
import { stopsBatch } from "./batch.js";
import type { CardsReply } from "./messages.js";
import type { CardResult } from "./plaud.js";

export const CARD_PAUSE_MS = 1500;

export interface CardDeps {
  needed: () => Promise<string[]>;
  readCard: (recordingId: string) => Promise<CardResult>;
  save: (recordingId: string, body: PlaudCardRequest) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}

type One = "found" | "none" | "not_ready";

/** Fetch one card and hand it to Applaud. A card Plaud hasn't made yet is left to ask about later. */
async function fetchOne(deps: CardDeps, recordingId: string): Promise<One> {
  const card = await deps.readCard(recordingId);
  if (card.status === "found") await deps.save(recordingId, { status: "found", png: card.png });
  else if (card.status === "none") await deps.save(recordingId, { status: "none" });
  return card.status;
}

/** The card for a recording just read for a dry run or send, if Applaud still needs it. Never throws. */
export async function fetchCardIfNeeded(deps: CardDeps, recordingId: string): Promise<void> {
  try {
    if ((await deps.needed()).includes(recordingId)) await fetchOne(deps, recordingId);
  } catch {
    /* a card is a nice-to-have: never fail a send over it */
  }
}

/** Fetch every card Applaud needs, up to its limit, one at a time. */
export async function fetchCards(deps: CardDeps): Promise<CardsReply> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const reply: CardsReply = { found: 0, none: 0, notReady: 0, failed: 0, error: null };
  const ids = await deps.needed();
  for (const [i, id] of ids.entries()) {
    if (i > 0) await sleep(CARD_PAUSE_MS);
    try {
      const out = await fetchOne(deps, id);
      if (out === "found") reply.found += 1;
      else if (out === "none") reply.none += 1;
      else reply.notReady += 1;
    } catch (err) {
      reply.failed += 1;
      reply.error ??= err instanceof Error ? err.message : String(err);
      if (stopsBatch(err)) break;
    }
  }
  return reply;
}
