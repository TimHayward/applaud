import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { FakeEmbedder } from "../test/fixtures/embedder.js";
import { EmbedderError } from "./embedder.js";
import { SpeakerRunner, describeError, type RunnerSettings } from "./runner.js";

let db: Database.Database;
let dir: string;
let embedder: FakeEmbedder;
let settings: RunnerSettings;
let owner: string | null;
let runner: SpeakerRunner;

beforeEach(() => {
  db = setupTestDb();
  dir = mkdtempSync(path.join(os.tmpdir(), "applaud-runner-"));
  embedder = new FakeEmbedder({ modelId: "m@1" });
  settings = { enabled: true, recordingsDir: dir, minSpeechMs: 20_000, activeModelId: null };
  owner = "Tim Hayward";
  runner = new SpeakerRunner({
    embedder,
    settings: () => settings,
    ownerName: async () => owner,
    setActiveModel: (id) => {
      settings = { ...settings, activeModelId: id };
    },
  });
});

afterEach(async () => {
  runner.stop();
  await runner.idle();
  teardownTestDb(db);
  rmSync(dir, { recursive: true, force: true });
});

function addRecording(id: string): void {
  const folder = `f_${id}`;
  mkdirSync(path.join(dir, folder), { recursive: true });
  writeFileSync(path.join(dir, folder, "audio.ogg"), "");
  const segs = [];
  for (let i = 0; i < 5; i++) {
    segs.push({ segment_uid: `${id}a${i}`, start_time: i * 20_000, end_time: i * 20_000 + 5_000, content: "", speaker: "Tim Hayward", original_speaker: "Speaker 1" });
    segs.push({ segment_uid: `${id}b${i}`, start_time: i * 20_000 + 10_000, end_time: i * 20_000 + 15_000, content: "", speaker: "Speaker 2", original_speaker: "Speaker 2" });
  }
  writeFileSync(path.join(dir, folder, "transcript.json"), JSON.stringify(segs));
  db.prepare(
    `INSERT INTO recordings (id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number, folder,
       audio_filename, audio_downloaded_at, transcript_downloaded_at)
     VALUES (?, 'f', 0, 1, 100000, 1, 'S', ?, 'audio.ogg', 1, 1)`,
  ).run(id, folder);
}

const jobs = (): unknown[] => db.prepare("SELECT kind, recording_id, status FROM speaker_jobs ORDER BY kind, recording_id").all();

describe("SpeakerRunner", () => {
  it("does nothing while switched off", async () => {
    settings.enabled = false;
    addRecording("r1");
    runner.start();
    await runner.idle();
    expect(runner.status().state).toBe("off");
    expect(jobs()).toEqual([]);
  });

  it("backfills on start, analyses, enrols the owner and records the model", async () => {
    addRecording("r1");
    addRecording("r2");
    runner.start();
    await runner.idle();
    expect(jobs()).toEqual([
      { kind: "analyse", recording_id: "r1", status: "done" },
      { kind: "analyse", recording_id: "r2", status: "done" },
    ]);
    expect(settings.activeModelId).toBe("m@1");
    expect(db.prepare("SELECT COUNT(*) AS n FROM speaker_embeddings WHERE source = 'plaud_owner'").get()).toEqual({ n: 2 });
    expect(runner.status()).toMatchObject({ state: "available", modelId: "m@1", queued: 0, failed: 0, current: null });
    expect(runner.status().lastRun).toMatchObject({ ok: true, recordingId: "r2" });
  });

  it("runs a job queued later", async () => {
    runner.start();
    await runner.idle();
    addRecording("r1");
    runner.enqueue("analyse", "r1");
    await runner.idle();
    expect(jobs()).toEqual([{ kind: "analyse", recording_id: "r1", status: "done" }]);
  });

  it("stays unsupported and keeps jobs queued when the host can't run the model", async () => {
    embedder = new FakeEmbedder({ health: { ok: false, status: "unsupported", reason: "no AVX" } });
    runner = new SpeakerRunner({ embedder, settings: () => settings, ownerName: async () => owner, setActiveModel: () => {} });
    addRecording("r1");
    runner.start();
    await runner.idle();
    expect(runner.status()).toMatchObject({ state: "unsupported", reason: "no AVX", queued: 1 });
  });

  it("stops on an unsupported error mid-job without using up an attempt", async () => {
    addRecording("r1");
    embedder.failNext = new EmbedderError("unsupported", "this CPU lacks an instruction");
    runner.start();
    await runner.idle();
    expect(runner.status().state).toBe("unsupported");
    expect(db.prepare("SELECT status, attempts FROM speaker_jobs").get()).toEqual({ status: "queued", attempts: 0 });
  });

  it("backs off a crashed job and re-checks after repeated crashes", async () => {
    for (const id of ["r1", "r2", "r3"]) addRecording(id);
    const health = vi.spyOn(embedder, "health");
    const embed = vi.spyOn(embedder, "embed").mockRejectedValue(new EmbedderError("crashed", "exited"));
    runner.start();
    await runner.idle();
    expect(embed).toHaveBeenCalledTimes(3);
    expect(health).toHaveBeenCalledTimes(2); // start, then after three crashes
    expect(db.prepare("SELECT status, attempts FROM speaker_jobs").all()).toEqual([
      { status: "queued", attempts: 1 },
      { status: "queued", attempts: 1 },
      { status: "queued", attempts: 1 },
    ]);
    expect(runner.status().lastRun).toMatchObject({ ok: false, error: "exited" });
  });

  it("re-embeds voiceprints when the model changes, then activates it", async () => {
    addRecording("r1");
    runner.start();
    await runner.idle();
    runner.stop();

    embedder.modelId = "m@2";
    runner.start();
    await runner.idle();
    expect(jobs()).toContainEqual({ kind: "reembed", recording_id: "r1", status: "done" });
    expect(db.prepare("SELECT DISTINCT model_id FROM speaker_embeddings").all()).toEqual([{ model_id: "m@2" }]);
    expect(settings.activeModelId).toBe("m@2");
  });

  it("relabels when the owner changes, without running the model", async () => {
    addRecording("r1");
    runner.start();
    await runner.idle();
    const requests = embedder.requests.length;
    owner = null;
    await runner.ownerChanged();
    expect(db.prepare("SELECT COUNT(*) AS n FROM speaker_embeddings").get()).toEqual({ n: 0 });
    expect(embedder.requests.length).toBe(requests);
  });

  it("keeps file paths out of error messages", () => {
    const fsErr = Object.assign(new Error("ENOENT: open '/data/recordings/2026-10-29_Secret_title/transcript.json'"), {
      code: "ENOENT",
    });
    expect(describeError(fsErr)).toBe("file error (ENOENT)");
    expect(describeError(new SyntaxError("Unexpected token"))).toBe("transcript.json is not valid JSON");
    expect(describeError(new EmbedderError("timeout", "did not answer"))).toBe("did not answer");
  });
});
