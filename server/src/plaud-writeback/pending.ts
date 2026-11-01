import { getDb } from "../db.js";
import type { ApplaudSegment } from "../speakers/outputs.js";
import type { SpeakerSegment } from "../speakers/segments.js";
import { desiredNames, pendingChanges, pendingCount } from "./transform.js";

/**
 * Record how many segments Plaud still names differently from Applaud's
 * confirmed names. Called wherever the `-Applaud` transcript is rebuilt: after
 * analysis, a label change, a people change and every transcript resync, so
 * the count follows both Applaud and Plaud.
 */
export function recordPending(
  recordingId: string,
  segments: SpeakerSegment[],
  applaud: ApplaudSegment[],
  now: number = Date.now(),
): void {
  const d = getDb();
  const desired = desiredNames(segments, applaud);
  if (desired.size === 0) {
    d.prepare("DELETE FROM plaud_writeback WHERE recording_id = ?").run(recordingId);
    return;
  }
  d.prepare(
    `INSERT INTO plaud_writeback (recording_id, pending_segments, changes, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(recording_id) DO UPDATE SET
       pending_segments = excluded.pending_segments, changes = excluded.changes, updated_at = excluded.updated_at`,
  ).run(recordingId, pendingCount(desired), JSON.stringify(pendingChanges(desired)), now);
}
