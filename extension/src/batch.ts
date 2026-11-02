/**
 * Sending several recordings in one go (plan Phase 4). One confirmation for
 * the batch (P4); each recording is still read from Plaud afresh, planned by
 * Applaud and written with Plaud's version check, exactly as a single send.
 *
 * A recording that can't be sent (changed in Plaud, nothing to send, refused
 * part-way) is recorded and the batch carries on. A problem that would fail
 * every recording (signed out of Plaud, sending switched off in Applaud,
 * Applaud unreachable, a protocol mismatch) stops the batch at once.
 */
import { ApplaudError } from "./applaud.js";
import type { ApplyReply } from "./messages.js";

export const MAX_BATCH = 25;
/** Pause between recordings: keeps a batch looking like a person working through a list (P4). */
export const BATCH_PAUSE_MS = 1500;

export interface BatchItem {
  recordingId: string;
  title: string;
}

export interface BatchEntry extends BatchItem {
  status: ApplyReply["status"] | "error";
  reason: string | null;
}

export interface BatchState {
  running: boolean;
  items: BatchItem[];
  done: BatchEntry[];
  current: BatchItem | null;
  /** Why the batch ended early: "stopped" when the user asked, else the problem. */
  stoppedBecause: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface BatchDeps {
  send: (recordingId: string) => Promise<ApplyReply>;
  save: (state: BatchState) => Promise<void>;
  stopRequested: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const AFFECTS_EVERY_RECORDING =
  /signed (in|out)|isn't ready|didn't answer|Open Plaud|API address|Couldn't reach Applaud|Pair it again|is off|protocol|Update Applaud/i;

/** Whether a problem would fail every other recording too, so the batch should stop. */
export function stopsBatch(err: unknown): boolean {
  if (err instanceof ApplaudError) {
    if (err.status === 0 || err.status === 401 || err.status === 426 || err.status >= 500)
      return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return AFFECTS_EVERY_RECORDING.test(message);
}

export function newBatch(items: BatchItem[], now: number): BatchState {
  return {
    running: true,
    items,
    done: [],
    current: null,
    stoppedBecause: null,
    startedAt: now,
    finishedAt: null,
  };
}

export async function runBatch(state: BatchState, deps: BatchDeps): Promise<BatchState> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  try {
    for (const [i, item] of state.items.entries()) {
      if (deps.stopRequested()) {
        state.stoppedBecause = "stopped";
        break;
      }
      if (i > 0) await sleep(BATCH_PAUSE_MS);
      state.current = item;
      await deps.save(state);
      let entry: BatchEntry;
      let stop = false;
      try {
        const reply = await deps.send(item.recordingId);
        entry = { ...item, status: reply.status, reason: reply.reason };
        stop =
          (reply.status === "failed" || reply.status === "partial") &&
          stopsBatch(reply.reason ?? "");
      } catch (err) {
        entry = {
          ...item,
          status: "error",
          reason: err instanceof Error ? err.message : String(err),
        };
        stop = stopsBatch(err);
      }
      state.done.push(entry);
      if (stop) {
        state.stoppedBecause = entry.reason ?? "a problem that would affect every recording";
        break;
      }
    }
  } finally {
    state.running = false;
    state.current = null;
    state.finishedAt = now();
    await deps.save(state);
  }
  return state;
}
