/**
 * One automatic run of the Applaud automation browser (Settings → Automatic
 * Plaud sync). Applaud decides whether a run is due and what it may do (P2);
 * Plaud is only opened when Applaud has work. The sends and card fetches are
 * the desktop extension's own modules, unchanged: each recording is read from
 * Plaud afresh, planned by Applaud and written with Plaud's version check.
 *
 * Dependencies are passed in so a run can be tested without a browser.
 */
import type {
  PlaudAutomationHeartbeat,
  PlaudAutomationNextResponse,
  PlaudCardRequest,
} from "@applaud/shared";
import { MAX_BATCH, newBatch, runBatch, type BatchItem, type BatchState } from "../batch.js";
import { fetchCardIfNeeded, fetchCards, type CardDeps } from "../cards.js";
import type { CardsReply } from "../messages.js";
import type { CardResult } from "../plaud.js";
import { send, type SendDeps } from "../send.js";

export interface RunDeps {
  next: () => Promise<PlaudAutomationNextResponse>;
  /** Recordings Applaud wants sent now, newest first. */
  pending: () => Promise<BatchItem[]>;
  cardsNeeded: () => Promise<string[]>;
  saveCard: (recordingId: string, body: PlaudCardRequest) => Promise<unknown>;
  heartbeat: (hb: PlaudAutomationHeartbeat) => Promise<unknown>;
  /** Tell Applaud about results it missed earlier. */
  flushUnreported: () => Promise<unknown>;
  send: SendDeps;
  readCard: (recordingId: string) => Promise<CardResult>;
  /** Make sure a Plaud tab is open; true when this run opened it. */
  openPlaud: () => Promise<boolean>;
  closePlaud: () => Promise<void>;
  signedIn: () => Promise<boolean>;
  /**
   * Whether a Plaud tab that is already open is signed in, read from the page
   * without contacting Plaud; null when none is open (one isn't opened for this).
   */
  openTabSignedIn: () => Promise<boolean | null>;
  sleep?: (ms: number) => Promise<void>;
}

export type RunOutcome = "not_due" | "idle" | "signed_out" | "ran" | "error";

/** Plaud answered in a shape the extension doesn't recognise (plaud.ts): pause, don't guess (P6). */
const SHAPE_PROBLEM = /reply was not JSON|has no document list|not in the expected shape/i;
const CONFLICT = /conflict|changed since/i;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Counts {
  sent: number;
  conflicts: number;
  failed: number;
  cards: number;
}

function countBatch(state: BatchState, counts: Counts): string[] {
  const problems: string[] = [];
  for (const e of state.done) {
    if (e.status === "applied") counts.sent += 1;
    else if (e.status === "nothing") continue;
    else if (e.status === "stale" || CONFLICT.test(e.reason ?? "")) counts.conflicts += 1;
    else counts.failed += 1;
    if (e.reason && e.status !== "applied")
      problems.push(`${e.title || e.recordingId}: ${e.reason}`);
  }
  if (state.stoppedBecause && state.stoppedBecause !== "stopped")
    problems.unshift(state.stoppedBecause);
  return problems;
}

export async function runOnce(deps: RunDeps): Promise<RunOutcome> {
  const n = await deps.next();
  if (!n.due) return "not_due";
  await deps.flushUnreported().catch(() => undefined);

  const items = n.names ? (await deps.pending()).slice(0, MAX_BATCH) : [];
  const cardIds = n.cards ? await deps.cardsNeeded() : [];
  const counts: Counts = { sent: 0, conflicts: 0, failed: 0, cards: 0 };
  if (items.length === 0 && cardIds.length === 0) {
    // Nothing to do: Plaud isn't contacted at all. An open Plaud tab (the one
    // you signed in on) still shows whether the sign-in is good.
    const plaudSignedIn = await deps.openTabSignedIn().catch(() => null);
    await deps.heartbeat({ plaudSignedIn, ran: false, ...counts });
    return "idle";
  }

  let opened = false;
  try {
    opened = await deps.openPlaud();
    if (!(await deps.signedIn())) {
      // No error text: Settings shows the sign-in state itself, and clears it
      // as soon as a check-in sees the browser signed in again.
      await deps.heartbeat({ plaudSignedIn: false, ran: true, ...counts });
      return "signed_out";
    }

    const cards: CardDeps = {
      needed: deps.cardsNeeded,
      readCard: deps.readCard,
      save: async (id, body) => {
        await deps.saveCard(id, body);
        if (body.status === "found") counts.cards += 1;
      },
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    };
    const problems: string[] = [];
    if (items.length > 0) {
      const state = await runBatch(newBatch(items, Date.now()), {
        send: async (id) => {
          // The card first, so Applaud's re-read and webhook after the send carry it.
          if (n.cards) await fetchCardIfNeeded(cards, id);
          return send(deps.send, id);
        },
        save: async () => {},
        stopRequested: () => false,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      });
      problems.push(...countBatch(state, counts));
    }
    if (n.cards) {
      const reply: CardsReply = await fetchCards(cards);
      if (reply.error) problems.push(reply.error);
    }
    const error = problems[0];
    await deps.heartbeat({
      plaudSignedIn: true,
      ran: true,
      ...counts,
      ...(error ? { error: error.slice(0, 2000) } : {}),
      ...(problems.some((p) => SHAPE_PROBLEM.test(p)) ? { shapeError: true } : {}),
    });
    return "ran";
  } catch (err) {
    const error = message(err);
    await deps
      .heartbeat({
        plaudSignedIn: null,
        ran: true,
        ...counts,
        error: error.slice(0, 2000),
        ...(SHAPE_PROBLEM.test(error) ? { shapeError: true } : {}),
      })
      .catch(() => undefined);
    return "error";
  } finally {
    if (opened) await deps.closePlaud().catch(() => undefined);
  }
}
