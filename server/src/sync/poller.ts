import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig, updateConfig } from "../config.js";
import { logger } from "../logger.js";
import {
  audioExtensionFromUrl,
  downloadToFile,
  getFile,
  listFiles,
  loadBlockContent,
  parseApiTimestamp,
  PlaudApiError,
  PlaudAuthError,
  type PlaudContentBlock,
  type PlaudFileDetail,
  type PlaudFileSummary,
} from "../plaud/client.js";
import { flattenTranscript, extractMarkdownFromSummaryPayload, type TranscriptSegment } from "../plaud/transcript.js";
import {
  upsertFromPlaud,
  markAudioDownloaded,
  markTranscriptDownloaded,
  markSummaryDownloaded,
  markWebhookFired,
  recordWebhookFailure,
  recordError,
  getRecordingById,
  findRecordingsNeedingAssets,
  findRecordingsNeedingWebhook,
  purgeExpiredSoftDeletes,
  isSyncIgnoredId,
  knownRecordingIds,
  resetDownloadStateForResync,
  setAudioFilename,
  setPlaudAvailability,
  type PlaudRecordingMeta,
} from "./state.js";
import { audioFilenameForFiletype, ensureRecordingFolder, sanitizeFilename } from "./layout.js";
import { writeFileAtomic } from "../fsAtomic.js";
import {
  POLLER_LIST_PAGE_SIZE,
  POLLER_LIST_MAX_PAGES,
  POLLER_RUN_WATCHDOG_MS,
  WEBHOOK_REDRIVE_MAX_PER_POLL,
} from "../constants.js";
import { fireWebhookForRecording, type FireOptions } from "../webhook/post.js";
import { emit } from "./events.js";
import type { RecordingRow } from "@applaud/shared";
import { sanitizePlaudSummaryMarkdown } from "@applaud/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long after a recording starts Plaud may still be producing its
 * transcript or summary. Past this, a record with neither is taken as final
 * so old untranscribed recordings don't cost an API call every poll.
 */
const PROCESSING_GRACE_MS = 3 * DAY_MS;

/** Source blocks saved alongside the transcript, by Plaud `data_type`. */
const SOURCE_BLOCK_FILES: Record<string, string> = {
  transaction_polish: "transcript_polished.json",
  outline: "outline.json",
  mark_memo: "highlights.json",
};

/** Normalise a listed file for storage, or null when it lacks a usable start time. */
export function toRecordingMeta(f: PlaudFileSummary): PlaudRecordingMeta | null {
  const startTime = parseApiTimestamp(f.start_at) ?? parseApiTimestamp(f.created_at);
  if (startTime == null) return null;
  return {
    id: f.id,
    filename: f.name?.trim() || f.id,
    startTime,
    durationMs: typeof f.duration === "number" && f.duration > 0 ? Math.round(f.duration) : 0,
    serialNumber: f.serial_number ?? "",
  };
}

/** Copy of a file record without its pre-signed links (they expire in an hour and carry session credentials). */
export function stripSignedLinks(detail: PlaudFileDetail): Record<string, unknown> {
  const strip = (blocks: PlaudContentBlock[] | undefined): Record<string, unknown>[] | undefined =>
    blocks?.map((b) => {
      const rest: Record<string, unknown> = { ...b };
      delete rest.data_link;
      return rest;
    });
  const out: Record<string, unknown> = { ...detail, source_list: strip(detail.source_list), note_list: strip(detail.note_list) };
  delete out.presigned_url;
  return out;
}

