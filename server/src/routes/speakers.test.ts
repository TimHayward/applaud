import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { DEFAULT_SPEAKER_CONFIG, type RecordingSpeakersResponse, type SetSpeakerLabelResponse } from "@applaud/shared";

const { loadConfig, runner } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  runner: {
    labelsChanged: vi.fn(async () => {}),
    peopleChanged: vi.fn(),
    enqueue: vi.fn(),
    status: vi.fn(),
    check: vi.fn(),
  },
}));
vi.mock("../config.js", () => ({ loadConfig }));
vi.mock("../speakers/service.js", () => ({ speakerRunner: () => runner }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { toBlob } from "../speakers/vectors.js";
import { speakersRouter } from "./speakers.js";

describe("speakersRouter", () => {
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let dir: string;

  const call = (method: string, url: string, body?: unknown): Promise<globalThis.Response> =>
    fetch(`${baseUrl}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const enable = (enabled: boolean): void => {
    loadConfig.mockReturnValue({
      recordingsDir: dir,
      speakers: { ...DEFAULT_SPEAKER_CONFIG, enabled, activeModelId: "m@1" },
    });
  };

  beforeEach(async () => {
    db = setupTestDb();
    dir = mkdtempSync(path.join(tmpdir(), "applaud-speakers-route-"));
    mkdirSync(path.join(dir, "f1"));
    writeFileSync(
      path.join(dir, "f1", "transcript.json"),
      JSON.stringify([
        { segment_uid: "u1", start_time: 0, end_time: 4_000, content: "Hi", speaker: "Speaker 1", original_speaker: "Speaker 1" },
      ]),
    );
    db.prepare(
      `INSERT INTO recordings (id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number, folder,
         audio_filename, audio_downloaded_at, transcript_downloaded_at, speakers_processed_at)
       VALUES ('r1', 'f', 0, 1, 4000, 1, 'S', 'f1', 'audio.ogg', 1, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO recording_speakers (recording_id, plaud_label, plaud_name, status, speech_ms, segment_keys, centroid, model_id, updated_at)
       VALUES ('r1', 'Speaker 1', 'Speaker 1', 'unknown', 30000, '["u1"]', ?, 'm@1', 0)`,
    ).run(toBlob(new Float32Array([1, 0, 0])));
    enable(true);
    runner.labelsChanged.mockClear();
    runner.peopleChanged.mockClear();
    runner.enqueue.mockClear();

    const app = express();
    app.use(express.json());
    app.use("/api", speakersRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    teardownTestDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists a recording's labels without voiceprints", async () => {
    const res = await call("GET", "/recordings/r1/speakers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecordingSpeakersResponse;
    expect(body).toMatchObject({ enabled: true, analysed: true, overrides: {}, people: [] });
    expect(body.labels).toEqual([
      {
        plaudLabel: "Speaker 1",
        plaudName: "Speaker 1",
        status: "unknown",
        assignedBy: null,
        speakerId: null,
        speakerName: null,
        confidence: null,
        margin: null,
        speechMs: 30_000,
        candidates: [],
        clips: [{ segmentKey: "u1", startMs: 0, endMs: 4_000, text: "Hi" }],
        segments: 1,
      },
    ]);
    expect(body.segments).toEqual([
      {
        key: "u1",
        startMs: 0,
        endMs: 4_000,
        text: "Hi",
        speaker: "Speaker 1",
        speakerId: null,
        plaudSpeaker: "Speaker 1",
        plaudLabel: "Speaker 1",
        status: "unknown",
        suggestedSpeaker: null,
        override: false,
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/centroid|vector/);
  });

  it("confirms a label by name and refreshes the recording", async () => {
    const res = await call("PUT", `/recordings/r1/speakers/${encodeURIComponent("Speaker 1")}`, {
      status: "confirmed",
      person: { name: "Ann" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetSpeakerLabelResponse;
    expect(body.voiceprint).toBe("added");
    expect(body.labels[0]).toMatchObject({ status: "confirmed", assignedBy: "user", speakerName: "Ann" });
    expect(body.people).toEqual([
      { id: 1, name: "Ann", isOwner: false, voiceprints: 1, recordings: 1, lowResemblance: 0 },
    ]);
    expect(body.segments[0]).toMatchObject({ speaker: "Ann", speakerId: 1, status: "confirmed" });
    expect(runner.labelsChanged).toHaveBeenCalledWith("r1");
  });

  it("renames, merges and deletes people, refreshing outputs each time", async () => {
    db.prepare("INSERT INTO speakers (id, name, created_at, updated_at) VALUES (1, 'Ann', 0, 0), (2, 'Annie', 0, 0)").run();
    const renamed = await call("PATCH", "/speakers/people/1", { name: "Ann Lee" });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { people: { name: string }[] }).people.map((p) => p.name)).toEqual([
      "Ann Lee",
      "Annie",
    ]);
    expect((await call("POST", "/speakers/people/2/merge", { intoId: 1 })).status).toBe(200);
    expect((await call("DELETE", "/speakers/people/1")).status).toBe(200);
    expect(runner.peopleChanged).toHaveBeenCalledTimes(3);
    expect((await call("DELETE", "/speakers/people/1")).status).toBe(404);
    expect((await call("PATCH", "/speakers/people/abc", { name: "X" })).status).toBe(400);
  });

  it("counts labels to review", async () => {
    expect(await (await call("GET", "/speakers/review")).json()).toEqual({ enabled: true, recordings: { r1: 1 } });
  });

  it("validates label changes", async () => {
    expect((await call("PUT", "/recordings/r1/speakers/Speaker%201", { status: "maybe" })).status).toBe(400);
    expect(
      (await call("PUT", "/recordings/r1/speakers/Speaker%201", { status: "confirmed", person: { name: "Speaker 4" } }))
        .status,
    ).toBe(400);
    expect((await call("PUT", "/recordings/r1/speakers/Speaker%209", { status: "ignored" })).status).toBe(404);
    expect((await call("PUT", "/recordings/nope/speakers/Speaker%201", { status: "ignored" })).status).toBe(404);
    expect(runner.labelsChanged).not.toHaveBeenCalled();
  });

  it("overrides a known segment and rejects an unknown one", async () => {
    const res = await call("PUT", "/recordings/r1/segments/u1/speaker", { person: { name: "Bob" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RecordingSpeakersResponse).overrides).toEqual({ u1: 1 });
    expect((await call("PUT", "/recordings/r1/segments/zz/speaker", { person: { name: "Bob" } })).status).toBe(404);
    const cleared = await call("PUT", "/recordings/r1/segments/u1/speaker", { person: null });
    expect(((await cleared.json()) as RecordingSpeakersResponse).overrides).toEqual({});
  });

  it("is a no-op while switched off", async () => {
    enable(false);
    expect(await (await call("GET", "/recordings/r1/speakers")).json()).toEqual({
      enabled: false,
      analysed: false,
      labels: [],
      overrides: {},
      people: [],
      segments: [],
    });
    expect((await call("PUT", "/recordings/r1/speakers/Speaker%201", { status: "ignored" })).status).toBe(409);
    expect((await call("DELETE", "/speakers/people/1")).status).toBe(409);
    expect((await call("POST", "/recordings/r1/speakers/reanalyse")).status).toBe(409);
  });
});
