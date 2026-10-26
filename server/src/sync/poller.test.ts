import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { AppConfig } from "@applaud/shared";
import path from "node:path";
import type { PlaudFileDetail, PlaudFileSummary } from "../plaud/client.js";

const { loadConfig, updateConfig } = vi.hoisted(() => ({ loadConfig: vi.fn(), updateConfig: vi.fn() }));
const fsMocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn((p: string): boolean => Boolean(p) && false),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
}));
const clientMocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  getFile: vi.fn(),
  downloadToFile: vi.fn(),
  fetchContentText: vi.fn(),
}));
const webhookMocks = vi.hoisted(() => ({ fireWebhookForRecording: vi.fn() }));

vi.mock("../config.js", () => ({ loadConfig, updateConfig }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, ...fsMocks };
});
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../plaud/client.js", async () => {
  const actual = await vi.importActual<typeof import("../plaud/client.js")>("../plaud/client.js");
  return {
    ...actual,
    listFiles: clientMocks.listFiles,
    getFile: clientMocks.getFile,
    downloadToFile: clientMocks.downloadToFile,
    // Inline content wins; linked content comes from the mock.
    loadBlockContent: async (b: { data_content?: string; data_link?: string }) =>
      b.data_content ? b.data_content : b.data_link ? clientMocks.fetchContentText(b.data_link) : "",
  };
});
vi.mock("../webhook/post.js", () => webhookMocks);
vi.mock("./events.js", () => ({ emit: vi.fn() }));

import { noteFileName, poller, stripSignedLinks, toRecordingMeta } from "./poller.js";
import { getRecordingById, requestDownload, upsertFromPlaud } from "./state.js";
import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { POLLER_LIST_PAGE_SIZE, POLLER_RUN_WATCHDOG_MS } from "../constants.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const baseConfig: AppConfig = {
  version: 2,
  setupComplete: true,
  token: "token",
  tokenExp: null,
  tokenEmail: null,
  refreshToken: "refresh",
  refreshTokenExp: null,
  plaudClientId: "client",
  plaudRedirectUri: "http://127.0.0.1:44471/api/auth/plaud/callback",
  plaudConnectedAt: null,
  recordingsDir: "/test/recordings",
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  publicBaseUrl: null,
  lanToken: null,
  historyDays: 30,
  installedAt: NOW,
  libraryIndexedAt: null,
};

/** Plaud's timestamp format: UTC without a zone suffix. */
function plaudTime(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "");
}

function listed(id: string, startMs: number, over: Partial<PlaudFileSummary> = {}): PlaudFileSummary {
  return {
    id,
    name: `Recording ${id}`,
    created_at: plaudTime(startMs),
    start_at: plaudTime(startMs),
    duration: 60_000,
    serial_number: null,
    ...over,
  };
}

const SEGMENTS = JSON.stringify([
  { start_time: 0, end_time: 1000, content: "Hello.", speaker: "Speaker 1", original_speaker: "Speaker 1" },
]);

function detail(id: string, startMs: number, over: Partial<PlaudFileDetail> = {}): PlaudFileDetail {
  return {
    ...listed(id, startMs),
    presigned_url: `https://bucket.s3.amazonaws.com/audiofiles/${id}/o_1.ogg?X-Amz-Expires=3600`,
    source_list: [
      { data_id: "o_trans0001", data_type: "transaction", data_content: SEGMENTS, data_link: "https://bucket.s3.amazonaws.com/t.json.gz" },
      { data_id: "o_polish001", data_type: "transaction_polish", data_content: "", data_link: "https://bucket.s3.amazonaws.com/p.json.gz" },
      { data_id: "o_outline01", data_type: "outline", data_content: '[{"start_time":0,"end_time":1,"topic":"Intro"}]' },
    ],
    note_list: [
      { data_id: "o_summary01", data_type: "auto_sum_note", data_tab_name: "Summary", data_content: "# Summary\n\nAgreed things." },
      { data_id: "o_minutes99", data_type: "consumer_note", data_tab_name: "Meeting minutes", data_content: "Minutes body" },
    ],
    ...over,
  };
}

/** Final destinations written via writeFileAtomic (temp file + rename). */
function writtenFiles(): string[] {
  return fsMocks.renameSync.mock.calls.map((c) => path.basename(String(c[1])));
}

