import { createHash } from "node:crypto";
import type { Embedder, EmbedderHealth, EmbedRequest, EmbedResult } from "../../speakers/embedder.js";

export interface FakeEmbedderOptions {
  modelId?: string;
  dim?: number;
  /** Vector for a window; defaults to one derived from the window id. */
  vectorFor?: (id: string, req: EmbedRequest) => Float32Array;
  health?: EmbedderHealth;
}

/** Deterministic Embedder for tests: no process, no model, records each request. */
export class FakeEmbedder implements Embedder {
  readonly requests: EmbedRequest[] = [];
  /** When set, the next embed() rejects with it (then clears). */
  failNext: Error | null = null;
  modelId: string;
  readonly dim: number;

  constructor(private readonly opts: FakeEmbedderOptions = {}) {
    this.modelId = opts.modelId ?? "fake@00000000";
    this.dim = opts.dim ?? 8;
  }

  async health(): Promise<EmbedderHealth> {
    return this.opts.health ?? { ok: true, modelId: this.modelId, dim: this.dim, probeMs: 1 };
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    this.requests.push(req);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const vectorFor = this.opts.vectorFor ?? ((id: string) => hashVector(id, this.dim));
    return {
      modelId: this.modelId,
      dim: this.dim,
      audioSeconds: Math.max(...req.windows.map((w) => w.endMs)) / 1000,
      elapsedMs: 1,
      vectors: req.windows.map((w) => ({ id: w.id, vector: vectorFor(w.id, req) })),
      skipped: [],
    };
  }

  stop(): void {}
}

/** A stable pseudo-random vector for a string. */
export function hashVector(seed: string, dim: number): Float32Array {
  const bytes = createHash("sha256").update(seed).digest();
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = (bytes[i % bytes.length]! - 128) / 128;
  return v;
}
