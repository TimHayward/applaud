import { randomBytes } from "node:crypto";
import type {
  PlaudDocument,
  PlaudDocumentKind,
  PlaudDocumentWrite,
  PlaudWritebackChange,
  PlaudWritebackHistoryEntry,
  PlaudWritebackOutcome,
  PlaudWritebackPlanResponse,
  PlaudWritebackRecording,
  PlaudWritebackResult,
  PlaudWritebackState,
  PlaudWritebackUndoable,
} from "@applaud/shared";
import { getDb } from "../db.js";
import { applaudSegments, loadSegments } from "../speakers/outputs.js";
import { desiredNames, pendingChanges, planRecording } from "./transform.js";

/** Write order (W5): as the Plaud web app writes them. */
const ORDER: PlaudDocumentKind[] = ["transcript", "polished", "summary"];

/** The undo log keeps 30 days (W11); a plan never reported back is dropped after a day. */
export const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PLAN_RETENTION_MS = 24 * 60 * 60 * 1000;

type LastResult = "sent" | "partial" | "failed" | "stale";

interface WritebackRow {
  recording_id: string;
  pending_segments: number;
  changes: string;
  last_result: LastResult | null;
  last_attempt_at: number | null;
  last_error: string | null;
  filename: string;
  display_name: string | null;
  start_time: number;
  transcript_downloaded_at: number | null;
}

const SELECT_ROWS = `
  SELECT w.recording_id, w.pending_segments, w.changes, w.last_result, w.last_attempt_at, w.last_error,
         r.filename, r.display_name, r.start_time, r.transcript_downloaded_at
  FROM plaud_writeback w JOIN recordings r ON r.id = w.recording_id
  WHERE r.user_deleted_at IS NULL`;

/**
 * Where a recording stands. A result older than the latest transcript sync no
 * longer describes Plaud, so the counts from that sync decide (W7).
 */
export function stateOf(
  row: Pick<
    WritebackRow,
    "pending_segments" | "last_result" | "last_attempt_at" | "transcript_downloaded_at"
  >,
): PlaudWritebackState {
  if (row.pending_segments === 0) return "in_plaud";
  const syncedSince =
    row.last_attempt_at !== null && (row.transcript_downloaded_at ?? 0) > row.last_attempt_at;
  if (row.last_result === null || syncedSince) return "to_send";
  if (row.last_result === "sent") return "sent";
  if (row.last_result === "partial") return "partial";
  if (row.last_result === "stale") return "stale";
  return "to_send";
}

function toRecording(row: WritebackRow): PlaudWritebackRecording {
  let changes: PlaudWritebackChange[] = [];
  try {
    changes = JSON.parse(row.changes) as PlaudWritebackChange[];
  } catch {
    /* rebuilt on the next refresh */
  }
  return {
    recordingId: row.recording_id,
    title: row.display_name || row.filename,
    startTime: row.start_time,
    pendingSegments: row.pending_segments,
    changes,
    state: stateOf(row),
    lastAttemptAt: row.last_attempt_at,
    lastError: row.last_error,
  };
}

/** Recordings Plaud is still missing names for, newest first. */
export function listPending(): PlaudWritebackRecording[] {
  const rows = getDb()
    .prepare(`${SELECT_ROWS} AND w.pending_segments > 0 ORDER BY r.start_time DESC`)
    .all() as WritebackRow[];
  return rows.map(toRecording);
}

/** Pending segment counts by recording id, for the dashboard. */
export function pendingCounts(): Record<string, number> {
  return Object.fromEntries(listPending().map((r) => [r.recordingId, r.pendingSegments]));
}

export function getRecording(recordingId: string): PlaudWritebackRecording | null {
  const row = getDb().prepare(`${SELECT_ROWS} AND w.recording_id = ?`).get(recordingId) as
    WritebackRow | undefined;
  return row ? toRecording(row) : null;
}

