import { fork, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EmbedderError,
  type Embedder,
  type EmbedderHealth,
  type EmbedRequest,
  type EmbedResult,
} from "./embedder.js";
import {
  EXIT_LOAD_FAILED,
  MAX_TOTAL_WINDOW_MS,
  MAX_WINDOW_MS,
  MAX_WINDOWS,
  type FromChild,
  type ToChild,
  type ToChildRequest,
} from "./protocol.js";

export interface LocalEmbedderOptions {
  /** The model file (`.onnx`). */
  modelPath: string;
  /** Audio must resolve inside this directory; null refuses every request. */
  allowedRoot: () => string | null;
  threads?: number;
  /** Stop the speaker process after this long with no request. */
  idleMs?: number;
  /** How long the speaker process may take to load the model. */
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  ffmpegPath?: string;
  /** Override the speaker process entry point (tests). */
  modulePath?: string;
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
}

interface Ready {
  modelId: string;
  dim: number;
}

interface Pending {
  id: number;
  resolve: (msg: FromChild) => void;
  reject: (err: EmbedderError) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_IDLE_MS = 300_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

/**
 * Runs the speaker model in a child process (embedder-process.ts), started on
 * the first request and stopped after `idleMs` without one. Requests run one
 * at a time. A crash fails only the request in flight; the next request
 * starts a fresh process.
 */
export class LocalEmbedder implements Embedder {
  private child: ChildProcess | null = null;
  private ready: Promise<Ready> | null = null;
  private pending: Pending | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 1;

  constructor(private readonly opts: LocalEmbedderOptions) {}

  /** Whether the speaker process is running. */
  get running(): boolean {
    return this.child !== null;
  }

  async health(): Promise<EmbedderHealth> {
    const started = Date.now();
    try {
      const { ready, reply } = await this.run({ type: "probe" });
      if (reply.type !== "probe" || reply.dim !== ready.dim || ready.dim === 0) {
        return { ok: false, status: "unavailable", reason: "the speaker model returned an unexpected result" };
      }
      return { ok: true, modelId: ready.modelId, dim: ready.dim, probeMs: Date.now() - started };
    } catch (err) {
      const e = asEmbedderError(err);
      return { ok: false, status: e.code === "unsupported" ? "unsupported" : "unavailable", reason: e.message };
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const audioPath = this.checkPath(req.audioPath);
    checkWindows(req);
    const { ready, reply } = await this.run({ type: "embed", audioPath, windows: req.windows });
    if (reply.type === "error") throw new EmbedderError(reply.code, reply.message);
    if (reply.type !== "result") throw new EmbedderError("crashed", "unexpected reply from the speaker process");
    return { modelId: ready.modelId, dim: ready.dim, ...reply.result };
  }

  stop(): void {
    this.clearIdle();
    const child = this.child;
    if (!child) return;
    this.failPending(new EmbedderError("stopped", "the speaker process was stopped"));
    this.reset();
    child.kill();
  }

  /** Queue a request behind any in flight, starting the process if needed. */
  private run(msg: ToChildRequest): Promise<{ ready: Ready; reply: FromChild }> {
    const p = this.chain.then(() => this.request(msg));
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async request(msg: ToChildRequest): Promise<{ ready: Ready; reply: FromChild }> {
    this.clearIdle();
    try {
      const ready = await this.start();
      const child = this.child;
      // It loaded, then died before this request was sent.
      if (!child) throw new EmbedderError("crashed", "the speaker process exited unexpectedly");
      const id = this.nextId++;
      const reply = await new Promise<FromChild>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.failPending(new EmbedderError("timeout", "the speaker process did not answer in time"));
          this.kill();
        }, this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
        this.pending = { id, resolve, reject, timer };
        child.send({ ...msg, id } as ToChild);
      });
      return { ready, reply };
    } finally {
      this.scheduleIdle();
    }
  }

