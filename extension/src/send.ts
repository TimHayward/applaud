/**
 * One send or undo for one recording (plan section 3, steps 3 to 6):
 * read Plaud, have Applaud plan, write in Plaud, report to Applaud.
 * Dependencies are passed in so the sequence can be tested without a browser.
 */
import type {
  PlaudDocument,
  PlaudDocumentWrite,
  PlaudWritebackPlanResponse,
  PlaudWritebackResult,
} from "@applaud/shared";
import type { ApplyReply } from "./messages.js";

export interface SendDeps {
  readPlaud: (fileId: string) => Promise<{ documents: PlaudDocument[] }>;
  writePlaud: (fileId: string, writes: PlaudDocumentWrite[]) => Promise<PlaudWritebackResult[]>;
  plan: (recordingId: string, documents: PlaudDocument[]) => Promise<PlaudWritebackPlanResponse>;
  undo: (recordingId: string) => Promise<PlaudWritebackPlanResponse>;
  report: (planId: string, results: PlaudWritebackResult[]) => Promise<unknown>;
  /** Keep results Applaud couldn't be told about, to send later. */
  keepUnreported: (planId: string, results: PlaudWritebackResult[]) => Promise<void>;
}

function outcome(
  writes: PlaudDocumentWrite[],
  results: PlaudWritebackResult[],
): ApplyReply["status"] {
  const applied = results.filter((r) => r.outcome === "applied").length;
  if (applied === writes.length) return "applied";
  return applied > 0 ? "partial" : "failed";
}

async function carryOut(
  deps: SendDeps,
  recordingId: string,
  plan: PlaudWritebackPlanResponse,
): Promise<ApplyReply> {
  const base = {
    changedSegments: plan.changedSegments,
    summaryReplacements: plan.summaryReplacements,
  };
  if (plan.status !== "ready" || !plan.planId || plan.documents.length === 0) {
    return {
      status: plan.status === "stale" ? "stale" : "nothing",
      reason: plan.reason,
      results: [],
      reported: true,
      ...base,
    };
  }

  let results: PlaudWritebackResult[];
  let reason: string | null = null;
  try {
    results = await deps.writePlaud(recordingId, plan.documents);
  } catch (err) {
    // The tab went away or refused before any reply. Nothing is reported as
    // applied; the next send reads Plaud afresh and completes the work (W5).
    results = [];
    reason = err instanceof Error ? err.message : String(err);
  }

  let reported = true;
  try {
    await deps.report(plan.planId, results);
  } catch {
    reported = false;
    await deps.keepUnreported(plan.planId, results);
  }
  const failed = results.find((r) => r.outcome !== "applied");
  return {
    status: outcome(plan.documents, results),
    reason: reason ?? (failed ? `${failed.kind}: ${failed.error ?? failed.outcome}` : null),
    results,
    reported,
    ...base,
  };
}

/** Send the confirmed names for one recording, from a fresh read of Plaud. */
export async function send(deps: SendDeps, recordingId: string): Promise<ApplyReply> {
  const read = await deps.readPlaud(recordingId);
  const plan = await deps.plan(recordingId, read.documents);
  return carryOut(deps, recordingId, plan);
}

/** Restore what the last send replaced; Plaud refuses it if the documents changed since (W11). */
export async function undo(deps: SendDeps, recordingId: string): Promise<ApplyReply> {
  return carryOut(deps, recordingId, await deps.undo(recordingId));
}
