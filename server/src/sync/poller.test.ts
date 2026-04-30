import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { AppConfig, PlaudRawRecording } from "@applaud/shared";
import path from "node:path";

const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
const fsMocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn((p: string): boolean => Boolean(p) && false),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
}));
const plaudListMocks = vi.hoisted(() => ({ listRecordings: vi.fn() }));
const plaudAudioMocks = vi.hoisted(() => ({ downloadAudio: vi.fn() }));
const plaudTranscriptMocks = vi.hoisted(() => ({
  getTranscriptAndSummary: vi.fn(),
  flattenTranscript: vi.fn(),
  extractSummaryMarkdown: vi.fn(),
  extractMarkdownFromSummaryPayload: vi.fn(),
  fetchTranscriptFromContentList: vi.fn(),
}));
const plaudDetailMocks = vi.hoisted(() => ({ getFileDetail: vi.fn() }));
const webhookMocks = vi.hoisted(() => ({ fireWebhookForRecording: vi.fn() }));

vi.mock("../config.js", () => ({ loadConfig, updateConfig: vi.fn() }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, ...fsMocks };
});
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../plaud/list.js", () => plaudListMocks);
vi.mock("../plaud/audio.js", () => plaudAudioMocks);
vi.mock("../plaud/transcript.js", () => plaudTranscriptMocks);
vi.mock("../plaud/detail.js", () => plaudDetailMocks);
vi.mock("../webhook/post.js", () => webhookMocks);
vi.mock("./events.js", () => ({ emit: vi.fn() }));

import { poller } from "./poller.js";
import { getRecordingById, upsertFromPlaud } from "./state.js";
import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";

const baseConfig: AppConfig = {
  version: 1,
  setupComplete: true,
  token: "token",
  tokenExp: null,
  tokenEmail: null,
  plaudRegion: null,
  recordingsDir: "/test/recordings",
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  lanToken: null,
  importPlaudDeleted: false,
};

function makePlaudItem(overrides: Partial<PlaudRawRecording> = {}): PlaudRawRecording {
  return {
    id: "abcdef0123456789",
    filename: "Standup",
    fullname: "Standup",
    filesize: 12345,
    file_md5: "deadbeef",
    start_time: Date.UTC(2026, 3, 11, 12, 0),
    end_time: Date.UTC(2026, 3, 11, 12, 1),
    duration: 60_000,
    version: 1,
    version_ms: 0,
    edit_time: 0,
    is_trash: false,
    is_trans: false,
    is_summary: false,
    serial_number: "S1",
    ...overrides,
  };
}

