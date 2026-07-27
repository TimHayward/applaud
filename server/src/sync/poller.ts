import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { listRecordings } from "../plaud/list.js";
import { downloadAudio } from "../plaud/audio.js";
import {
  getTranscriptAndSummary,
  flattenTranscript,
  extractSummaryMarkdown,
  extractMarkdownFromSummaryPayload,
  fetchTranscriptFromContentList,
} from "../plaud/transcript.js";
import { getFileDetail } from "../plaud/detail.js";
import type { ContentListItem, FileDetailData } from "../plaud/detail.js";
import { PlaudAuthError } from "../plaud/client.js";
import { ensureFreshWorkspaceToken } from "../plaud/first-party.js";
import {
  upsertFromPlaud,
  markAudioDownloaded,
  markTranscriptDownloaded,
  markSummaryDownloaded,
  markWebhookFired,
  recordError,
  getRecordingById,
  findRecordingsNeedingAssets,
  findRecordingsNeedingWebhook,
  purgeExpiredSoftDeletes,
  isSyncIgnoredId,
  findPlaudTrashAssetProbeCandidates,
  markTrashAssetProbed,
  PLAUD_TRASH_ASSET_PROBE_INTERVAL_MS,
  PLAUD_TRASH_ASSET_PROBE_SCHEDULED_LIMIT,
  PLAUD_TRASH_ASSET_PROBE_MANUAL_SYNC_LIMIT,
  clearError,
  resetPlaudTrashAssetProbeTimestamps,
  resetDownloadStateForResync,
} from "./state.js";
import { ensureRecordingFolder } from "./layout.js";
import { writeFileAtomic } from "../fsAtomic.js";
import {
  POLLER_LIST_PAGE_SIZE,
  POLLER_LIST_MAX_PAGES,
  POLLER_LIST_PAGE_OVERLAP,
  POLLER_RUN_WATCHDOG_MS,
  HTTP_FETCH_TIMEOUT_MS,
} from "../constants.js";
import { sanitizeFilename } from "./layout.js";
import { fireWebhookForRecording } from "../webhook/post.js";
import { emit } from "./events.js";
import type { RecordingRow } from "@applaud/shared";
import { sanitizePlaudSummaryMarkdown } from "@applaud/shared";
import { gunzipSync } from "node:zlib";

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
  /** Set by trigger(); consumed on next poll past config gate — manual reset + higher Phase 3 probe cap. */
  private pendingManualSync = false;
  /** Recording ids currently being fetched/written, guarding scheduled and manual (resync) processing from overlapping on the same row. */
  private processingIds = new Set<string>();
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

  /**
   * Re-read config (e.g. a new pollIntervalMinutes) and reschedule. No-op if
   * the poller was never started — start() is the entry point for that case.
   */
  restart(): void {
    if (!this.interval) return;
    this.stop();
    this.start();
  }

  async trigger(): Promise<void> {
    this.pendingManualSync = true;
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

  async resyncRecording(id: string): Promise<void> {
    if (this.processingIds.has(id)) {
      throw new Error("recording is already being synced — try again in a moment");
    }
    resetDownloadStateForResync(id);
    const refreshed = getRecordingById(id);
    if (!refreshed) throw new Error("recording not found");
    await this.processRecording(refreshed, true);
  }

  /**
   * Race an operation against a hard deadline. Even with per-fetch timeouts,
   * this is a belt-and-suspenders guard so a single poll cycle can never hang
   * `inFlight` (and thus silently no-op every later tick) forever.
   */
  private async withWatchdog<T>(op: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`poll cycle exceeded ${POLLER_RUN_WATCHDOG_MS}ms watchdog`)),
        POLLER_RUN_WATCHDOG_MS,
      );
    });
    try {
      return await Promise.race([op(), watchdog]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    emit("poll_start");
    try {
      await this.withWatchdog(() => this.pollAndProcess());
      this.lastError = null;
    } catch (err) {
      // First-party mid-poll 401: Plaud rejected an unexpired WT (revoked or
      // rotated). Force one re-mint and retry the whole cycle before giving up.
      if (err instanceof PlaudAuthError && loadConfig().authMode === "first_party") {
        try {
          await ensureFreshWorkspaceToken(true);
          await this.withWatchdog(() => this.pollAndProcess());
          this.lastError = null;
          return;
        } catch (retryErr) {
          this.handlePollError(retryErr);
          return;
        }
      }
      this.handlePollError(err);
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

  private handlePollError(err: unknown): void {
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
  }

  private async pollAndProcess(): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.token || !cfg.recordingsDir || !cfg.setupComplete) return;

    // First-party sessions cache a short-lived workspace token; refresh/re-mint
    // it before the poll if it's stale. No-op for legacy installs. May throw
    // PlaudAuthError (reconnect required) or a transient Error, both handled by
    // runOnce. Subsequent Plaud calls read the freshly-persisted token.
    await ensureFreshWorkspaceToken();

    const isManualSync = this.pendingManualSync;
    if (isManualSync) this.pendingManualSync = false;

    if (isManualSync && cfg.importPlaudDeleted) {
      const cleared = resetPlaudTrashAssetProbeTimestamps();
      if (cleared > 0) {
        logger.info({ rows: cleared }, "manual sync: cleared Plaud trash transcript/summary probe throttles");
      }
    }

    this.authRequired = false;

    purgeExpiredSoftDeletes();

    const listTrashMode = cfg.importPlaudDeleted ? 2 : 0;

    // Phase 1 — Discovery: walk Plaud's recording list and upsert metadata for
    // any new rows. Upsert is a no-op for rows we already have. No fetching
    // happens here.
    let fetched = 0;
    let totalReported = 0;
    for (let pageIdx = 0; pageIdx < POLLER_LIST_MAX_PAGES; pageIdx++) {
      // Overlap a few rows with the previous page so a delete mid-walk (which
      // shifts items up across the boundary) can't skip a brand-new recording
      // for a cycle. Upsert is idempotent, so the re-reads cost nothing.
      const skip = Math.max(
        0,
        pageIdx * POLLER_LIST_PAGE_SIZE - (pageIdx > 0 ? POLLER_LIST_PAGE_OVERLAP : 0),
      );
      const page = await listRecordings({
        skip,
        limit: POLLER_LIST_PAGE_SIZE,
        isTrash: listTrashMode,
      });
      if (page.status !== 0) {
        throw new Error(`Plaud list returned status=${page.status} msg=${page.msg}`);
      }
      totalReported = page.data_file_total ?? totalReported;
      const items = page.data_file_list ?? [];
      if (items.length === 0) break;
      for (const item of items) {
        try {
          if (isSyncIgnoredId(item.id)) continue;
          if (item.is_trash && !cfg.importPlaudDeleted) continue;
          const pre = getRecordingById(item.id);
          if (pre?.userDeletedAt) continue;
          upsertFromPlaud(item);
          fetched++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, id: item.id }, "upsert failed");
          recordError(item.id, msg);
          emit("error", { recordingId: item.id, message: msg });
        }
      }
      if (items.length < POLLER_LIST_PAGE_SIZE) break;
    }
    logger.info({ fetched, reportedTotal: totalReported }, "list walk complete");

    // Phase 2 — Fetch: for every recording with any missing asset, try to
    // fetch the missing ones. Each asset is independent; each gets retried on
    // every poll until it's downloaded.
    const needy = findRecordingsNeedingAssets();
    for (const row of needy) {
      await this.processRecording(row).catch((err) => {
        // An auth failure must bubble out to runOnce so the 401 re-mint /
        // "reconnect required" path fires — never get swallowed as a per-row
        // recordError while status() keeps reporting success.
        if (err instanceof PlaudAuthError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, id: row.id }, "processRecording failed");
        recordError(row.id, msg);
        emit("error", { recordingId: row.id, message: msg });
      });
    }

    // Phase 2b — Webhook re-drive: any downloaded asset whose delivery never
    // succeeded (fired_at IS NULL) gets (re)fired here, so a delivery lost after
    // the in-process backoff window recovers on its own instead of needing a
    // manual Redeliver. No-op when no webhook is configured.
    if (cfg.webhook?.enabled && cfg.webhook.url) {
      for (const { row, event } of findRecordingsNeedingWebhook()) {
        try {
          const fired = await fireWebhookForRecording(event, row);
          if (fired) markWebhookFired(row.id, event);
        } catch (err) {
          logger.warn({ err, id: row.id, event }, "webhook re-drive failed");
        }
      }
    }

    // Phase 3 — Plaud trash: best-effort transcript/summary check (throttled).
    // Not included in pending counts or findRecordingsNeedingAssets; failures do not set last_error.
    if (cfg.importPlaudDeleted) {
      const probeCutoff = Date.now() - PLAUD_TRASH_ASSET_PROBE_INTERVAL_MS;
      const probeLimit = isManualSync
        ? PLAUD_TRASH_ASSET_PROBE_MANUAL_SYNC_LIMIT
        : PLAUD_TRASH_ASSET_PROBE_SCHEDULED_LIMIT;
      const trashProbe = findPlaudTrashAssetProbeCandidates(probeCutoff, probeLimit);
      for (const row of trashProbe) {
        try {
          clearError(row.id);
          await this.tryTranscriptAndSummary(row, true);
        } catch (err) {
          // A real auth revocation must still surface as "reconnect required"
          // even during the best-effort probe phase (the finally below still
          // records the probe timestamp before this propagates).
          if (err instanceof PlaudAuthError) throw err;
          logger.info(
            { err, id: row.id },
            "plaud trash asset probe: no transcript/summary to ingest or transient error (ignored)",
          );
        } finally {
          markTrashAssetProbed(row.id);
        }
      }
    }
  }

  private async processRecording(row: RecordingRow, forceDetailRefresh = false): Promise<void> {
    // Guards the scheduled Phase 2 loop and a manual resync() from ever
    // writing the same recording's files concurrently.
    if (this.processingIds.has(row.id)) return;
    this.processingIds.add(row.id);
    try {
      const cfg = loadConfig();
      if (!cfg.recordingsDir) return;
      if (isSyncIgnoredId(row.id)) return;
      if (row.userDeletedAt) return;
      if (row.isTrash && !cfg.importPlaudDeleted) return;

      const paths = ensureRecordingFolder(cfg.recordingsDir, row.folder);

      if (forceDetailRefresh) {
        await this.refreshDetailAndAssets(row.id, paths.folder, true);
      }

      // Each asset is retried independently — a failure fetching one doesn't
      // block the others. Errors are recorded on the row and the loop continues.
      if (!row.audioDownloadedAt) {
        try {
          if (!forceDetailRefresh) await this.refreshDetailAndAssets(row.id, paths.folder);

          // Use the DB's stored audio path (extension derived from Plaud's
          // filetype at insert) so disk and the served URL always agree. The
          // streamed byte count is verified against Content-Length/filesizeBytes
          // so a short S3 close can't publish a truncated file.
          const bytes = await downloadAudio(
            row.id,
            row.audioPath ?? paths.audioPath,
            row.filesizeBytes,
          );
          markAudioDownloaded(row.id, bytes || row.filesizeBytes);
          emit("recording_new", { recordingId: row.id });

          const fresh = getRecordingById(row.id);
          if (fresh) {
            const fired = await fireWebhookForRecording("audio_ready", fresh);
            if (fired) markWebhookFired(row.id, "audio_ready");
          }
        } catch (err) {
          if (err instanceof PlaudAuthError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, id: row.id }, "audio download failed");
          recordError(row.id, msg);
          emit("error", { recordingId: row.id, message: msg });
        }
      }

      const wantSummary = !row.summaryDownloadedAt && row.plaudIsSummary;
      if (!row.isTrash && (!row.transcriptDownloadedAt || wantSummary)) {
        try {
          await this.tryTranscriptAndSummary(row);
        } catch (err) {
          if (err instanceof PlaudAuthError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, id: row.id }, "transcript/summary fetch failed");
          recordError(row.id, msg);
          emit("error", { recordingId: row.id, message: msg });
        }
      }
    } finally {
      this.processingIds.delete(row.id);
    }
  }

  private async tryTranscriptAndSummary(row: RecordingRow, opportunistic = false): Promise<void> {
    if (opportunistic) {
      if (!row.isTrash) return;
    } else if (row.isTrash) {
      return;
    }
    const cfg = loadConfig();
    if (!cfg.recordingsDir) return;
    const paths = ensureRecordingFolder(cfg.recordingsDir, row.folder);

    const needTranscript = !row.transcriptDownloadedAt;
    const needSummary = !row.summaryDownloadedAt && row.plaudIsSummary;
    let wroteTranscript = false;
    let wroteSummary = false;

    // Primary: transsumm endpoint. Returns transcript + summary together for
    // newer recordings. Shape of data_result_summ varies per recording — the
    // extractor handles that.
    const resp = await getTranscriptAndSummary(row.id);
    if (needTranscript && resp.data_result && resp.data_result.length > 0) {
      writeFileAtomic(paths.transcriptJsonPath, JSON.stringify(resp, null, 2));
      const txtContent = flattenTranscript(resp.data_result);
      writeFileAtomic(paths.transcriptTxtPath, txtContent);
      markTranscriptDownloaded(row.id, txtContent);
      wroteTranscript = true;
    }
    if (needSummary) {
      const md = extractSummaryMarkdown(resp);
      if (md) {
        const cleaned = sanitizePlaudSummaryMarkdown(md, {
          startTimeMs: row.startTime,
          endTimeMs: row.endTime,
        });
        writeFileAtomic(paths.summaryMdPath, cleaned);
        markSummaryDownloaded(row.id);
        wroteSummary = true;
      }
    }

    // Fallback: pre-March-2026 recordings where transsumm returns status:-12
    // with empty data_result. Transcript + summary live as S3 artifacts in
    // /file/detail content_list, tagged by data_type "transaction" and
    // "auto_sum_note" respectively.
    const stillNeedTranscript = needTranscript && !wroteTranscript;
    const stillNeedSummary = needSummary && !wroteSummary;
    if (stillNeedTranscript || stillNeedSummary) {
      logger.info(
        { id: row.id, stillNeedTranscript, stillNeedSummary },
        "trying content_list fallback",
      );
      const detail = await getFileDetail(row.id);
      if (detail.content_list && detail.content_list.length > 0) {
        const { segments, summaryMd } = await fetchTranscriptFromContentList(detail.content_list);
        if (stillNeedTranscript && segments.length > 0) {
          writeFileAtomic(paths.transcriptJsonPath, JSON.stringify(segments, null, 2));
          const txtContent = flattenTranscript(segments);
          writeFileAtomic(paths.transcriptTxtPath, txtContent);
          markTranscriptDownloaded(row.id, txtContent);
          wroteTranscript = true;
        }
        if (stillNeedSummary && summaryMd) {
          const cleaned = sanitizePlaudSummaryMarkdown(summaryMd, {
            startTimeMs: row.startTime,
            endTimeMs: row.endTime,
          });
          writeFileAtomic(paths.summaryMdPath, cleaned);
          markSummaryDownloaded(row.id);
          wroteSummary = true;
        }
      }
      await this.downloadExtraAssets(detail, paths.folder, row.id);
      await this.downloadContentListMarkdown(detail.content_list, paths.folder, row.id);
    }

    // transcript_ready fires only on a null→set transition; summary-only
    // backfills don't refire the webhook.
    if (wroteTranscript) {
      emit("recording_downloaded", { recordingId: row.id });
      const fresh = getRecordingById(row.id);
      if (fresh) {
        const fired = await fireWebhookForRecording("transcript_ready", fresh);
        if (fired) markWebhookFired(row.id, "transcript_ready");
      }
    }
  }

  private async refreshDetailAndAssets(
    recordingId: string,
    folderAbs: string,
    forceOverwrite = false,
  ): Promise<void> {
    try {
      const detail = await getFileDetail(recordingId);
      writeFileAtomic(path.join(folderAbs, "metadata.json"), JSON.stringify(detail, null, 2));
      await this.downloadExtraAssets(detail, folderAbs, recordingId, forceOverwrite);
      await this.downloadContentListMarkdown(detail.content_list, folderAbs, recordingId, forceOverwrite);
    } catch (err) {
      logger.warn({ err, id: recordingId }, "file detail fetch failed (non-fatal)");
    }
  }

  private async downloadContentListMarkdown(
    contentList: ContentListItem[] | undefined,
    folderAbs: string,
    recordingId: string,
    forceOverwrite = false,
  ): Promise<void> {
    if (!contentList || contentList.length === 0) return;
    const NOTE_TYPES = new Set([
      "auto_sum_note",
      "outline",
      "sum_multi_note",
      "high_light",
      "mark_memo",
      "consumer_note",
      "transaction_polish",
    ]);
    let downloadedCount = 0;

    for (const item of contentList) {
      if (!item?.data_link) continue;
      if (!NOTE_TYPES.has(item.data_type)) continue;
      const baseLabel =
        sanitizeFilename(item.data_tab_name || item.data_title || item.data_type || "note") ||
        "note";
      const fileName = `${baseLabel}__${item.data_type}__${item.data_id.slice(-8)}.md`;
      const destPath = path.join(folderAbs, fileName);
      if (existsSync(destPath) && !forceOverwrite) continue;

      try {
        const res = await fetch(item.data_link, { signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS) });
        if (!res.ok) {
          logger.warn(
            { id: recordingId, dataType: item.data_type, dataId: item.data_id, status: res.status },
            "content_list markdown download failed",
          );
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        let raw: string;
        try {
          raw = gunzipSync(buf).toString("utf8");
        } catch {
          raw = buf.toString("utf8");
        }
        const extracted = extractMarkdownFromSummaryPayload(raw);
        const out = extracted && extracted.trim().length > 0 ? extracted : raw;
        writeFileAtomic(destPath, out, "utf8");
        downloadedCount += 1;
        logger.info({ id: recordingId, dataType: item.data_type, fileName }, "downloaded content_list markdown");
      } catch (err) {
        logger.warn(
          { err, id: recordingId, dataType: item.data_type, dataId: item.data_id },
          "content_list markdown download error",
        );
      }
    }

    logger.info({ id: recordingId, downloadedCount }, "content_list markdown download summary");
  }

  private async downloadExtraAssets(
    detail: FileDetailData,
    folderAbs: string,
    recordingId: string,
    forceOverwrite = false,
  ): Promise<void> {
    const mapping = detail.download_path_mapping;
    if (!mapping || Object.keys(mapping).length === 0) return;
    const ALLOWED_EXT = new Set([".md", ".jpg", ".jpeg", ".png", ".svg"]);
    for (const [filename, url] of Object.entries(mapping)) {
      if (!url) continue;
      const relPath = path.normalize(filename);
      if (path.isAbsolute(relPath) || relPath.startsWith("..") || relPath.includes(`..${path.sep}`)) {
        logger.warn({ id: recordingId, filename }, "skipping unsafe extra asset path");
        continue;
      }
      const ext = path.extname(relPath).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) continue;
      const destPath = path.join(folderAbs, relPath);
      const relFromRoot = path.relative(folderAbs, destPath);
      if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
        logger.warn({ id: recordingId, filename }, "skipping escaping extra asset path");
        continue;
      }
      if (existsSync(destPath) && !forceOverwrite) continue;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS) });
        if (!res.ok) {
          logger.warn({ id: recordingId, filename, status: res.status }, "extra asset download failed");
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        mkdirSync(path.dirname(destPath), { recursive: true });
        writeFileAtomic(destPath, buf);
        logger.info({ id: recordingId, filename }, "downloaded extra asset");
      } catch (err) {
        logger.warn({ err, id: recordingId, filename }, "extra asset download error");
      }
    }
  }
}

export const poller = new Poller();
