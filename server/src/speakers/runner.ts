import type { SpeakerState, SpeakerStatus } from "@applaud/shared";
import { logger } from "../logger.js";
import { analyseRecording, enrolOwner, recordingsWithStaleVoiceprints, reembedRecording } from "./analyse.js";
import { rematchAll } from "./assign.js";
import { EmbedderError, type Embedder } from "./embedder.js";
import {
  claimNextJob,
  completeJob,
  enqueueBackfill,
  enqueueJob,
  failJob,
  jobCounts,
  nextDueAt,
  pendingJobs,
  requeueRunning,
  type JobKind,
  type SpeakerJob,
} from "./jobs.js";
import type { MatchThresholds } from "./matcher.js";
import { analysedRecordings, writeApplaudTranscript } from "./outputs.js";

export interface RunnerSettings {
  enabled: boolean;
  recordingsDir: string | null;
  minSpeechMs: number;
  activeModelId: string | null;
  thresholds: MatchThresholds;
}

export interface RunnerDeps {
  embedder: Embedder;
  settings: () => RunnerSettings;
  /** The owner's Plaud name (D17), or null when unknown. */
  ownerName: () => Promise<string | null>;
  setActiveModel: (modelId: string) => void;
  now?: () => number;
}

/** After this many crashes or timeouts in a row, re-run the capability check. */
const CRASHES_BEFORE_RECHECK = 3;
const MAX_SLEEP_MS = 3_600_000;

/**
 * Runs speaker jobs one at a time, apart from the sync poller. Nothing here
 * throws into the caller: every failure is recorded on the job and in the
 * status, and Plaud's labels are never touched.
 */
export class SpeakerRunner {
  private state: SpeakerState = "off";
  private reason: string | null = null;
  private modelId: string | null = null;
  private dim: number | null = null;
  private current: string | null = null;
  private lastRun: SpeakerStatus["lastRun"] = null;
  private crashes = 0;
  private loopPromise: Promise<void> | null = null;
  private checking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reembedQueuedFor: string | null = null;

