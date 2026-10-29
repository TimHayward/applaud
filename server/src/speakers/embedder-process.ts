// The speaker process: a child of Applaud (see local-embedder.ts) that loads
// the speaker model and embeds windows of a recording. It runs native code, so
// it lives in its own process: a crash, an illegal instruction or an
// out-of-memory kill here takes down only this process, never Applaud.
//
// Audio is decoded by ffmpeg straight into memory, only the requested windows
// are kept, and nothing is written to disk. Paths, titles and transcript text
// are never logged; this process reports to its parent over IPC only.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { EmbedResult, EmbedSkipReason, EmbedWindow } from "./embedder.js";
import { WindowCollector } from "./pcm.js";
import { EXIT_LOAD_FAILED, MIN_WINDOW_SAMPLES, SAMPLE_RATE, type FromChild, type ToChild } from "./protocol.js";

interface Stream {
  acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void;
  inputFinished(): void;
}

interface Extractor {
  readonly dim: number;
  createStream(): Stream;
  isReady(stream: Stream): boolean;
  compute(stream: Stream, enableExternalBuffer?: boolean): Float32Array;
}

function send(msg: FromChild): void {
  process.send?.(msg);
}

function loadExtractor(modelPath: string, threads: number): Extractor {
  const require = createRequire(import.meta.url);
  const sherpa = require("sherpa-onnx-node") as {
    SpeakerEmbeddingExtractor: new (config: { model: string; numThreads: number; debug: number }) => Extractor;
  };
  return new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: threads, debug: 0 });
}

/** `<file name>@<first 8 hex of its SHA-256>`: changes whenever the model file does. */
function modelIdOf(modelPath: string): string {
  const hash = createHash("sha256").update(readFileSync(modelPath)).digest("hex");
  return `${path.basename(modelPath, path.extname(modelPath))}@${hash.slice(0, 8)}`;
}

function embedSamples(extractor: Extractor, samples: Float32Array): Float32Array | null {
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.inputFinished();
  if (!extractor.isReady(stream)) return null;
  // Copy out of the native buffer so the vector can be sent over IPC.
  return extractor.compute(stream, false);
}

function decode(ffmpeg: string, audioPath: string, windows: EmbedWindow[]): Promise<WindowCollector> {
  return new Promise((resolve, reject) => {
    const collector = new WindowCollector(windows);
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", audioPath];
    args.push("-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1");
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout.on("data", (chunk: Buffer) => collector.push(chunk));
    proc.on("error", (err) => reject(new Error(`ffmpeg could not start: ${err.message}`)));
    proc.on("close", (code, signal) => {
      if (code === 0) resolve(collector);
      else reject(new Error(`ffmpeg failed (${signal ?? `exit code ${code}`})`));
    });
  });
}

async function embed(
  extractor: Extractor,
  ffmpeg: string,
  audioPath: string,
  windows: EmbedWindow[],
): Promise<Omit<EmbedResult, "modelId" | "dim">> {
  const started = Date.now();
  const collector = await decode(ffmpeg, audioPath, windows);
  const vectors: EmbedResult["vectors"] = [];
  const skipped: { id: string; reason: EmbedSkipReason }[] = [];
  for (const { id, samples } of collector.results()) {
    if (samples.length === 0) {
      skipped.push({ id, reason: "out_of_range" });
      continue;
    }
    const vector = samples.length >= MIN_WINDOW_SAMPLES ? embedSamples(extractor, samples) : null;
    if (vector) vectors.push({ id, vector });
    else skipped.push({ id, reason: "too_short" });
  }
  return { audioSeconds: collector.samplesSeen / SAMPLE_RATE, elapsedMs: Date.now() - started, vectors, skipped };
}

function main(): void {
  if (!process.send) {
    process.stderr.write("embedder-process must be started by Applaud\n");
    process.exit(1);
  }
  const modelPath = process.env.APPLAUD_SPEAKER_MODEL ?? "";
  const threads = Math.max(1, Number(process.env.APPLAUD_SPEAKER_THREADS) || 2);
  const ffmpeg = process.env.APPLAUD_FFMPEG || "ffmpeg";

  let extractor: Extractor;
  let modelId: string;
  try {
    modelId = modelIdOf(modelPath);
    extractor = loadExtractor(modelPath, threads);
  } catch (err) {
    send({ type: "fatal", message: err instanceof Error ? err.message.split("\n")[0]! : String(err) });
    process.exit(EXIT_LOAD_FAILED);
  }
  send({ type: "ready", modelId, dim: extractor.dim });

  // The parent sends one request at a time; chain anyway so a misbehaving
  // parent can't run two decodes at once.
  let chain: Promise<void> = Promise.resolve();
  process.on("message", (msg: ToChild) => {
    chain = chain.then(async () => {
      if (msg.type === "probe") {
        const v = embedSamples(extractor, new Float32Array(SAMPLE_RATE));
        send({ type: "probe", id: msg.id, dim: v?.length ?? 0 });
        return;
      }
      try {
        const result = await embed(extractor, ffmpeg, msg.audioPath, msg.windows);
        send({ type: "result", id: msg.id, result });
      } catch (err) {
        send({ type: "error", id: msg.id, code: "decode_failed", message: err instanceof Error ? err.message : String(err) });
      }
    });
  });
  // The parent went away (stopped, crashed or idled us out): exit with it.
  process.on("disconnect", () => process.exit(0));
}

main();
