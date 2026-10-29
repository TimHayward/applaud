import type { EmbedWindow } from "./embedder.js";
import { SAMPLE_RATE } from "./protocol.js";

interface Slot {
  id: string;
  start: number;
  end: number;
  buf: Float32Array;
  filled: number;
}

/**
 * Collects the samples of each requested window from a stream of 32-bit float
 * little-endian mono PCM (ffmpeg's `-f f32le`), keeping nothing else. Chunks
 * may split a sample; the remainder is carried into the next chunk.
 */
export class WindowCollector {
  private readonly slots: Slot[];
  private offset = 0;
  private carry: Buffer = Buffer.alloc(0);

  constructor(windows: EmbedWindow[], sampleRate = SAMPLE_RATE) {
    this.slots = windows.map((w) => {
      const start = Math.max(0, Math.floor((w.startMs * sampleRate) / 1000));
      const end = Math.max(start, Math.floor((w.endMs * sampleRate) / 1000));
      return { id: w.id, start, end, buf: new Float32Array(end - start), filled: 0 };
    });
  }

  push(chunk: Buffer): void {
    const data = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = data.length - (data.length % 4);
    this.carry = Buffer.from(data.subarray(whole));
    const from = this.offset;
    const to = from + whole / 4;
    for (const slot of this.slots) {
      const s = Math.max(slot.start, from);
      const e = Math.min(slot.end, to);
      for (let i = s; i < e; i++) slot.buf[i - slot.start] = data.readFloatLE((i - from) * 4);
      if (e > s) slot.filled = e - slot.start;
    }
    this.offset = to;
  }

  /** Samples decoded so far. */
  get samplesSeen(): number {
    return this.offset;
  }

  /** Each window's samples that were present in the audio (shorter if the audio ended early). */
  results(): { id: string; samples: Float32Array }[] {
    return this.slots.map((s) => ({ id: s.id, samples: s.buf.subarray(0, s.filled) }));
  }
}