  private start(): Promise<Ready> {
    if (this.ready) return this.ready;
    const child = fork(this.opts.modulePath ?? defaultModulePath(), [], {
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: this.opts.execArgv ?? defaultExecArgv(),
      env: this.childEnv(),
    });
    this.child = child;
    let fatal: string | null = null;
    this.ready = new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new EmbedderError("timeout", "the speaker model took too long to load"));
        this.kill();
      }, this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
      child.on("message", (msg: FromChild) => {
        if (msg.type === "ready") {
          clearTimeout(timer);
          resolve({ modelId: msg.modelId, dim: msg.dim });
        } else if (msg.type === "fatal") {
          fatal = msg.message;
        } else if (this.pending && "id" in msg && msg.id === this.pending.id) {
          const p = this.pending;
          this.pending = null;
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        const e = new EmbedderError("crashed", `the speaker process could not start: ${err.message}`);
        reject(e);
        if (this.child === child) {
          this.failPending(e);
          this.reset();
        }
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        const e = classifyExit(code, signal, fatal);
        reject(e);
        if (this.child === child) {
          this.failPending(e);
          this.reset();
        }
      });
    });
    // Avoid an unhandled rejection when the process dies with nobody waiting.
    this.ready.catch(() => undefined);
    return this.ready;
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      APPLAUD_SPEAKER_MODEL: this.opts.modelPath,
      APPLAUD_SPEAKER_THREADS: String(this.opts.threads ?? 2),
      APPLAUD_FFMPEG: this.opts.ffmpegPath ?? "ffmpeg",
      ...this.opts.env,
    };
    // The prebuilt addon loads onnxruntime from its own package directory.
    const native = nativeLibraryDir();
    const prepend = (current: string | undefined): string =>
      [native, current].filter(Boolean).join(path.delimiter);
    if (native && process.platform === "linux") env.LD_LIBRARY_PATH = prepend(process.env.LD_LIBRARY_PATH);
    else if (native && process.platform === "darwin") env.DYLD_LIBRARY_PATH = prepend(process.env.DYLD_LIBRARY_PATH);
    else if (native && process.platform === "win32") env.PATH = prepend(process.env.PATH);
    return env;
  }

  private checkPath(audioPath: string): string {
    const root = this.opts.allowedRoot();
    if (!root) throw new EmbedderError("bad_request", "no recordings directory is configured");
    let real: string;
    let realRoot: string;
    try {
      real = realpathSync(audioPath);
      realRoot = realpathSync(root);
    } catch {
      throw new EmbedderError("bad_request", "audio file not found");
    }
    const rel = path.relative(realRoot, real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new EmbedderError("bad_request", "audio file is outside the recordings directory");
    }
    return real;
  }

  private failPending(err: EmbedderError): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  private kill(): void {
    const child = this.child;
    this.reset();
    child?.kill("SIGKILL");
  }

  private reset(): void {
    this.child = null;
    this.ready = null;
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (!this.child) return;
    this.idleTimer = setTimeout(() => this.stop(), this.opts.idleMs ?? DEFAULT_IDLE_MS);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** Why the speaker process exited, as an error for whoever was waiting on it. */
export function classifyExit(code: number | null, signal: NodeJS.Signals | null, fatal: string | null): EmbedderError {
  if (code === EXIT_LOAD_FAILED || fatal) {
    return new EmbedderError(
      "unsupported",
      `the speaker model could not be loaded on this host${fatal ? ` (${fatal})` : ""}`,
    );
  }
  if (signal === "SIGILL") {
    return new EmbedderError(
      "unsupported",
      "this CPU lacks an instruction the speaker model needs (AVX on x86 hosts)",
    );
  }
  if (signal === "SIGKILL") {
    return new EmbedderError("crashed", "the speaker process was killed, most likely for running out of memory");
  }
  return new EmbedderError("crashed", `the speaker process exited unexpectedly (${signal ?? `exit code ${code}`})`);
}

function checkWindows(req: EmbedRequest): void {
  if (req.windows.length === 0) throw new EmbedderError("bad_request", "no windows to embed");
  if (req.windows.length > MAX_WINDOWS) throw new EmbedderError("bad_request", `more than ${MAX_WINDOWS} windows`);
  let total = 0;
  for (const w of req.windows) {
    const len = w.endMs - w.startMs;
    if (!Number.isFinite(len) || w.startMs < 0 || len <= 0 || len > MAX_WINDOW_MS) {
      throw new EmbedderError("bad_request", `window ${w.id} must be 0 to ${MAX_WINDOW_MS / 1000} s long`);
    }
    total += len;
  }
  if (total > MAX_TOTAL_WINDOW_MS) {
    throw new EmbedderError("bad_request", `windows total more than ${MAX_TOTAL_WINDOW_MS / 60_000} minutes`);
  }
}

function asEmbedderError(err: unknown): EmbedderError {
  return err instanceof EmbedderError ? err : new EmbedderError("crashed", err instanceof Error ? err.message : String(err));
}

// Under tsx (`pnpm dev`) this file is .ts and the child must be loaded through
// tsx too; in the built server both are plain .js.
const SELF = fileURLToPath(import.meta.url);
const IS_TS = SELF.endsWith(".ts");

function defaultModulePath(): string {
  return path.join(path.dirname(SELF), `embedder-process.${IS_TS ? "ts" : "js"}`);
}

function defaultExecArgv(): string[] {
  return IS_TS ? ["--import", "tsx"] : [];
}

/** Directory of the platform's prebuilt sherpa-onnx package, or null. */
function nativeLibraryDir(): string | null {
  try {
    const wrapper = createRequire(import.meta.url).resolve("sherpa-onnx-node/package.json");
    const platform = process.platform === "win32" ? "win" : process.platform;
    const pkg = createRequire(wrapper).resolve(`sherpa-onnx-${platform}-${process.arch}/package.json`);
    return path.dirname(pkg);
  } catch {
    return null;
  }
}
