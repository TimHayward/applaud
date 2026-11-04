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
  // Which download of Plaud's transcript this count describes: a count taken
  // from a transcript older than the last send says nothing about that send.
  const synced = d
    .prepare("SELECT transcript_downloaded_at FROM recordings WHERE id = ?")
    .get(recordingId) as { transcript_downloaded_at: number | null } | undefined;
  d.prepare(
    `INSERT INTO plaud_writeback (recording_id, pending_segments, changes, pending_transcript_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(recording_id) DO UPDATE SET
       pending_segments = excluded.pending_segments, changes = excluded.changes,
       pending_transcript_at = excluded.pending_transcript_at, updated_at = excluded.updated_at`,
  ).run(
    recordingId,
    pendingCount(desired),
    JSON.stringify(pendingChanges(desired)),
    synced?.transcript_downloaded_at ?? null,
    now,
  );
}

/** Whether Plaud has every confirmed name for a recording that has any (count taken now). */
export function namesInPlaud(recordingId: string): boolean {
  const row = getDb()
    .prepare("SELECT pending_segments FROM plaud_writeback WHERE recording_id = ?")
    .get(recordingId) as { pending_segments: number } | undefined;
  return row?.pending_segments === 0;
}
