import type { PlaudWritebackPlanResponse, PlaudWritebackRecording } from "@applaud/shared";
import type { Diagnosis, ReadResult } from "./plaud.js";

/** Popup → service worker. */
export type PopupRequest =
  | { type: "status" }
  | { type: "pair"; applaudUrl: string; code: string; name: string }
  | { type: "unpair" }
  | { type: "pending" }
  | { type: "dryRun"; recordingId: string }
  | { type: "diagnose" };

export interface StatusReply {
  paired: boolean;
  applaudUrl: string | null;
  /** Null when not paired or Applaud couldn't be reached (then `error`). */
  applaud: { enabled: boolean; speakersEnabled: boolean; protocol: number } | null;
  plaudTab: boolean;
  error: string | null;
}

export interface DryRunReply {
  plan: PlaudWritebackPlanResponse;
  warnings: string[];
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PopupReplies {
  status: StatusReply;
  pair: StatusReply;
  unpair: StatusReply;
  pending: PlaudWritebackRecording[];
  dryRun: DryRunReply;
  diagnose: Diagnosis;
}

/** Service worker → content script in a Plaud tab. Read only in Phase 2. */
export type ContentRequest = { type: "plaud.read"; fileId: string } | { type: "plaud.diagnose" };

export interface ContentReplies {
  "plaud.read": ReadResult;
  "plaud.diagnose": Diagnosis;
}
