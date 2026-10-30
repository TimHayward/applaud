// IPC between Applaud and the speaker process (embedder-process.ts). Messages
// use Node's "advanced" serialization, so Float32Arrays cross unchanged.

import type { EmbedResult, EmbedWindow } from "./embedder.js";

export const SAMPLE_RATE = 16_000;

/** Exit code of a speaker process that could not load the native module or model. */
export const EXIT_LOAD_FAILED = 3;

/** Bounds on one embed request, so a bad caller can't exhaust the child's memory. */
export const MAX_WINDOWS = 500;
export const MAX_WINDOW_MS = 30_000;
export const MAX_TOTAL_WINDOW_MS = 20 * 60_000;

/** Below this much audio a window is skipped as too short. */
export const MIN_WINDOW_SAMPLES = SAMPLE_RATE / 2;

export type ToChild =
  | { type: "probe"; id: number }
  | { type: "embed"; id: number; audioPath: string; windows: EmbedWindow[] };

/** A request before the supervisor assigns its id. */
export type ToChildRequest = ToChild extends infer T ? (T extends ToChild ? Omit<T, "id"> : never) : never;

export type FromChild =
  | { type: "ready"; modelId: string; dim: number }
  | { type: "fatal"; message: string }
  | { type: "probe"; id: number; dim: number }
  | { type: "result"; id: number; result: Omit<EmbedResult, "modelId" | "dim"> }
  | { type: "error"; id: number; code: "decode_failed" | "bad_request"; message: string };
