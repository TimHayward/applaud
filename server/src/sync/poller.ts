import { writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { listRecordings } from "../plaud/list.js";
import { downloadAudio, md5File } from "../plaud/audio.js";
import {
  getTranscriptAndSummary,
  flattenTranscript,
  extractSummaryMarkdown,
  fetchTranscriptFromContentList,
} from "../plaud/transcript.js";
import { getFileDetail } from "../plaud/detail.js";
import { PlaudAuthError } from "../plaud/client.js";
import {
  upsertFromPlaud,
  markAudioDownloaded,
  markTranscriptDownloaded,
  markWebhookFired,
  recordError,
  getRecordingById,
  findPendingTranscriptIds,
} from "./state.js";
import { ensureRecordingFolder } from "./layout.js";
import { fireWebhookForRecording } from "../webhook/post.js";
import { emit } from "./events.js";
import type { PlaudRawRecording } from "@applaud/shared";

export interface PollerStatus {
  lastPollAt: number | null;
  nextPollAt: number | null;
  polling: boolean;
  lastError: string | null;
  authRequired: boolean;
}

class Poller {
  private interval: NodeJS.Timeout | null = null;
  private inFlight = false;
  private queuedTrigger = false;
  lastPollAt: number | null = null;
  nextPollAt: number | null = null;
  lastError: string | null = null;
  authRequired = false;

  start(): void {
    if (this.interval) return;
    const cfg = loadConfig();
    const ms = Math.max(cfg.pollIntervalMinutes, 1) * 60 * 1000;
    const runAndSchedule = (): void => {
      void this.runOnce().finally(() => {
        this.nextPollAt = Date.now() + ms;
      });
    };
    // Kick off immediately, then schedule.
    runAndSchedule();
    this.interval = setInterval(runAndSchedule, ms);
    logger.info({ intervalMinutes: cfg.pollIntervalMinutes }, "poller started");
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info("poller stopped");
  }

  async trigger(): Promise<void> {
    if (this.inFlight) {
      this.queuedTrigger = true;
      return;
    }
    await this.runOnce();
  }

  status(): PollerStatus {
    return {
      lastPollAt: this.lastPollAt,
      nextPollAt: this.nextPollAt,
      polling: this.inFlight,
      lastError: this.lastError,
      authRequired: this.authRequired,
    };
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    emit("poll_start");
    try {
      await this.pollAndProcess();
      this.lastError = null;
    } catch (err) {
      if (err instanceof PlaudAuthError) {
        this.authRequired = true;
        this.lastError = err.message;
        emit("auth_required", { message: err.message });
        logger.warn({ err }, "poller paused: auth required");
      } else {
        this.lastError = err instanceof Error ? err.message : String(err);
        emit("error", { message: this.lastError });
        logger.error({ err }, "poll failed");
      }
    } finally {
      this.lastPollAt = Date.now();
      this.inFlight = false;
      emit("poll_end");
      if (this.queuedTrigger) {
        this.queuedTrigger = false;
        void this.runOnce();
      }
    }
  }

  private async pollAndProcess(): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.token || !cfg.recordingsDir || !cfg.setupComplete) return;
    this.authRequired = false;

    // Paginate through ALL recordings. We stop when the API returns a short
    // page (< limit items) or when we've walked a sensible safety cap. Walking
    // the full history on each poll is cheap: ingestOne is a no-op for rows we
    // already have, so only new recordings trigger downloads.
    const PAGE_SIZE = 50;
    const MAX_PAGES = 200;
    const seen: PlaudRawRecording[] = [];
    let totalReported = 0;
    for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
      const page = await listRecordings({
        skip: pageIdx * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      if (page.status !== 0) {
        throw new Error(`Plaud list returned status=${page.status} msg=${page.msg}`);
      }
      totalReported = page.data_file_total ?? totalReported;
      const items = page.data_file_list ?? [];
      if (items.length === 0) break;
      seen.push(...items);
      if (items.length < PAGE_SIZE) break;
    }
    logger.info(
      { fetched: seen.length, reportedTotal: totalReported },
      "list walk complete",
    );
    for (const item of seen) {
      await this.ingestOne(item).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, id: item.id }, "ingest failed");
        recordError(item.id, msg);
        emit("error", { recordingId: item.id, message: msg });
      });
    }

    // Retry transcripts that were pending from previous polls.
    const pending = findPendingTranscriptIds();
    for (const id of pending) {
      if (seen.some((s) => s.id === id)) continue; // already handled above
      await this.tryTranscript(id).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        recordError(id, msg);
      });
    }
  }

  private async ingestOne(item: PlaudRawRecording): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.recordingsDir) return;

    const row = upsertFromPlaud(item);
    if (!row.audioDownloadedAt) {
      const paths = ensureRecordingFolder(cfg.recordingsDir, row.folder);

      try {
        const detail = await getFileDetail(item.id);
        writeFileSync(paths.metadataPath, JSON.stringify(detail, null, 2));
      } catch (err) {
        logger.warn({ err, id: item.id }, "file detail fetch failed (non-fatal)");
      }

      const bytes = await downloadAudio(item.id, paths.audioPath);
      markAudioDownloaded(item.id, bytes || item.filesize);
      emit("recording_new", { recordingId: item.id });

      const fresh = getRecordingById(item.id);
      if (fresh) {
        const fired = await fireWebhookForRecording("audio_ready", fresh);
        if (fired) markWebhookFired(item.id, "audio_ready");
      }
    }

    // If the transcript is ready on Plaud's side and we haven't pulled it yet, pull it.
    if (item.is_trans) {
      const current = getRecordingById(item.id);
      if (current && !current.transcriptDownloadedAt) {
        await this.tryTranscript(item.id);
      }
    }
  }

  private async tryTranscript(id: string): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.recordingsDir) return;
    const row = getRecordingById(id);
    if (!row) return;
    const paths = ensureRecordingFolder(cfg.recordingsDir, row.folder);

    // Try the transsumm endpoint first (works for newer recordings).
    const resp = await getTranscriptAndSummary(id);
    if (resp.data_result && resp.data_result.length > 0) {
      writeFileSync(paths.transcriptJsonPath, JSON.stringify(resp, null, 2));
      const txtContent = flattenTranscript(resp.data_result);
      writeFileSync(paths.transcriptTxtPath, txtContent);
      const md = extractSummaryMarkdown(resp);
      if (md) writeFileSync(paths.summaryMdPath, md);
      markTranscriptDownloaded(id, txtContent);
      emit("recording_downloaded", { recordingId: id });

      const fresh = getRecordingById(id);
      if (fresh) {
        const fired = await fireWebhookForRecording("transcript_ready", fresh);
        if (fired) markWebhookFired(id, "transcript_ready");
      }
      return;
    }

    // Fallback: older recordings store transcripts in S3 via the file detail endpoint.
    logger.info({ id }, "transsumm returned no data, trying file detail fallback");
    const detail = await getFileDetail(id);
    if (!detail.content_list || detail.content_list.length === 0) return;

    const { segments, summaryMd } = await fetchTranscriptFromContentList(detail.content_list);
    if (segments.length === 0) return;

    writeFileSync(paths.transcriptJsonPath, JSON.stringify(segments, null, 2));
    const txtContent = flattenTranscript(segments);
    writeFileSync(paths.transcriptTxtPath, txtContent);
    if (summaryMd) writeFileSync(paths.summaryMdPath, summaryMd);
    markTranscriptDownloaded(id, txtContent);
    emit("recording_downloaded", { recordingId: id });

    const fresh = getRecordingById(id);
    if (fresh) {
      const fired = await fireWebhookForRecording("transcript_ready", fresh);
      if (fired) markWebhookFired(id, "transcript_ready");
    }
  }

  public async refreshRecording(id: string): Promise<void> {
    await this.tryTranscript(id);
  }
}

export const poller = new Poller();
