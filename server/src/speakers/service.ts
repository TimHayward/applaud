import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { speakerConfig, type SpeakerConfig } from "@applaud/shared";
import { loadConfig, updateConfig } from "../config.js";
import { logger } from "../logger.js";
import { getCurrentUser } from "../plaud/client.js";
import type { Embedder } from "./embedder.js";
import { LocalEmbedder } from "./local-embedder.js";
import type { MatchThresholds } from "./matcher.js";
import { SpeakerRunner } from "./runner.js";

/** The model baked into the image (D10); `APPLAUD_SPEAKER_MODEL` overrides the path. */
export const SPEAKER_MODEL_FILE = "3dspeaker_eres2net_en_voxceleb_16k.onnx";

/** `<install root>/models/<file>`: `/app/models` in the image, `<repo>/models` in development. */
export function speakerModelPath(): string {
  if (process.env.APPLAUD_SPEAKER_MODEL) return process.env.APPLAUD_SPEAKER_MODEL;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "models", SPEAKER_MODEL_FILE);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function createEmbedder(): Embedder {
  const modelPath = speakerModelPath();
  const local = new LocalEmbedder({
    modelPath,
    allowedRoot: () => loadConfig().recordingsDir,
    threads: positiveInt(process.env.APPLAUD_SPEAKER_THREADS, 2),
    idleMs: positiveInt(process.env.APPLAUD_SPEAKER_IDLE_SEC, 300) * 1000,
    ffmpegPath: process.env.APPLAUD_FFMPEG || "ffmpeg",
  });
  return {
    async health() {
      if (!existsSync(modelPath)) {
        return {
          ok: false,
          status: "unsupported",
          reason: "this installation has no speaker model (it ships in the Docker image; set APPLAUD_SPEAKER_MODEL otherwise)",
        };
      }
      return local.health();
    },
    embed: (req) => local.embed(req),
    stop: () => local.stop(),
  };
}

let nicknameLookup: Promise<void> | null = null;

/**
 * The owner's Plaud name (D17): the Settings choice, else the Plaud account
 * nickname. Installs signed in before the nickname was recorded look it up
 * once per run.
 */
async function ownerName(): Promise<string | null> {
  const cfg = loadConfig();
  const chosen = speakerConfig(cfg).ownerName;
  if (chosen) return chosen;
  if (!cfg.plaudNickname && cfg.token) {
    nicknameLookup ??= getCurrentUser()
      .then((u) => {
        if (u.nickname) updateConfig({ plaudNickname: u.nickname });
      })
      .catch((err: unknown) => logger.warn({ err }, "could not look up the Plaud account nickname"));
    await nicknameLookup;
  }
  return loadConfig().plaudNickname;
}

export function matchThresholds(s: SpeakerConfig): MatchThresholds {
  return {
    autoThreshold: s.autoThreshold,
    autoMargin: s.autoMargin,
    minSpeechMs: s.minSpeechSec * 1000,
    suggestThreshold: s.suggestThreshold,
  };
}

let runner: SpeakerRunner | null = null;

export function speakerRunner(): SpeakerRunner {
  runner ??= new SpeakerRunner({
    embedder: createEmbedder(),
    settings: () => {
      const cfg = loadConfig();
      const s = speakerConfig(cfg);
      return {
        enabled: s.enabled,
        recordingsDir: cfg.recordingsDir,
        minSpeechMs: s.minSpeechSec * 1000,
        activeModelId: s.activeModelId,
        thresholds: matchThresholds(s),
      };
    },
    ownerName,
    setActiveModel: (modelId) => updateConfig({ speakers: { ...speakerConfig(loadConfig()), activeModelId: modelId } }),
  });
  return runner;
}

/** Hooks for the rest of the server. Each is a no-op while speaker identification is off. */
export const speakers = {
  start(): void {
    speakerRunner().start();
  },
  /** A transcript was written: (re-)analyse the recording. */
  onTranscript(recordingId: string): void {
    if (!speakerConfig(loadConfig()).enabled) return;
    speakerRunner().enqueue("analyse", recordingId);
  },
  /** After each sync: pick up recordings whose audio arrived after their transcript. */
  afterPoll(): void {
    if (!speakerConfig(loadConfig()).enabled) return;
    speakerRunner().backfill();
  },
};
