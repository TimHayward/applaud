import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { AppConfig } from "@applaud/shared";

const { loadConfig, downloadInBackground } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  downloadInBackground: vi.fn(),
}));
vi.mock("../config.js", () => ({ loadConfig }));
vi.mock("../sync/poller.js", () => ({ poller: { downloadInBackground, resyncRecording: vi.fn() } }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { recordingsRouter } from "./recordings.js";
import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { upsertFromPlaud, softDeleteRecording, getRecordingById, setAudioFilename, type PlaudRecordingMeta } from "../sync/state.js";

const RECORDING_ID = "abcdef0123456789";

function makePlaudItem(overrides: Partial<PlaudRecordingMeta> = {}): PlaudRecordingMeta {
  return {
    id: RECORDING_ID,
    filename: "Standup",
    startTime: Date.UTC(2026, 3, 11, 12, 0),
    durationMs: 60_000,
    serialNumber: "S1",
    ...overrides,
  };
}

describe("recordingsRouter", () => {
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let recordingsDir: string;

  beforeEach(async () => {
    db = setupTestDb();
    recordingsDir = mkdtempSync(path.join(tmpdir(), "applaud-recordings-test-"));

    loadConfig.mockReset();
    loadConfig.mockReturnValue({
      recordingsDir,
      historyDays: 30,
      installedAt: Date.UTC(2026, 3, 20),
    } as unknown as AppConfig);
    downloadInBackground.mockReset();

    const app = express();
    app.use(express.json());
    app.use("/api/recordings", recordingsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}/api/recordings`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(recordingsDir, { recursive: true, force: true });
    teardownTestDb(db);
  });

  it("GET / returns an empty list initially", async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("GET / rejects a non-numeric limit with 400 instead of passing NaN through", async () => {
    const res = await fetch(`${baseUrl}?limit=abc`);
    expect(res.status).toBe(400);
  });

  it("GET / rejects a limit above the 500 cap with 400", async () => {
    const res = await fetch(`${baseUrl}?limit=99999`);
    expect(res.status).toBe(400);
  });

  it("GET / lists an upserted recording", async () => {
    upsertFromPlaud(makePlaudItem());
    const res = await fetch(baseUrl);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe(RECORDING_ID);
  });

  it("GET /:id returns 404 for an unknown id", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("GET /:id returns the recording detail and omits the absolute recordingsDir path", async () => {
    upsertFromPlaud(makePlaudItem());
    const res = await fetch(`${baseUrl}/${RECORDING_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recording.id).toBe(RECORDING_ID);
    expect(body).not.toHaveProperty("recordingsDir");
    // Folder/mediaBase is "<date>_<name>__<last-8-of-id>" (see README layout).
    expect(body.mediaBase).toContain(RECORDING_ID.slice(-8));
    // Default audio filename is exposed for the player/download to reference.
    expect(body.recording.audioFilename).toBe("audio.ogg");
  });

  it("GET /:id exposes a non-ogg audioFilename recorded from the download URL", async () => {
    upsertFromPlaud(makePlaudItem());
    setAudioFilename(RECORDING_ID, "audio.mp3");
    const res = await fetch(`${baseUrl}/${RECORDING_ID}`);
    const body = await res.json();
    expect(body.recording.audioFilename).toBe("audio.mp3");
  });

  it("POST /:id/download queues a metadata-only recording for download", async () => {
    upsertFromPlaud(makePlaudItem({ startTime: Date.UTC(2026, 0, 1) }));
    expect(getRecordingById(RECORDING_ID)?.status).toBe("metadata_only");
    const res = await fetch(`${baseUrl}/${RECORDING_ID}/download`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.recording.status).toBe("pending_audio");
    expect(downloadInBackground).toHaveBeenCalledWith(RECORDING_ID);
  });

  it("POST /:id/download on an unknown id returns 404", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist/download`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(downloadInBackground).not.toHaveBeenCalled();
  });

  it("POST /:id/rename sets a display name override", async () => {
    upsertFromPlaud(makePlaudItem());
    const res = await fetch(`${baseUrl}/${RECORDING_ID}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "My Renamed Recording" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recording.displayName).toBe("My Renamed Recording");
    expect(getRecordingById(RECORDING_ID)?.displayName).toBe("My Renamed Recording");
  });

  it("POST /:id/rename with displayName: null clears the override", async () => {
    upsertFromPlaud(makePlaudItem());
    await fetch(`${baseUrl}/${RECORDING_ID}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Temporary" }),
    });
    const res = await fetch(`${baseUrl}/${RECORDING_ID}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: null }),
    });
    expect(res.status).toBe(200);
    expect(getRecordingById(RECORDING_ID)?.displayName).toBeNull();
  });

  it("POST /:id/rename on an unknown id returns 404", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /:id soft-deletes a recording", async () => {
    upsertFromPlaud(makePlaudItem());
    const del = await fetch(`${baseUrl}/${RECORDING_ID}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(getRecordingById(RECORDING_ID)?.userDeletedAt).not.toBeNull();
  });

  it("DELETE /:id on an already-trashed recording returns 400", async () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording(RECORDING_ID);
    const res = await fetch(`${baseUrl}/${RECORDING_ID}`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("POST /:id/restore restores a soft-deleted recording", async () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording(RECORDING_ID);
    const res = await fetch(`${baseUrl}/${RECORDING_ID}/restore`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(getRecordingById(RECORDING_ID)?.userDeletedAt).toBeNull();
  });

  it("POST /:id/restore on a recording not in trash returns 400", async () => {
    upsertFromPlaud(makePlaudItem());
    const res = await fetch(`${baseUrl}/${RECORDING_ID}/restore`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("POST /:id/purge permanently removes a soft-deleted recording", async () => {
    upsertFromPlaud(makePlaudItem());
    softDeleteRecording(RECORDING_ID);
    const res = await fetch(`${baseUrl}/${RECORDING_ID}/purge`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(getRecordingById(RECORDING_ID)).toBeNull();
  });

  it("POST /:id/purge on a recording not in trash returns 400", async () => {
    upsertFromPlaud(makePlaudItem());
    const res = await fetch(`${baseUrl}/${RECORDING_ID}/purge`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("POST /:id/purge on an unknown id returns 404", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist/purge`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