  constructor(private readonly deps: RunnerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** On startup or when switched on: recover, backfill, check, run. */
  start(): void {
    if (!this.deps.settings().enabled) {
      this.state = "off";
      return;
    }
    requeueRunning(this.now());
    // Outputs for recordings analysed before matching existed, or changed while off.
    this.refresh(analysedRecordings());
    this.backfill();
    void this.check();
  }

  /** Queue every downloaded recording not yet analysed (on start and after each sync). */
  backfill(): number {
    if (!this.deps.settings().enabled) return 0;
    const queued = enqueueBackfill(this.now());
    if (queued > 0) {
      logger.info({ queued }, "speaker identification: queued recordings for analysis");
      this.kick();
    }
    return queued;
  }

  /** When switched off: stop the model process and the queue. Queued jobs stay for next time. */
  stop(): void {
    this.state = "off";
    this.reason = null;
    this.clearTimer();
    this.deps.embedder.stop();
  }

  /** Run the capability check (the Settings Retry button) and resume jobs if it passes. */
  async check(): Promise<SpeakerStatus> {
    if (!this.deps.settings().enabled) {
      this.state = "off";
      return this.status();
    }
    if (!this.checking) {
      this.checking = this.runCheck().finally(() => {
        this.checking = null;
      });
    }
    await this.checking;
    return this.status();
  }

  private async runCheck(): Promise<void> {
    this.state = "checking";
    this.reason = null;
    const health = await this.deps.embedder.health();
    if (!this.deps.settings().enabled) {
      this.state = "off";
      return;
    }
    if (health.ok) {
      this.state = "available";
      this.modelId = health.modelId;
      this.dim = health.dim;
      this.crashes = 0;
      logger.info({ modelId: health.modelId, probeMs: health.probeMs }, "speaker identification available");
      this.onModel(health.modelId);
      this.kick();
    } else {
      this.state = health.status;
      this.reason = health.reason;
      logger.warn({ status: health.status, reason: health.reason }, "speaker identification not available");
    }
  }

  /** Queue a recording (after a transcript arrives, or on Re-analyse). */
  enqueue(kind: JobKind, recordingId: string): void {
    if (!this.deps.settings().enabled) return;
    enqueueJob(kind, recordingId, this.now());
    this.kick();
  }

  /** The owner name changed: relabel from stored centroids; no model run needed. */
  async ownerChanged(): Promise<void> {
    if (!this.deps.settings().enabled) return;
    enrolOwner(await this.deps.ownerName(), this.deps.settings().minSpeechMs, this.now());
    this.refresh();
  }

  /**
   * The user changed a recording's labels (which may have changed the library):
   * re-apply the owner tag to labels handed back, re-match, rewrite outputs.
   */
  async labelsChanged(recordingId: string): Promise<void> {
    if (!this.deps.settings().enabled) return;
    enrolOwner(await this.deps.ownerName(), this.deps.settings().minSpeechMs, this.now());
    this.refresh([recordingId]);
  }

  /**
   * Re-match every recording from stored centroids (no model run) and rewrite
   * the `-Applaud` transcripts that changed, plus those of `recordings`.
   */
  refresh(recordings: Iterable<string> = []): void {
    const s = this.deps.settings();
    if (!s.enabled) return;
    let changed: string[] = [];
    try {
      changed = rematchAll(s.activeModelId, s.thresholds, this.now());
    } catch (err) {
      logger.warn({ err: describeError(err) }, "speaker matching failed");
    }
    if (!s.recordingsDir) return;
    for (const id of new Set([...changed, ...recordings])) {
      try {
        writeApplaudTranscript(s.recordingsDir, id);
      } catch (err) {
        logger.warn({ recordingId: id, err: describeError(err) }, "could not write the Applaud transcript");
      }
    }
  }

  /** Resolves when the current run of the queue finishes (tests). */
  async idle(): Promise<void> {
    while (this.checking || this.loopPromise) {
      await this.checking;
      await this.loopPromise;
    }
  }

  status(): SpeakerStatus {
    const enabled = this.deps.settings().enabled;
    const counts = enabled ? jobCounts() : { queued: 0, failed: 0 };
    return {
      state: enabled ? this.state : "off",
      reason: this.reason,
      modelId: this.modelId,
      dim: this.dim,
      activeModelId: this.deps.settings().activeModelId,
      ...counts,
      reembedding: enabled ? pendingJobs("reembed") : 0,
      current: this.current,
      lastRun: this.lastRun,
    };
  }

  private kick(): void {
    if (this.state !== "available" || this.loopPromise) return;
    this.loopPromise = this.loop().finally(() => {
      this.loopPromise = null;
      this.schedule();
    });
  }

  private async loop(): Promise<void> {
    this.clearTimer();
    while (this.state === "available" && this.deps.settings().enabled) {
      const job = claimNextJob(this.now());
      if (!job) break;
      await this.runJob(job);
    }
    this.current = null;
  }

  /** Wake up when the next backed-off job becomes due. */
  private schedule(): void {
    this.clearTimer();
    if (this.state !== "available" || !this.deps.settings().enabled) return;
    const due = nextDueAt();
    if (due === null) return;
    const delay = Math.min(MAX_SLEEP_MS, Math.max(1_000, due - this.now()));
    this.timer = setTimeout(() => this.kick(), delay);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async runJob(job: SpeakerJob): Promise<void> {
    const s = this.deps.settings();
    if (!s.recordingsDir) {
      failJob(job, "no recordings directory is configured", { countAttempt: false }, this.now());
      return;
    }
    this.current = job.recordingId;
    const ctx = { embedder: this.deps.embedder, recordingsDir: s.recordingsDir, now: () => this.now() };
    try {
      const out =
        job.kind === "analyse" ? await analyseRecording(ctx, job.recordingId) : await reembedRecording(ctx, job.recordingId);
      if (out.done && out.modelId) this.onModel(out.modelId);
      if (out.done && job.kind === "analyse") enrolOwner(await this.deps.ownerName(), s.minSpeechMs, this.now());
      // Not done means nothing to analyse yet (no audio); the next transcript
      // download queues the recording again.
      completeJob(job, this.now());
      if (out.done && job.kind === "analyse") this.refresh([job.recordingId]);
      if (job.kind === "reembed") this.maybeActivateModel();
      this.crashes = 0;
      this.lastRun = { recordingId: job.recordingId, kind: job.kind, at: this.now(), ok: true, error: out.done ? null : out.reason };
    } catch (err) {
      this.onJobError(job, err);
    }
  }

  private onJobError(job: SpeakerJob, err: unknown): void {
    const code = err instanceof EmbedderError ? err.code : null;
    const message = describeError(err);
    this.lastRun = { recordingId: job.recordingId, kind: job.kind, at: this.now(), ok: false, error: message };
    logger.warn({ recordingId: job.recordingId, kind: job.kind, code }, "speaker job failed");
    if (code === "unsupported") {
      failJob(job, message, { countAttempt: false }, this.now());
      this.state = "unsupported";
      this.reason = message;
      return;
    }
    if (code === "stopped") {
      failJob(job, message, { countAttempt: false }, this.now());
      return;
    }
    failJob(job, message, {}, this.now());
    if (code === "crashed" || code === "timeout") {
      this.crashes++;
      if (this.crashes >= CRASHES_BEFORE_RECHECK) {
        this.crashes = 0;
        // Pauses the queue until the check passes; the loop exits when it doesn't.
        this.state = "checking";
        this.checking = this.runCheck().finally(() => {
          this.checking = null;
        });
      }
    }
  }

  /**
   * Record the model in use. When it differs from the one the library was
   * built with, queue re-embedding of every voiceprint (D14); the new model
   * becomes active once that queue drains.
   */
  private onModel(modelId: string): void {
    this.modelId = modelId;
    const active = this.deps.settings().activeModelId;
    if (!active) {
      this.deps.setActiveModel(modelId);
      return;
    }
    if (active === modelId || this.reembedQueuedFor === modelId) return;
    this.reembedQueuedFor = modelId;
    const stale = recordingsWithStaleVoiceprints(modelId);
    logger.info({ from: active, to: modelId, recordings: stale.length }, "speaker model changed: re-embedding voiceprints");
    for (const id of stale) enqueueJob("reembed", id, this.now());
    this.maybeActivateModel();
  }

  private maybeActivateModel(): void {
    if (!this.modelId || this.deps.settings().activeModelId === this.modelId) return;
    if (pendingJobs("reembed") > 0) return;
    this.deps.setActiveModel(this.modelId);
    logger.info({ modelId: this.modelId }, "speaker model active");
    this.refresh();
  }
}

/** A message for the job and status without file paths (recording folders carry titles). */
export function describeError(err: unknown): string {
  if (err instanceof EmbedderError) return err.message;
  if (err instanceof SyntaxError) return "transcript.json is not valid JSON";
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return `file error (${err.code})`;
  }
  return "unexpected error";
}
