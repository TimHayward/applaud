import { getDb } from "../db.js";

export type JobKind = "analyse" | "reembed";

export interface SpeakerJob {
  kind: JobKind;
  recordingId: string;
  attempts: number;
}

/** Back-off after each failed attempt; a job fails for good after the last. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

/** Queue a job, or re-queue it from scratch; (kind, recording) is the de-duplication key. */
export function enqueueJob(kind: JobKind, recordingId: string, now = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO speaker_jobs (kind, recording_id, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, ?, ?, ?)
       ON CONFLICT (kind, recording_id) DO UPDATE SET
         status = 'queued', attempts = 0, next_attempt_at = excluded.next_attempt_at,
         last_error = NULL, updated_at = excluded.updated_at`,
    )
    .run(kind, recordingId, now, now, now);
}

/**
 * Queue analysis for every recording with audio and a transcript on disk
 * that has never been analysed: new ones, and ones whose last job ended
 * before both files were there. Queued and failed jobs are left alone.
 * Returns how many were queued.
 */
export function enqueueBackfill(now = Date.now()): number {
  return getDb()
    .prepare(
      `INSERT INTO speaker_jobs (kind, recording_id, status, attempts, next_attempt_at, created_at, updated_at)
       SELECT 'analyse', id, 'queued', 0, ?, ?, ? FROM recordings
       WHERE audio_downloaded_at IS NOT NULL AND transcript_downloaded_at IS NOT NULL
         AND speakers_processed_at IS NULL AND user_deleted_at IS NULL AND is_trash = 0
       ON CONFLICT (kind, recording_id) DO UPDATE SET
         status = 'queued', attempts = 0, next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at
       WHERE speaker_jobs.status = 'done'`,
    )
    .run(now, now, now).changes;
}

/** Mark the next due job running and return it. Re-embedding goes first: matching waits on it. */
export function claimNextJob(now = Date.now()): SpeakerJob | null {
  const d = getDb();
  return d.transaction((): SpeakerJob | null => {
    const row = d
      .prepare(
        `SELECT kind, recording_id, attempts FROM speaker_jobs
         WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY kind = 'reembed' DESC, created_at ASC LIMIT 1`,
      )
      .get(now) as { kind: JobKind; recording_id: string; attempts: number } | undefined;
    if (!row) return null;
    d.prepare("UPDATE speaker_jobs SET status = 'running', updated_at = ? WHERE kind = ? AND recording_id = ?").run(
      now,
      row.kind,
      row.recording_id,
    );
    return { kind: row.kind, recordingId: row.recording_id, attempts: row.attempts };
  })();
}

export function completeJob(job: SpeakerJob, now = Date.now()): void {
  getDb()
    .prepare(
      `UPDATE speaker_jobs SET status = 'done', last_error = NULL, next_attempt_at = NULL, updated_at = ?
       WHERE kind = ? AND recording_id = ? AND status = 'running'`,
    )
    .run(now, job.kind, job.recordingId);
}

/**
 * Record a failed attempt: back off and retry, or fail for good after
 * MAX_ATTEMPTS. `countAttempt: false` re-queues without using up an attempt
 * (the failure was the host's, not the job's).
 */
export function failJob(job: SpeakerJob, error: string, opts: { countAttempt?: boolean } = {}, now = Date.now()): void {
  const attempts = job.attempts + (opts.countAttempt === false ? 0 : 1);
  const final = attempts >= MAX_ATTEMPTS;
  const delay = opts.countAttempt === false ? BACKOFF_MS[0]! : BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;
  getDb()
    .prepare(
      `UPDATE speaker_jobs SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE kind = ? AND recording_id = ? AND status = 'running'`,
    )
    .run(final ? "failed" : "queued", attempts, final ? null : now + delay, error.slice(0, 500), now, job.kind, job.recordingId);
}

/** Jobs left running by a crash or restart go back in the queue. */
export function requeueRunning(now = Date.now()): void {
  getDb()
    .prepare("UPDATE speaker_jobs SET status = 'queued', next_attempt_at = ?, updated_at = ? WHERE status = 'running'")
    .run(now, now);
}

/** When the next queued job becomes due (epoch ms), or null when none is queued. */
export function nextDueAt(): number | null {
  const row = getDb()
    .prepare("SELECT MIN(COALESCE(next_attempt_at, 0)) AS at FROM speaker_jobs WHERE status = 'queued'")
    .get() as { at: number | null };
  return row.at;
}

export function jobCounts(): { queued: number; failed: number } {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM speaker_jobs WHERE status IN ('queued', 'running', 'failed') GROUP BY status")
    .all() as { status: string; n: number }[];
  const n = (s: string): number => rows.find((r) => r.status === s)?.n ?? 0;
  return { queued: n("queued") + n("running"), failed: n("failed") };
}

export function pendingJobs(kind: JobKind): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM speaker_jobs WHERE kind = ? AND status IN ('queued', 'running')")
      .get(kind) as { n: number }
  ).n;
}
