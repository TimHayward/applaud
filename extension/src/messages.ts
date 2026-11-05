import type {
  PlaudDocumentWrite,
  PlaudWritebackPlanResponse,
  PlaudWritebackRecording,
  PlaudWritebackResult,
  PlaudWritebackUndoable,
} from "@applaud/shared";
import type { BatchItem, BatchState } from "./batch.js";
import type { CardResult, Diagnosis, ReadResult } from "./plaud.js";

/** Popup → service worker. */
export type PopupRequest =
  | { type: "status" }
  | { type: "pair"; applaudUrl: string; code: string; name: string }
  | { type: "unpair" }
  | { type: "pending" }
  | { type: "undoable" }
  | { type: "dryRun"; recordingId: string }
  | { type: "apply"; recordingId: string }
  | { type: "undo"; recordingId: string }
  | { type: "sendAll"; items: BatchItem[] }
  | { type: "batchStatus" }
  | { type: "stopBatch" }
  | { type: "cardsNeeded" }
  | { type: "fetchCards" }
  | { type: "diagnose" };

export interface StatusReply {
  paired: boolean;
  applaudUrl: string | null;
  /** Null when not paired or Applaud couldn't be reached (then `error`). */
  applaud: { enabled: boolean; speakersEnabled: boolean; protocol: number } | null;
  plaudTab: boolean;
  /** Results Plaud accepted but Applaud hasn't been told about yet; sent on the next status. */
  unreported: number;
  error: string | null;
}

export interface DryRunReply {
  plan: PlaudWritebackPlanResponse;
  warnings: string[];
}

/** What a send or an undo did. */
export interface ApplyReply {
  /** `nothing` and `stale` come from the plan; nothing was written. */
  status: "applied" | "partial" | "failed" | "nothing" | "stale";
  reason: string | null;
  results: PlaudWritebackResult[];
  /** False when Applaud couldn't be told; the extension keeps the results and retries. */
  reported: boolean;
  changedSegments: number;
  summaryReplacements: number;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PopupReplies {
  status: StatusReply;
  pair: StatusReply;
  unpair: StatusReply;
  pending: PlaudWritebackRecording[];
  undoable: PlaudWritebackUndoable[];
  dryRun: DryRunReply;
  apply: ApplyReply;
  undo: ApplyReply;
  sendAll: BatchState;
  batchStatus: BatchState | null;
  stopBatch: BatchState | null;
  cardsNeeded: number;
  fetchCards: CardsReply;
  diagnose: Diagnosis;
}

/** What fetching summary cards did. */
export interface CardsReply {
  found: number;
  none: number;
  notReady: number;
  failed: number;
  /** The first problem, when one stopped or failed a fetch. */
  error: string | null;
}

/** Service worker → content script in a Plaud tab. */
export type ContentRequest =
  | { type: "plaud.read"; fileId: string }
  | { type: "plaud.write"; fileId: string; writes: PlaudDocumentWrite[] }
  | { type: "plaud.card"; fileId: string }
  | { type: "plaud.diagnose" };

export interface ContentReplies {
  "plaud.read": ReadResult;
  "plaud.write": PlaudWritebackResult[];
  "plaud.card": CardResult;
  "plaud.diagnose": Diagnosis;
}
