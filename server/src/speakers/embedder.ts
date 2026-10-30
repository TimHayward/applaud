/** A stretch of a recording to embed, in milliseconds from its start. */
export interface EmbedWindow {
  /** Caller's id for the window (a segment key); echoed back with its vector. */
  id: string;
  startMs: number;
  endMs: number;
}

export interface EmbedRequest {
  /** Absolute path of the audio file; must be inside the recordings directory. */
  audioPath: string;
  windows: EmbedWindow[];
}

export type EmbedSkipReason = "too_short" | "out_of_range";

export interface EmbedResult {
  modelId: string;
  dim: number;
  /** Seconds of audio decoded. */
  audioSeconds: number;
  elapsedMs: number;
  vectors: { id: string; vector: Float32Array }[];
  skipped: { id: string; reason: EmbedSkipReason }[];
}

export type EmbedderHealth =
  | { ok: true; modelId: string; dim: number; probeMs: number }
  /** `unsupported`: this host can't run the model. `unavailable`: it failed this time. */
  | { ok: false; status: "unsupported" | "unavailable"; reason: string };

export type EmbedderErrorCode = "unsupported" | "crashed" | "timeout" | "bad_request" | "decode_failed" | "stopped";

export class EmbedderError extends Error {
  constructor(
    readonly code: EmbedderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EmbedderError";
  }
}

/**
 * Turns stretches of a recording into speaker vectors. `LocalEmbedder` runs
 * the model in a child process; tests use `FakeEmbedder`.
 */
export interface Embedder {
  /** Load the model if needed and embed a second of silence: the capability check. */
  health(): Promise<EmbedderHealth>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
  /** Stop the model process, failing any request in flight. */
  stop(): void;
}