/** Pretty-print a JSON string when it parses, else return it unchanged. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function parseSegments(text: string): TranscriptSegment[] {
  const parsed: unknown = JSON.parse(text);
  const arr = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
  return arr.filter(
    (x): x is TranscriptSegment => !!x && typeof x === "object" && typeof (x as TranscriptSegment).content === "string",
  );
}

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
  /** Set by trigger(); consumed on the next poll, which then walks the whole Plaud list. */
  private pendingManualSync = false;
  /** Recording ids currently being fetched/written, guarding scheduled and manual (resync) processing from overlapping on the same row. */
  private processingIds = new Set<string>();
  /**
   * A cycle the watchdog gave up on, still winding down to its next abort
   * checkpoint. New cycles wait for it (up to another watchdog period) so two
   * never run side by side.
   */
  private abandoned: { settled: Promise<void>; since: number } | null = null;
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

  /**
   * Re-fetch one recording's record and rewrite its transcript, notes and
   * metadata (audio is kept when already on disk). Also used to download a
   * recording outside the history window on request.
   */
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
   * Download one recording now, outside the poll cycle (the user asked for a
   * recording older than the history window). Failures are recorded on the
   * row; an auth failure flags "reconnect required" like a poll would.
   */
  downloadInBackground(id: string): void {
    const row = getRecordingById(id);
    if (!row) return;
    void this.processRecording(row).catch((err) => {
      if (err instanceof PlaudAuthError) {
        this.handlePollError(err);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, id }, "on-demand download failed");
      recordError(id, msg);
      emit("error", { recordingId: id, message: msg });
    });
  }

  /**
   * Run a cycle against a hard deadline. Even with per-fetch timeouts, this is
   * a belt-and-suspenders guard so a single poll cycle can never hang
   * `inFlight` (and thus silently no-op every later tick) forever. On timeout
   * the cycle's signal is aborted, so it stops at its next checkpoint rather
   * than running on alongside the next cycle (see `abandoned`).
   */
  private async withWatchdog<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const running = op(controller.signal);
    let timer: NodeJS.Timeout;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`poll cycle exceeded ${POLLER_RUN_WATCHDOG_MS}ms watchdog`);
        controller.abort(err);
        const abandoned = {
          settled: running.then(
            () => undefined,
            () => undefined,
          ),
          since: Date.now(),
        };
        this.abandoned = abandoned;
        void abandoned.settled.then(() => {
          if (this.abandoned === abandoned) this.abandoned = null;
        });
        reject(err);
      }, POLLER_RUN_WATCHDOG_MS);
    });
    try {
      return await Promise.race([running, watchdog]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight) return;
    if (this.abandoned) {
      if (Date.now() - this.abandoned.since < POLLER_RUN_WATCHDOG_MS) {
        logger.warn("previous poll cycle is still stopping after its watchdog fired — skipping this run");
        return;
      }
      // Every unit of work is bounded by a fetch timeout, so this shouldn't
      // happen — but never let one stuck cycle disable syncing for good.
      logger.error("abandoned poll cycle never stopped — starting a new cycle anyway");
      this.abandoned = null;
    }
    this.inFlight = true;
    emit("poll_start");
    try {
      await this.withWatchdog((signal) => this.pollAndProcess(signal));
      this.lastError = null;
    } catch (err) {
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

  /**
   * One poll cycle. `signal` is aborted by the watchdog; it is checked between
   * units of work (list pages, recordings, deliveries), each of which is
   * bounded by its own fetch timeouts — so an abandoned cycle stops within
   * one unit instead of running to completion in the background.
   */
  private async pollAndProcess(signal: AbortSignal): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.token || !cfg.recordingsDir || !cfg.setupComplete) return;
    if (cfg.installedAt == null) updateConfig({ installedAt: Date.now() });

    const isManualSync = this.pendingManualSync;
    if (isManualSync) this.pendingManualSync = false;

    this.authRequired = false;
    purgeExpiredSoftDeletes();

    await this.discover(signal, isManualSync || loadConfig().libraryIndexedAt == null);

    // Phase 2 — Fetch: every recording inside the history window (or
    // requested by the user) that is missing an asset. Each asset is retried
    // independently on every poll until it is downloaded.
    const needy = findRecordingsNeedingAssets();
    for (const row of needy) {
      signal.throwIfAborted();
      await this.processRecording(row).catch((err) => {
        // An auth failure must bubble out to runOnce so "reconnect required"
        // shows, never get swallowed as a per-row error.
        if (err instanceof PlaudAuthError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, id: row.id }, "processRecording failed");
        recordError(row.id, msg);
        emit("error", { recordingId: row.id, message: msg });
      });
    }

    // Phase 2b — Webhook re-drive: a downloaded asset whose delivery never
    // succeeded is re-fired here, so a delivery lost after the in-process
    // backoff window recovers without a manual Redeliver. Bounded so a dead
    // receiver can't stall the cycle: only assets downloaded since the webhook
    // was enabled, per-row DB back-off, one attempt each, a per-poll cap, and
    // the batch stops at the first failure (the receiver is likely down — the
    // rest wait for the next poll). No-op when no webhook is configured.
    if (cfg.webhook?.enabled && cfg.webhook.url) {
      const due = findRecordingsNeedingWebhook({
        cutoff: cfg.webhook.enabledAt ?? 0,
        now: Date.now(),
        limit: WEBHOOK_REDRIVE_MAX_PER_POLL,
      });
      for (const { row, event } of due) {
        signal.throwIfAborted();
        if (!(await this.deliverWebhook(event, row, { maxAttempts: 1 }))) {
          logger.info({ id: row.id, event }, "webhook re-drive failed — deferring the rest to the next poll");
          break;
        }
      }
    }
  }

  /**
   * Phase 1 — Discovery: walk Plaud's file list (newest first) and index every
   * recording's metadata. Nothing is downloaded here, so indexing the whole
   * library is cheap. Once the library has been walked to the end, routine
   * polls stop at the first page holding nothing new; a full walk still runs
   * on Sync Now so renames of older recordings are picked up.
   */
  private async discover(signal: AbortSignal, fullWalk: boolean): Promise<void> {
    let indexed = 0;
    let reachedEnd = false;
    for (let page = 1; page <= POLLER_LIST_MAX_PAGES; page++) {
      signal.throwIfAborted();
      const items = await listFiles({ page, pageSize: POLLER_LIST_PAGE_SIZE });
      signal.throwIfAborted();
      const known = knownRecordingIds(items.map((i) => i.id));
      let newOnPage = 0;
      for (const item of items) {
        if (!known.has(item.id)) newOnPage++;
        try {
          if (isSyncIgnoredId(item.id)) continue;
          const meta = toRecordingMeta(item);
          if (!meta) {
            logger.warn({ id: item.id }, "listed recording has no usable start time — skipped");
            continue;
          }
          if (getRecordingById(item.id)?.userDeletedAt) continue;
          upsertFromPlaud(meta);
          indexed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, id: item.id }, "upsert failed");
          recordError(item.id, msg);
          emit("error", { recordingId: item.id, message: msg });
        }
      }
      if (items.length < POLLER_LIST_PAGE_SIZE) {
        reachedEnd = true;
        break;
      }
      if (!fullWalk && newOnPage === 0) break;
    }
    if (reachedEnd) updateConfig({ libraryIndexedAt: Date.now() });
    logger.info({ indexed, fullWalk, reachedEnd }, "list walk complete");
  }

  /**
   * Fetch one recording's record and download whatever is missing: audio,
   * transcript (plus polished transcript, outline and highlights), and every
   * note tab (the summary becomes `summary.md`). `force` rewrites existing
   * text files (a resync); audio already on disk is never re-downloaded.
   */
  private async processRecording(row: RecordingRow, force = false): Promise<void> {
    // Guards the scheduled Phase 2 loop and a manual resync from ever writing
    // the same recording's files concurrently.
    if (this.processingIds.has(row.id)) return;
    this.processingIds.add(row.id);
    try {
      const cfg = loadConfig();
      if (!cfg.recordingsDir) return;
      if (isSyncIgnoredId(row.id)) return;
      if (row.userDeletedAt) return;

      let detail: PlaudFileDetail;
      try {
        detail = await getFile(row.id);
      } catch (err) {
        if (err instanceof PlaudApiError && err.status === 404) {
          throw new Error("Plaud no longer has this recording", { cause: err });
        }
        throw err;
      }

      // Signed links expire after an hour, so everything below runs straight
      // after the record is fetched.
      const audioExt = detail.presigned_url ? audioExtensionFromUrl(detail.presigned_url) : null;
      // Known audio containers only; anything else keeps the default name.
      const audioFilename = audioExt ? audioFilenameForFiletype(audioExt) : row.audioFilename;
      if (!row.audioDownloadedAt && audioFilename !== row.audioFilename) setAudioFilename(row.id, audioFilename);
      const paths = ensureRecordingFolder(cfg.recordingsDir, row.folder, row.audioDownloadedAt ? row.audioFilename : audioFilename);

      writeFileAtomic(paths.metadataPath, JSON.stringify(stripSignedLinks(detail), null, 2));

      // An audio failure is recorded last, so a transcript written after it
      // (which clears last_error) can't hide why the audio is missing.
      let audioError: string | null = null;
      if (!row.audioDownloadedAt) {
        if (!detail.presigned_url) {
          // Usually a transient signing gap on Plaud's side; retried next poll.
          audioError = "Plaud returned no audio link for this recording yet";
        } else {
          try {
            const bytes = await downloadToFile(detail.presigned_url, paths.audioPath);
            markAudioDownloaded(row.id, bytes);
            emit("recording_new", { recordingId: row.id });
            const fresh = getRecordingById(row.id);
            if (fresh) await this.deliverWebhook("audio_ready", fresh);
          } catch (err) {
            audioError = err instanceof Error ? err.message : String(err);
            logger.warn({ err, id: row.id }, "audio download failed");
          }
        }
      }

      const sources = detail.source_list ?? [];
      const notes = detail.note_list ?? [];
      let wroteTranscript = false;

      const transaction = sources.find((b) => b.data_type === "transaction");
      if (transaction && (force || !row.transcriptDownloadedAt)) {
        try {
          const segments = parseSegments(await loadBlockContent(transaction));
          if (segments.length > 0) {
            writeFileAtomic(paths.transcriptJsonPath, JSON.stringify(segments, null, 2));
            const text = flattenTranscript(segments);
            writeFileAtomic(paths.transcriptTxtPath, text);
            markTranscriptDownloaded(row.id, text);
            wroteTranscript = true;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, id: row.id }, "transcript download failed");
          recordError(row.id, `transcript: ${msg}`);
        }
      }

      for (const block of sources) {
        const fileName = block.data_type ? SOURCE_BLOCK_FILES[block.data_type] : undefined;
        if (!fileName) continue;
        await this.saveBlock(block, path.join(paths.folder, fileName), force, prettyJson, row.id);
      }

      let hasSummary = false;
      for (const note of notes) {
        const isSummary = note.data_type === "auto_sum_note";
        if (isSummary) hasSummary = true;
        const dest = isSummary ? paths.summaryMdPath : path.join(paths.folder, noteFileName(note));
        const toMarkdown = (raw: string): string =>
          sanitizePlaudSummaryMarkdown(extractMarkdownFromSummaryPayload(raw) ?? raw, {
            startTimeMs: row.startTime,
            endTimeMs: row.endTime,
          });
        const wrote = await this.saveBlock(note, dest, force || (isSummary && !row.summaryDownloadedAt), toMarkdown, row.id);
        if (isSummary && wrote) markSummaryDownloaded(row.id);
      }

      // Keep polling for a transcript/summary only while Plaud may still be
      // producing one; a manual resync re-arms both.
      const young = row.startTime > Date.now() - PROCESSING_GRACE_MS;
      setPlaudAvailability(row.id, !!transaction || young, hasSummary || young);

      if (audioError) {
        recordError(row.id, audioError);
        emit("error", { recordingId: row.id, message: audioError });
      }

      if (wroteTranscript) {
        emit("recording_downloaded", { recordingId: row.id });
        // Fires on a null→set transition: the first download, or a resync
        // (which clears the transcript state first).
        const fresh = getRecordingById(row.id);
        if (fresh) await this.deliverWebhook("transcript_ready", fresh);
      }
    } finally {
      this.processingIds.delete(row.id);
    }
  }

  /**
   * Write one content block to `dest` (skipped when it exists and `force` is
   * off). Returns whether a file was written. Failures are logged, not
   * thrown, so one bad block never blocks the rest of the recording.
   */
  private async saveBlock(
    block: PlaudContentBlock,
    dest: string,
    force: boolean,
    transform: (raw: string) => string,
    recordingId: string,
  ): Promise<boolean> {
    if (!force && existsSync(dest)) return false;
    try {
      const raw = await loadBlockContent(block);
      if (raw.trim().length === 0) return false;
      writeFileAtomic(dest, transform(raw));
      return true;
    } catch (err) {
      logger.warn({ err, id: recordingId, dataType: block.data_type }, "content block download failed");
      return false;
    }
  }

  /**
   * Fire a webhook and record the outcome: success marks it delivered; failure
   * schedules the next automatic re-delivery (so Phase 2b doesn't immediately
   * re-fire a delivery that just failed). Returns whether it was delivered;
   * false without side effects when no webhook is configured.
   */
  private async deliverWebhook(
    event: "audio_ready" | "transcript_ready",
    row: RecordingRow,
    opts?: FireOptions,
  ): Promise<boolean> {
    const cfg = loadConfig();
    if (!cfg.webhook?.enabled || !cfg.webhook.url) return false;
    try {
      if (await fireWebhookForRecording(event, row, opts)) {
        markWebhookFired(row.id, event);
        return true;
      }
    } catch (err) {
      logger.warn({ err, id: row.id, event }, "webhook delivery threw");
    }
    recordWebhookFailure(row.id, event);
    return false;
  }
}

/** File name for a non-summary note tab, e.g. `Meeting_minutes__consumer_note__1a2b3c4d.md`. */
export function noteFileName(note: PlaudContentBlock): string {
  const label =
    sanitizeFilename(note.data_tab_name || note.data_title || note.data_type || "note") || "note";
  const type = sanitizeFilename(note.data_type || "note") || "note";
  const id = (note.data_id ?? "").slice(-8) || "unknown";
  return `${label}__${type}__${id}.md`;
}

export const poller = new Poller();