describe("poller", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
    loadConfig.mockReset();
    loadConfig.mockReturnValue(baseConfig);
    updateConfig.mockReset();
    for (const m of Object.values(fsMocks)) m.mockReset();
    fsMocks.existsSync.mockReturnValue(false);
    clientMocks.listFiles.mockReset();
    clientMocks.listFiles.mockResolvedValue([]);
    clientMocks.getFile.mockReset();
    clientMocks.downloadToFile.mockReset();
    clientMocks.downloadToFile.mockResolvedValue(4096);
    clientMocks.fetchContentText.mockReset();
    clientMocks.fetchContentText.mockResolvedValue('[{"content":"polished"}]');
    webhookMocks.fireWebhookForRecording.mockReset();
    webhookMocks.fireWebhookForRecording.mockResolvedValue(true);
  });

  afterEach(() => {
    teardownTestDb(db);
  });

  describe("history window", () => {
    it("downloads recordings inside the window and only indexes older ones", async () => {
      const recent = NOW - 2 * DAY;
      const old = NOW - 90 * DAY;
      clientMocks.listFiles.mockResolvedValueOnce([listed("f_recent0001", recent), listed("f_old0000001", old)]);
      clientMocks.getFile.mockImplementation(async (id: string) => detail(id, id === "f_recent0001" ? recent : old));

      await poller.trigger();

      expect(clientMocks.getFile).toHaveBeenCalledTimes(1);
      expect(clientMocks.getFile).toHaveBeenCalledWith("f_recent0001");
      const recentRow = getRecordingById("f_recent0001")!;
      expect(recentRow.audioDownloadedAt).not.toBeNull();
      expect(recentRow.transcriptDownloadedAt).not.toBeNull();
      expect(recentRow.summaryDownloadedAt).not.toBeNull();
      expect(recentRow.status).toBe("complete");

      const oldRow = getRecordingById("f_old0000001")!;
      expect(oldRow.audioDownloadedAt).toBeNull();
      expect(oldRow.status).toBe("metadata_only");
    });

    it("downloads an older recording once the user requests it", async () => {
      const old = NOW - 90 * DAY;
      upsertFromPlaud(toRecordingMeta(listed("f_old0000001", old))!);
      clientMocks.getFile.mockResolvedValue(detail("f_old0000001", old));

      expect(requestDownload("f_old0000001")?.status).toBe("pending_audio");
      await poller.trigger();

      expect(clientMocks.getFile).toHaveBeenCalledWith("f_old0000001");
      expect(getRecordingById("f_old0000001")?.status).toBe("complete");
    });

    it("widening the window brings older recordings into scope", async () => {
      const old = NOW - 90 * DAY;
      upsertFromPlaud(toRecordingMeta(listed("f_old0000001", old))!);
      clientMocks.getFile.mockResolvedValue(detail("f_old0000001", old));
      loadConfig.mockReturnValue({ ...baseConfig, historyDays: 120 });

      await poller.trigger();

      expect(clientMocks.getFile).toHaveBeenCalledWith("f_old0000001");
    });
  });

  describe("downloaded files", () => {
    const ID = "f_recent0001";
    const START = NOW - DAY;

    beforeEach(() => {
      clientMocks.listFiles.mockResolvedValueOnce([listed(ID, START)]);
      clientMocks.getFile.mockResolvedValue(detail(ID, START));
    });

    it("writes audio, transcript, extra blocks, summary and other notes", async () => {
      await poller.trigger();

      expect(clientMocks.downloadToFile).toHaveBeenCalledWith(
        expect.stringContaining("o_1.ogg"),
        expect.stringMatching(/audio\.ogg$/),
      );
      expect(writtenFiles()).toEqual(
        expect.arrayContaining([
          "metadata.json",
          "transcript.json",
          "transcript.txt",
          "transcript_polished.json",
          "outline.json",
          "summary.md",
          "Meeting_minutes__consumer_note__inutes99.md",
        ]),
      );
      // Linked content (the polished transcript) was fetched; inline content was not.
      expect(clientMocks.fetchContentText).toHaveBeenCalledTimes(1);
    });

    it("never stores the pre-signed links in metadata.json", async () => {
      await poller.trigger();
      const call = fsMocks.writeFileSync.mock.calls.find((c) => String(c[0]).includes("metadata.json"));
      const written = String(call?.[1]);
      expect(written).not.toContain("X-Amz");
      expect(written).not.toContain("presigned_url");
      expect(written).not.toContain("data_link");
    });

    it("keeps existing note files on a normal sync but rewrites them on resync", async () => {
      fsMocks.existsSync.mockImplementation((p: string) => String(p).endsWith("outline.json"));
      await poller.trigger();
      expect(writtenFiles()).not.toContain("outline.json");

      fsMocks.renameSync.mockClear();
      await poller.resyncRecording(ID);
      expect(writtenFiles()).toContain("outline.json");
      expect(clientMocks.downloadToFile).toHaveBeenCalledTimes(1); // audio not fetched again
    });

    it("records an error and retries later when Plaud has no audio link yet", async () => {
      clientMocks.getFile.mockResolvedValue(detail(ID, START, { presigned_url: null }));
      await poller.trigger();
      const row = getRecordingById(ID)!;
      expect(row.audioDownloadedAt).toBeNull();
      expect(row.lastError).toMatch(/no audio link/);
      expect(row.transcriptDownloadedAt).not.toBeNull();
    });
  });

  describe("transcript availability", () => {
    it("stops asking about an old recording Plaud never transcribed", async () => {
      const old = NOW - 20 * DAY;
      clientMocks.listFiles.mockResolvedValueOnce([listed("f_quiet00001", old)]);
      clientMocks.getFile.mockResolvedValue(detail("f_quiet00001", old, { source_list: [], note_list: [] }));

      await poller.trigger();
      expect(clientMocks.getFile).toHaveBeenCalledTimes(1);

      await poller.trigger();
      expect(clientMocks.getFile).toHaveBeenCalledTimes(1);
    });

    it("keeps checking a recent recording that has no transcript yet", async () => {
      const recent = NOW - 60 * 60 * 1000;
      clientMocks.listFiles.mockResolvedValue([listed("f_fresh00001", recent)]);
      clientMocks.getFile.mockResolvedValue(detail("f_fresh00001", recent, { source_list: [], note_list: [] }));

      await poller.trigger();
      await poller.trigger();
      expect(clientMocks.getFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("discovery", () => {
    const page = (offset: number, n: number): PlaudFileSummary[] =>
      Array.from({ length: n }, (_, i) => listed(`f_page${String(offset + i).padStart(6, "0")}`, NOW - 200 * DAY));

    it("walks the whole list until it has been indexed once", async () => {
      clientMocks.listFiles
        .mockResolvedValueOnce(page(0, POLLER_LIST_PAGE_SIZE))
        .mockResolvedValueOnce(page(POLLER_LIST_PAGE_SIZE, 3));
      await poller.trigger();
      expect(clientMocks.listFiles).toHaveBeenCalledTimes(2);
      expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ libraryIndexedAt: expect.any(Number) }));
    });

    it("after indexing, a routine poll stops at the first page with nothing new", async () => {
      for (const f of page(0, POLLER_LIST_PAGE_SIZE)) upsertFromPlaud(toRecordingMeta(f)!);
      loadConfig.mockReturnValue({ ...baseConfig, libraryIndexedAt: NOW });
      clientMocks.listFiles.mockResolvedValue(page(0, POLLER_LIST_PAGE_SIZE));

      // Drive a scheduled-style cycle (not Sync Now, which always walks fully).
      await (poller as unknown as { runOnce(): Promise<void> }).runOnce();
      expect(clientMocks.listFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe("webhook delivery and re-drive (Phase 2b)", () => {
    const ID = "f_hook000001";
    const webhookConfig = (enabledAt?: number): AppConfig => ({
      ...baseConfig,
      webhook: { url: "https://hook.example/x", enabled: true, ...(enabledAt != null ? { enabledAt } : {}) },
    });
    const backoff = (id: string) =>
      db
        .prepare<[string], { a: number; an: number | null; t: number; tn: number | null }>(
          `SELECT webhook_audio_attempts AS a, webhook_audio_next_at AS an,
                  webhook_transcript_attempts AS t, webhook_transcript_next_at AS tn
           FROM recordings WHERE id = ?`,
        )
        .get(id);
    /** A fully-downloaded row, so only Phase 2b (not the download path) can fire for it. */
    const downloaded = (id: string, at: number): void => {
      upsertFromPlaud(toRecordingMeta(listed(id, NOW - DAY))!);
      db.prepare(
        "UPDATE recordings SET audio_downloaded_at = ?, transcript_downloaded_at = ?, summary_downloaded_at = ? WHERE id = ?",
      ).run(at, at, at, id);
    };

    it("does not replay recordings downloaded before the webhook was enabled", async () => {
      downloaded(ID, Date.now() - 60_000);
      loadConfig.mockReturnValue(webhookConfig(Date.now()));
      await poller.trigger();
      expect(webhookMocks.fireWebhookForRecording).not.toHaveBeenCalled();
    });

    it("re-drives undelivered assets with a single attempt each", async () => {
      downloaded(ID, Date.now() - 1000);
      loadConfig.mockReturnValue(webhookConfig(Date.now() - 60_000));
      await poller.trigger();
      expect(webhookMocks.fireWebhookForRecording).toHaveBeenCalledTimes(2);
      for (const call of webhookMocks.fireWebhookForRecording.mock.calls) {
        expect(call[2]).toEqual({ maxAttempts: 1 });
      }
    });

    it("stops the re-drive batch at the first failure and backs that delivery off", async () => {
      downloaded("f_hook000001", Date.now() - 1000);
      downloaded("f_hook000002", Date.now() - 2000);
      loadConfig.mockReturnValue(webhookConfig(0));
      webhookMocks.fireWebhookForRecording.mockResolvedValue(false);

      await poller.trigger();

      expect(webhookMocks.fireWebhookForRecording).toHaveBeenCalledTimes(1);
      const failedId = (webhookMocks.fireWebhookForRecording.mock.calls[0]![1] as { id: string }).id;
      const failedEvent = webhookMocks.fireWebhookForRecording.mock.calls[0]![0] as string;
      const failed = backoff(failedId);
      const [attempts, nextAt] = failedEvent === "audio_ready" ? [failed?.a, failed?.an] : [failed?.t, failed?.tn];
      expect(attempts).toBe(1);
      expect(nextAt).toBeGreaterThan(Date.now());
      const other = backoff(failedId === "f_hook000001" ? "f_hook000002" : "f_hook000001");
      expect(other).toMatchObject({ a: 0, t: 0 });
    });

    it("does not re-fire a just-failed inline delivery in the same cycle", async () => {
      clientMocks.listFiles.mockResolvedValueOnce([listed(ID, NOW - DAY)]);
      clientMocks.getFile.mockResolvedValue(detail(ID, NOW - DAY));
      loadConfig.mockReturnValue(webhookConfig(0));
      webhookMocks.fireWebhookForRecording.mockResolvedValue(false);

      await poller.trigger();

      // One inline attempt per event (audio, then transcript) — nothing more from Phase 2b.
      const events = webhookMocks.fireWebhookForRecording.mock.calls.map((c) => c[0]);
      expect(events).toEqual(["audio_ready", "transcript_ready"]);
      expect(backoff(ID)).toMatchObject({ a: 1, t: 1 });
    });

    it("leaves no back-off state when no webhook is configured", async () => {
      clientMocks.listFiles.mockResolvedValueOnce([listed(ID, NOW - DAY)]);
      clientMocks.getFile.mockResolvedValue(detail(ID, NOW - DAY));
      await poller.trigger();
      expect(webhookMocks.fireWebhookForRecording).not.toHaveBeenCalled();
      expect(backoff(ID)).toMatchObject({ a: 0, an: null, t: 0, tn: null });
    });
  });

  describe("watchdog", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("stops the abandoned cycle at its next checkpoint and doesn't start another alongside it", async () => {
      vi.useFakeTimers();
      let releasePage!: (v: unknown) => void;
      clientMocks.listFiles.mockImplementationOnce(() => new Promise((resolve) => (releasePage = resolve)));

      const first = poller.trigger();
      await vi.advanceTimersByTimeAsync(POLLER_RUN_WATCHDOG_MS + 1);
      await first;
      expect(poller.status().lastError).toMatch(/watchdog/);
      expect(poller.status().polling).toBe(false);

      // The hung cycle is still out there: a new run must not start beside it.
      await poller.trigger();
      expect(clientMocks.listFiles).toHaveBeenCalledTimes(1);

      // Its page finally lands, but the cycle was aborted, so it stops there.
      releasePage([listed("f_late000001", NOW - DAY)]);
      await vi.advanceTimersByTimeAsync(0);
      expect(clientMocks.listFiles).toHaveBeenCalledTimes(1);
      expect(getRecordingById("f_late000001")).toBeNull();

      // Once it has stopped, polling resumes normally.
      await poller.trigger();
      expect(clientMocks.listFiles).toHaveBeenCalledTimes(2);
      expect(poller.status().lastError).toBeNull();
    });
  });
});

describe("poller helpers", () => {
  it("toRecordingMeta reads Plaud's zone-less timestamps as UTC and prefers start_at", () => {
    const meta = toRecordingMeta({
      id: "of_1",
      name: "  Note  ",
      created_at: "2026-10-22T10:37:46",
      start_at: "2026-10-22T10:30:39.438000",
      duration: 415000,
      serial_number: null,
    });
    expect(meta).toEqual({
      id: "of_1",
      filename: "Note",
      startTime: Date.UTC(2026, 9, 22, 10, 30, 39, 438),
      durationMs: 415000,
      serialNumber: "",
    });
  });

  it("toRecordingMeta rejects a recording with no usable time", () => {
    expect(toRecordingMeta({ id: "x", name: "x", created_at: null, start_at: "nope", duration: 1, serial_number: null })).toBeNull();
  });

  it("stripSignedLinks keeps block content but drops links", () => {
    const out = stripSignedLinks(detail("f_1", NOW)) as { source_list: Record<string, unknown>[] };
    expect(out).not.toHaveProperty("presigned_url");
    expect(out.source_list[0]).toHaveProperty("data_content");
    expect(out.source_list[0]).not.toHaveProperty("data_link");
  });

  it("noteFileName is filesystem-safe and distinct per note", () => {
    expect(noteFileName({ data_id: "o_abcdef123456", data_type: "consumer_note", data_tab_name: "Q&A: next/steps" })).toBe(
      "Q&A_next_steps__consumer_note__ef123456.md",
    );
  });
});