export function history(recordingId: string, limit = 30): PlaudWritebackHistoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT plan_id, kind, outcome, undo_of, undone_at, error, created_at, updated_at
       FROM plaud_writeback_log WHERE recording_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(recordingId, limit) as {
    plan_id: string;
    kind: PlaudDocumentKind;
    outcome: PlaudWritebackOutcome;
    undo_of: number | null;
    undone_at: number | null;
    error: string | null;
    created_at: number;
    updated_at: number;
  }[];
  return rows.map((r) => ({
    planId: r.plan_id,
    kind: r.kind,
    outcome: r.outcome,
    undo: r.undo_of !== null,
    undone: r.undone_at !== null,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * Recordings whose most recent send can still be undone (W11): the newest
 * plan with an applied write not yet undone, within the log's 30 days.
 */
export function undoable(): PlaudWritebackUndoable[] {
  const rows = getDb()
    .prepare(
      `SELECT l.recording_id, MAX(l.updated_at) AS sent_at, r.filename, r.display_name
       FROM plaud_writeback_log l JOIN recordings r ON r.id = l.recording_id
       WHERE l.outcome = 'applied' AND l.undo_of IS NULL AND l.undone_at IS NULL
         AND l.new_version IS NOT NULL AND r.user_deleted_at IS NULL
       GROUP BY l.recording_id ORDER BY sent_at DESC LIMIT 50`,
    )
    .all() as {
    recording_id: string;
    sent_at: number;
    filename: string;
    display_name: string | null;
  }[];
  return rows.map((r) => ({
    recordingId: r.recording_id,
    title: r.display_name || r.filename,
    sentAt: r.sent_at,
  }));
}

export function prune(now: number = Date.now()): void {
  const d = getDb();
  d.prepare("DELETE FROM plaud_writeback_log WHERE outcome = 'planned' AND created_at < ?").run(
    now - PLAN_RETENTION_MS,
  );
  d.prepare("DELETE FROM plaud_writeback_log WHERE created_at < ?").run(now - LOG_RETENTION_MS);
}

function setResult(
  recordingId: string,
  result: LastResult,
  error: string | null,
  now: number,
): void {
  getDb()
    .prepare(
      "UPDATE plaud_writeback SET last_result = ?, last_error = ?, last_attempt_at = ? WHERE recording_id = ?",
    )
    .run(result, error, now, recordingId);
}

export type PlanOutcome =
  { ok: true; body: PlaudWritebackPlanResponse } | { ok: false; code: number; error: string };

function validateDocuments(docs: PlaudDocument[]): string | null {
  const kinds = new Set<string>();
  for (const doc of docs) {
    if (kinds.has(doc.kind)) return `more than one ${doc.kind} document`;
    kinds.add(doc.kind);
  }
  return null;
}

/**
 * Build the documents to write for one recording from Plaud's current ones
 * (section 3, step 3), and log them as planned with their previous content.
 */
export function createPlan(
  recordingsDir: string,
  recordingId: string,
  clientId: number | null,
  docs: PlaudDocument[],
  now: number = Date.now(),
  opts: { dryRun?: boolean } = {},
): PlanOutcome {
  const invalid = validateDocuments(docs);
  if (invalid) return { ok: false, code: 400, error: invalid };
  const loaded = loadSegments(recordingsDir, recordingId);
  if (!loaded)
    return { ok: false, code: 409, error: "Applaud has no transcript for this recording yet" };
  const desired = desiredNames(loaded.segments, applaudSegments(recordingId, loaded.segments));
  const changes = pendingChanges(desired);
  const empty = { documents: [], changes, changedSegments: 0, summaryReplacements: 0 };
  if (desired.size === 0) {
    return {
      ok: true,
      body: { planId: null, status: "nothing", reason: "no confirmed names", ...empty },
    };
  }

  if (!opts.dryRun) prune(now);
  const plan = planRecording(desired, docs);
  if (plan.status === "stale") {
    if (!opts.dryRun) setResult(recordingId, "stale", plan.reason, now);
    return { ok: true, body: { planId: null, status: "stale", reason: plan.reason, ...empty } };
  }
  if (plan.status === "nothing") {
    return {
      ok: true,
      body: { planId: null, status: "nothing", reason: "Plaud already has these names", ...empty },
    };
  }

  const byKind = new Map(docs.map((d) => [d.kind, d]));
  const writes: PlaudDocumentWrite[] = ORDER.flatMap((kind) => {
    const content = plan.documents.get(kind);
    const source = byKind.get(kind);
    return content === undefined || !source
      ? []
      : [
          {
            kind,
            objectId: source.objectId,
            contentId: source.contentId,
            originVersion: source.version,
            content,
          },
        ];
  });
  const summary = {
    status: "ready" as const,
    reason: null,
    documents: writes,
    changes,
    changedSegments: plan.changedSegments,
    summaryReplacements: plan.summaryReplacements,
  };
  // A dry run (section 6, Phase 2) shows the changes and records nothing.
  if (opts.dryRun) return { ok: true, body: { planId: null, ...summary } };

  const planId = randomBytes(12).toString("hex");
  const insert = getDb().prepare(
    `INSERT INTO plaud_writeback_log (plan_id, recording_id, client_id, kind, object_id, content_id, origin_version,
       previous_content, new_content, outcome, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
  );
  getDb().transaction(() => {
    for (const w of writes) {
      const source = byKind.get(w.kind)!;
      insert.run(
        planId,
        recordingId,
        clientId,
        w.kind,
        w.objectId,
        w.contentId,
        w.originVersion,
        source.content,
        w.content,
        now,
        now,
      );
    }
  })();
  return { ok: true, body: { planId, ...summary } };
}

interface LogRow {
  id: number;
  recording_id: string;
  kind: PlaudDocumentKind;
  outcome: PlaudWritebackOutcome;
  undo_of: number | null;
}

export type ResultsOutcome =
  { ok: true; recordingId: string; applied: number } | { ok: false; code: number; error: string };

/**
 * Record what the extension did with a plan (section 3, step 6). Documents
 * the extension did not report were not written: they are marked abandoned,
 * and a later run completes them (W5).
 */
export function recordResults(
  planId: string,
  results: PlaudWritebackResult[],
  now: number = Date.now(),
): ResultsOutcome {
  const d = getDb();
  const rows = d
    .prepare(
      "SELECT id, recording_id, kind, outcome, undo_of FROM plaud_writeback_log WHERE plan_id = ? ORDER BY id",
    )
    .all(planId) as LogRow[];
  if (rows.length === 0) return { ok: false, code: 404, error: "unknown plan" };
  if (rows.some((r) => r.outcome !== "planned"))
    return { ok: false, code: 409, error: "results for this plan were already recorded" };
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  for (const r of results) {
    if (!byKind.has(r.kind))
      return { ok: false, code: 400, error: `the plan has no ${r.kind} document` };
  }
  if (new Set(results.map((r) => r.kind)).size !== results.length) {
    return { ok: false, code: 400, error: "a document is reported twice" };
  }

  const reported = new Map(results.map((r) => [r.kind, r]));
  const update = d.prepare(
    "UPDATE plaud_writeback_log SET outcome = ?, new_version = ?, error = ?, updated_at = ? WHERE id = ?",
  );
  const markUndone = d.prepare("UPDATE plaud_writeback_log SET undone_at = ? WHERE id = ?");
  let applied = 0;
  let firstError: string | null = null;
  d.transaction(() => {
    for (const row of rows) {
      const r = reported.get(row.kind);
      if (!r) {
        update.run("abandoned", null, null, now, row.id);
        continue;
      }
      const error =
        r.outcome === "applied"
          ? null
          : (r.error?.slice(0, 500) ??
            (r.outcome === "conflict"
              ? "Plaud's document changed since it was read"
              : "write failed"));
      update.run(
        r.outcome,
        r.outcome === "applied" ? (r.newVersion ?? null) : null,
        error,
        now,
        row.id,
      );
      if (r.outcome === "applied") {
        applied += 1;
        if (row.undo_of !== null) markUndone.run(now, row.undo_of);
      } else {
        firstError ??= `${row.kind}: ${error}`;
      }
    }
  })();

  const recordingId = rows[0]!.recording_id;
  if (applied === rows.length) setResult(recordingId, "sent", null, now);
  else
    setResult(
      recordingId,
      applied > 0 ? "partial" : "failed",
      firstError ?? "not every document was written",
      now,
    );
  return { ok: true, recordingId, applied };
}

/**
 * Documents that restore the most recent write-back still in force (W11).
 * Each is sent with the version Plaud gave the write being undone, so Plaud
 * refuses it if the document changed since.
 */
export function createUndo(
  recordingId: string,
  clientId: number | null,
  now: number = Date.now(),
): PlanOutcome {
  const d = getDb();
  const latest = d
    .prepare(
      `SELECT plan_id FROM plaud_writeback_log
       WHERE recording_id = ? AND outcome = 'applied' AND undo_of IS NULL AND undone_at IS NULL AND new_version IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(recordingId) as { plan_id: string } | undefined;
  if (!latest) return { ok: false, code: 404, error: "nothing to undo" };
  const rows = d
    .prepare(
      `SELECT id, kind, object_id, content_id, previous_content, new_content, new_version FROM plaud_writeback_log
       WHERE plan_id = ? AND outcome = 'applied' AND undone_at IS NULL AND new_version IS NOT NULL`,
    )
    .all(latest.plan_id) as {
    id: number;
    kind: PlaudDocumentKind;
    object_id: string;
    content_id: string;
    previous_content: string;
    new_content: string;
    new_version: number;
  }[];

  prune(now);
  const planId = randomBytes(12).toString("hex");
  const insert = d.prepare(
    `INSERT INTO plaud_writeback_log (plan_id, recording_id, client_id, kind, object_id, content_id, origin_version,
       previous_content, new_content, outcome, undo_of, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)`,
  );
  const writes: PlaudDocumentWrite[] = [];
  d.transaction(() => {
    for (const kind of ORDER) {
      const r = rows.find((x) => x.kind === kind);
      if (!r) continue;
      insert.run(
        planId,
        recordingId,
        clientId,
        kind,
        r.object_id,
        r.content_id,
        r.new_version,
        r.new_content,
        r.previous_content,
        r.id,
        now,
        now,
      );
      writes.push({
        kind,
        objectId: r.object_id,
        contentId: r.content_id,
        originVersion: r.new_version,
        content: r.previous_content,
      });
    }
  })();
  return {
    ok: true,
    body: {
      planId,
      status: "ready",
      reason: null,
      documents: writes,
      changes: [],
      changedSegments: 0,
      summaryReplacements: 0,
    },
  };
}
