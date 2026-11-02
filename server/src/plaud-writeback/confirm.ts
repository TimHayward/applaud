import { getDb } from "../db.js";
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

/** Spacing between the startup re-reads, so they don't all hit Plaud at once. */
const OUTSTANDING_SPACING_MS = 15_000;

/**
 * At startup: re-read recordings sent to Plaud whose count hasn't been taken
 * from a transcript downloaded since (sends made before Applaud confirmed by
 * itself, or whose confirmation was lost to a restart). Returns how many.
 */
export function confirmOutstanding(): number {
  const rows = getDb()
    .prepare(
      `SELECT recording_id FROM plaud_writeback
       WHERE last_result IN ('sent', 'partial') AND pending_segments > 0 AND last_attempt_at IS NOT NULL
         AND (pending_transcript_at IS NULL OR pending_transcript_at <= last_attempt_at)
       ORDER BY last_attempt_at DESC LIMIT 50`,
    )
    .all() as { recording_id: string }[];
  rows.forEach((r, i) => {
    const timer = setTimeout(
      () => scheduleConfirmation(r.recording_id),
      i * OUTSTANDING_SPACING_MS,
    );
    timer.unref();
  });
  if (rows.length > 0)
    logger.info({ recordings: rows.length }, "re-reading recordings sent to Plaud");
  return rows.length;
}
