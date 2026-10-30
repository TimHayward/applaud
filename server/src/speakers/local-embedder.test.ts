import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalEmbedder, classifyExit, type LocalEmbedderOptions } from "./local-embedder.js";
import { EmbedderError } from "./embedder.js";
import { EXIT_LOAD_FAILED } from "./protocol.js";

const FAKE = fileURLToPath(new URL("../test/fixtures/fake-speaker-process.mjs", import.meta.url));

let root: string;
let audio: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(path.join(os.tmpdir(), "applaud-embedder-"));
  root = path.join(base, "recordings");
  mkdirSync(path.join(root, "rec"), { recursive: true });
  audio = path.join(root, "rec", "audio.ogg");
  writeFileSync(audio, "");
  outside = path.join(base, "elsewhere.ogg");
  writeFileSync(outside, "");
});

afterAll(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

let embedder: LocalEmbedder | null = null;

function make(mode: string, opts: Partial<LocalEmbedderOptions> = {}): LocalEmbedder {
  embedder = new LocalEmbedder({
    modelPath: "unused.onnx",
    allowedRoot: () => root,
    modulePath: FAKE,
    execArgv: [],
    env: { FAKE_MODE: mode },
    ...opts,
  });
  return embedder;
}

const windows = [
  { id: "a", startMs: 0, endMs: 5000 },
  { id: "b", startMs: 6000, endMs: 9000 },
];

afterEach(() => {
  embedder?.stop();
  embedder = null;
});

describe("LocalEmbedder", () => {
  it("starts the speaker process on demand and returns its vectors", async () => {
    const e = make("ok");
    expect(e.running).toBe(false);
    const result = await e.embed({ audioPath: audio, windows });
    expect(e.running).toBe(true);
    expect(result.modelId).toBe("fake@00000000");
    expect(result.dim).toBe(4);
    expect(result.vectors.map((v) => v.id)).toEqual(["a", "b"]);
    expect(result.vectors[0]?.vector).toBeInstanceOf(Float32Array);
  });

  it("reports health from a probe", async () => {
    const health = await make("ok").health();
    expect(health).toMatchObject({ ok: true, modelId: "fake@00000000", dim: 4 });
  });

  it("reports an unexpected probe result as unavailable", async () => {
    expect(await make("bad_probe").health()).toMatchObject({ ok: false, status: "unavailable" });
  });

  it("reports a model that can't load as unsupported, with the reason", async () => {
    const health = await make("load_fail").health();
    expect(health).toMatchObject({ ok: false, status: "unsupported" });
    expect(health.ok === false && health.reason).toContain("libonnxruntime");
  });

  it("fails only the request in flight when the process crashes, then recovers", async () => {
    const e = make("crash_on_embed");
    await expect(e.embed({ audioPath: audio, windows })).rejects.toMatchObject({ code: "crashed" });
    expect(e.running).toBe(false);
    // A fresh process answers the next request.
    expect(await e.health()).toMatchObject({ ok: true });
  });

  it("times out a request that never answers and kills the process", async () => {
    const e = make("hang", { requestTimeoutMs: 200 });
    await expect(e.embed({ audioPath: audio, windows })).rejects.toMatchObject({ code: "timeout" });
    expect(e.running).toBe(false);
  });

  it("times out a process that never loads", async () => {
    const health = await make("never_ready", { readyTimeoutMs: 200 }).health();
    expect(health).toMatchObject({ ok: false, status: "unavailable" });
  });

  it("passes on a decode failure", async () => {
    await expect(make("decode_error").embed({ audioPath: audio, windows })).rejects.toMatchObject({
      code: "decode_failed",
    });
  });

  it("stops the process after the idle period", async () => {
    const e = make("ok", { idleMs: 100 });
    await e.health();
    expect(e.running).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(e.running).toBe(false);
  });

  it("runs concurrent requests one after another", async () => {
    const e = make("ok");
    const results = await Promise.all([e.embed({ audioPath: audio, windows }), e.health(), e.embed({ audioPath: audio, windows })]);
    expect(results.map((r) => ("vectors" in r ? r.vectors.length : r.ok))).toEqual([2, true, 2]);
  });

  describe("refuses bad requests before starting the process", () => {
    it.each([
      ["audio outside the recordings directory", () => ({ audioPath: outside, windows })],
      ["a path that climbs out", () => ({ audioPath: path.join(root, "rec", "..", "..", "elsewhere.ogg"), windows })],
      ["a missing file", () => ({ audioPath: path.join(root, "rec", "missing.ogg"), windows })],
      ["no windows", () => ({ audioPath: audio, windows: [] })],
      ["an empty window", () => ({ audioPath: audio, windows: [{ id: "x", startMs: 5, endMs: 5 }] })],
      ["an over-long window", () => ({ audioPath: audio, windows: [{ id: "x", startMs: 0, endMs: 31_000 }] })],
      ["a negative start", () => ({ audioPath: audio, windows: [{ id: "x", startMs: -1, endMs: 1000 }] })],
    ])("%s", async (_name, req) => {
      const e = make("ok");
      await expect(e.embed(req())).rejects.toMatchObject({ code: "bad_request" });
      expect(e.running).toBe(false);
    });

    it("everything when no recordings directory is set", async () => {
      const e = make("ok", { allowedRoot: () => null });
      await expect(e.embed({ audioPath: audio, windows })).rejects.toMatchObject({ code: "bad_request" });
    });
  });
});

describe("classifyExit", () => {
  it.each([
    [EXIT_LOAD_FAILED, null, null, "unsupported"],
    [1, null, "cannot open shared object", "unsupported"],
    [null, "SIGILL", null, "unsupported"],
    [null, "SIGKILL", null, "crashed"],
    [1, null, null, "crashed"],
    [null, "SIGSEGV", null, "crashed"],
  ] as const)("code %s, signal %s, fatal %s → %s", (code, signal, fatal, expected) => {
    const e = classifyExit(code, signal, fatal);
    expect(e).toBeInstanceOf(EmbedderError);
    expect(e.code).toBe(expected);
  });

  it("names AVX for an illegal instruction and memory for a kill", () => {
    expect(classifyExit(null, "SIGILL", null).message).toContain("AVX");
    expect(classifyExit(null, "SIGKILL", null).message).toContain("memory");
  });
});
