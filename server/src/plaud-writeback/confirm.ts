import { logger } from "../logger.js";

/**
 * After a send or an undo, Applaud re-reads the recording from Plaud's
 * official API so the change is confirmed by a second channel (plan W7).
 * Routine polls only fetch transcripts Applaud doesn't have yet, so without
 * this a sent recording would wait for a manual resync. The delay gives
 * Plaud time to serve the edited documents.
 */
export const CONFIRM_DELAY_MS = 20_000;

type Confirm = (recordingId: string) => void;

const timers = new Map<string, NodeJS.Timeout>();

let confirm: Confirm = (recordingId) => {
  // One pending confirmation per recording; a later send restarts the wait.
  clearTimeout(timers.get(recordingId));
  const timer = setTimeout(() => {
    timers.delete(recordingId);
    void import("../sync/poller.js")
      .then(({ poller }) => poller.confirmRecording(recordingId))
      .catch((err: unknown) =>
        logger.warn({ recordingId, err }, "could not re-read a recording after a send to Plaud"),
      );
  }, CONFIRM_DELAY_MS);
  timer.unref();
  timers.set(recordingId, timer);
};

export function scheduleConfirmation(recordingId: string): void {
  confirm(recordingId);
}

/** Tests only. */
export function setConfirmationForTests(fn: Confirm): void {
  confirm = fn;
}