describe("poller asset overwrite behavior", () => {
  let db: Database.Database;
  let fetchMock: ReturnType<typeof vi.fn>;

  const contentUrl = "https://content.test/note.md";
  const extraUrl = "https://assets.test/image.jpg";

  beforeEach(() => {
    db = setupTestDb();

    loadConfig.mockReset();
    loadConfig.mockReturnValue(baseConfig);

    fsMocks.writeFileSync.mockReset();
    fsMocks.existsSync.mockReset();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.mkdirSync.mockReset();
    fsMocks.renameSync.mockReset();
    fsMocks.rmSync.mockReset();

    plaudListMocks.listRecordings.mockReset();
    plaudListMocks.listRecordings.mockResolvedValue({
      status: 0,
      msg: "ok",
      data_file_total: 0,
      data_file_list: [],
    });

    plaudAudioMocks.downloadAudio.mockReset();
    plaudAudioMocks.downloadAudio.mockResolvedValue(12345);

    plaudTranscriptMocks.getTranscriptAndSummary.mockReset();
    plaudTranscriptMocks.getTranscriptAndSummary.mockResolvedValue({
      data_result: [{ text: "hello" }],
      data_result_summ: null,
    });
    plaudTranscriptMocks.flattenTranscript.mockReset();
    plaudTranscriptMocks.flattenTranscript.mockReturnValue("flattened transcript");
    plaudTranscriptMocks.extractSummaryMarkdown.mockReset();
    plaudTranscriptMocks.extractSummaryMarkdown.mockReturnValue(null);
    plaudTranscriptMocks.extractMarkdownFromSummaryPayload.mockReset();
    plaudTranscriptMocks.extractMarkdownFromSummaryPayload.mockImplementation((raw: string) => raw);
    plaudTranscriptMocks.fetchTranscriptFromContentList.mockReset();
    plaudTranscriptMocks.fetchTranscriptFromContentList.mockResolvedValue({ segments: [], summaryMd: null });

    plaudDetailMocks.getFileDetail.mockReset();

    webhookMocks.fireWebhookForRecording.mockReset();
    webhookMocks.fireWebhookForRecording.mockResolvedValue(true);

    fetchMock = vi.fn(async (url: string) => {
      if (url === contentUrl) return new Response("# refreshed note", { status: 200 });
      if (url === extraUrl) return new Response("image-bytes", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    teardownTestDb(db);
  });

  it("normal sync skips existing content_list markdown and mapped extra assets", async () => {
    upsertFromPlaud(makePlaudItem());
    const row = getRecordingById("abcdef0123456789");
    expect(row).toBeTruthy();

    const markdownPath = path.join(
      baseConfig.recordingsDir!,
      row!.folder,
      "Meeting_Notes__outline__12345678.md",
    );
    const extraPath = path.join(baseConfig.recordingsDir!, row!.folder, path.normalize("permanent/marks/image.jpg"));
    const existingPaths = new Set([path.normalize(markdownPath), path.normalize(extraPath)]);
    fsMocks.existsSync.mockImplementation((p: string) => existingPaths.has(path.normalize(p)));

    plaudDetailMocks.getFileDetail.mockResolvedValue({
      file_id: row!.id,
      file_name: row!.filename,
      file_version: 1,
      duration: row!.durationMs,
      is_trash: false,
      start_time: row!.startTime,
      scene: 0,
      serial_number: row!.serialNumber,
      session_id: 1,
      filetag_id_list: [],
      content_list: [
        {
          data_id: "note000012345678",
          data_type: "outline",
          task_status: 1,
          err_code: "",
          err_msg: "",
          data_title: "Outline",
          data_tab_name: "Meeting Notes",
          data_link: contentUrl,
        },
      ],
      download_path_mapping: {
        "permanent/marks/image.jpg": extraUrl,
      },
    });

    await poller.trigger();

    const writtenPaths = fsMocks.writeFileSync.mock.calls.map((call) => path.normalize(String(call[0])));
    expect(writtenPaths).not.toContain(path.normalize(markdownPath));
    expect(writtenPaths).not.toContain(path.normalize(extraPath));

    const fetchedUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(fetchedUrls).not.toContain(contentUrl);
    expect(fetchedUrls).not.toContain(extraUrl);
  });

  it("resync overwrites existing content_list markdown and mapped extra assets", async () => {
    upsertFromPlaud(makePlaudItem());
    db
      .prepare(
        "UPDATE recordings SET audio_downloaded_at = ?, transcript_downloaded_at = ?, summary_downloaded_at = ? WHERE id = ?",
      )
      .run(111, 222, null, "abcdef0123456789");

    const row = getRecordingById("abcdef0123456789");
    expect(row).toBeTruthy();

    const markdownPath = path.join(
      baseConfig.recordingsDir!,
      row!.folder,
      "Meeting_Notes__outline__12345678.md",
    );
    const extraPath = path.join(baseConfig.recordingsDir!, row!.folder, path.normalize("permanent/marks/image.jpg"));
    const existingPaths = new Set([path.normalize(markdownPath), path.normalize(extraPath)]);
    fsMocks.existsSync.mockImplementation((p: string) => existingPaths.has(path.normalize(p)));

    plaudDetailMocks.getFileDetail.mockResolvedValue({
      file_id: row!.id,
      file_name: row!.filename,
      file_version: 1,
      duration: row!.durationMs,
      is_trash: false,
      start_time: row!.startTime,
      scene: 0,
      serial_number: row!.serialNumber,
      session_id: 1,
      filetag_id_list: [],
      content_list: [
        {
          data_id: "note000012345678",
          data_type: "outline",
          task_status: 1,
          err_code: "",
          err_msg: "",
          data_title: "Outline",
          data_tab_name: "Meeting Notes",
          data_link: contentUrl,
        },
      ],
      download_path_mapping: {
        "permanent/marks/image.jpg": extraUrl,
      },
    });

    await poller.resyncRecording("abcdef0123456789");

    const writtenPaths = fsMocks.writeFileSync.mock.calls.map((call) => path.normalize(String(call[0])));
    expect(writtenPaths).toContain(path.normalize(markdownPath));
    expect(writtenPaths).toContain(path.normalize(extraPath));

    const fetchedUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(fetchedUrls).toContain(contentUrl);
    expect(fetchedUrls).toContain(extraUrl);

    expect(plaudAudioMocks.downloadAudio).not.toHaveBeenCalled();
  });
});
