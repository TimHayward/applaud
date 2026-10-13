import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { DEFAULT_CONFIG, type AppConfig, type RecordingRow, type WebhookPayload } from "@applaud/shared";

const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
vi.mock("../config.js", () => ({ loadConfig }));

// The SSRF guard resolves the target before connecting (see security/ssrf.ts).
// `hook.example` doesn't exist, so pin it to a public address and let the real
// guard run — the blocked-target case below still exercises it for real.
const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
vi.mock("node:dns/promises", () => ({ lookup }));

import { fireRaw, fireWebhookForRecording } from "./post.js";
import { verifyTicket } from "../auth/ticket.js";
import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { installFetchMock, type FetchMock } from "../test/fixtures/fetch.js";

const samplePayload: WebhookPayload = {
  event: "audio_ready",
  recording: {
    id: "rec-1",
    filename: "sample.ogg",
    start_time_ms: 1_000_000,
    end_time_ms: 1_060_000,
    duration_ms: 60_000,
    filesize_bytes: 100,
    serial_number: "S1",
  },
  files: { folder: "f", audio: "f/a.ogg", transcript: "f/t.json", summary: "f/s.md" },
  http_urls: { audio: "x", transcript: "x", summary: "x" },
};

describe("fireRaw retry loop", () => {
  let db: Database.Database;
  let mock: FetchMock;

  beforeEach(() => {
    db = setupTestDb();
    mock = installFetchMock();
    // Skip the real 5s/30s/120s waits between attempts.
    vi.useFakeTimers();
  });

  afterEach(() => {
    mock.restore();
    teardownTestDb(db);
    vi.useRealTimers();
  });

  function logRowCount(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM webhook_log").get() as { c: number }).c;
  }

  /**
   * Drive a fireRaw call to completion under fake timers. Each retry inserts
   * a setTimeout we have to advance through; runAllTimersAsync walks the
   * cascade until everything resolves.
   */
  async function runWithTimers<T>(p: Promise<T>): Promise<T> {
    let done = false;
    const wrapped = p.finally(() => {
      done = true;
    });
    while (!done) {
      // Tick microtasks first so any synchronous fetch resolution settles
      // before we advance the next timer.
      await Promise.resolve();
      await vi.runAllTimersAsync();
    }
    return wrapped;
  }

  it("returns true after a single successful POST (no retry)", async () => {
    mock.enqueue({ status: 200, body: "ok" });
    const ok = await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready"),
    );
    expect(ok).toBe(true);
    expect(mock.calls.length).toBe(1);
    expect(logRowCount()).toBe(1);
  });

  it("retries on 5xx and succeeds on the third attempt (3 calls, 2 backoffs)", async () => {
    mock.enqueue({ status: 502 });
    mock.enqueue({ status: 503 });
    mock.enqueue({ status: 200, body: "ok" });
    const ok = await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready"),
    );
    expect(ok).toBe(true);
    expect(mock.calls.length).toBe(3);
    expect(logRowCount()).toBe(3);
  });

  it("returns false after exhausting all retries on persistent failure", async () => {
    mock.enqueue({ status: 500 });
    mock.enqueue({ status: 500 });
    mock.enqueue({ status: 500 });
    const ok = await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready"),
    );
    expect(ok).toBe(false);
    expect(mock.calls.length).toBe(3);
    expect(logRowCount()).toBe(3);
  });

  it("makes exactly one attempt with maxAttempts: 1 (automatic re-delivery)", async () => {
    mock.enqueue({ status: 500 });
    mock.enqueue({ status: 200, body: "ok" });
    const ok = await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready", undefined, { maxAttempts: 1 }),
    );
    expect(ok).toBe(false);
    expect(mock.calls.length).toBe(1);
    expect(logRowCount()).toBe(1);
  });

  it("retries on network throw and succeeds on the second attempt", async () => {
    mock.enqueue({ throws: new Error("ECONNREFUSED") });
    mock.enqueue({ status: 200, body: "ok" });
    const ok = await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready"),
    );
    expect(ok).toBe(true);
    expect(mock.calls.length).toBe(2);
    // Network throw logs a row with null status.
    const errorRow = db
      .prepare<[], { status_code: number | null; error: string | null }>(
        "SELECT status_code, error FROM webhook_log ORDER BY id ASC LIMIT 1",
      )
      .get();
    expect(errorRow?.status_code).toBeNull();
    expect(errorRow?.error).toContain("ECONNREFUSED");
  });

  it("includes the X-Applaud-Signature header when a secret is provided", async () => {
    mock.enqueue({ status: 200 });
    await fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready", "shh");
    const call = mock.calls[0];
    expect(call).toBeDefined();
    const headers = (call!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-applaud-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("includes an X-Applaud-Timestamp header alongside the signature (replay protection)", async () => {
    mock.enqueue({ status: 200 });
    const before = Math.floor(Date.now() / 1000);
    await fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready", "shh");
    const headers = (mock.calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-applaud-timestamp"]).toMatch(/^\d+$/);
    expect(Number(headers["x-applaud-timestamp"])).toBeGreaterThanOrEqual(before);
  });

  it("omits the signature and timestamp headers entirely when no secret is provided", async () => {
    mock.enqueue({ status: 200 });
    await fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready");
    const headers = (mock.calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers).not.toHaveProperty("x-applaud-signature");
    expect(headers).not.toHaveProperty("x-applaud-timestamp");
    // Confirms the absence is by-omission, not empty-string.
    expect(headers["x-applaud-event"]).toBe("audio_ready");
  });

  it("re-uses the same signature and timestamp across retries (no re-sign per attempt)", async () => {
    mock.enqueue({ status: 502 });
    mock.enqueue({ status: 502 });
    mock.enqueue({ status: 200 });
    await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready", "shh"),
    );
    const sigs = mock.calls.map(
      (c) => (c.init!.headers as Record<string, string>)["x-applaud-signature"],
    );
    const timestamps = mock.calls.map(
      (c) => (c.init!.headers as Record<string, string>)["x-applaud-timestamp"],
    );
    expect(new Set(sigs).size).toBe(1);
    expect(new Set(timestamps).size).toBe(1);
  });

  it("never connects to a private/loopback target, and doesn't burn the retry schedule", async () => {
    mock.enqueue({ status: 200 });
    const ok = await runWithTimers(
      fireRaw("http://169.254.169.254/latest/meta-data/", samplePayload, "rec-1", "audio_ready"),
    );
    expect(ok).toBe(false);
    expect(mock.calls.length).toBe(0);
    const row = db
      .prepare<[], { error: string | null }>("SELECT error FROM webhook_log ORDER BY id ASC LIMIT 1")
      .get();
    expect(row?.error).toMatch(/private\/loopback/);
  });

  it("does not follow a redirect (a 302 counts as a failed attempt)", async () => {
    // Following it would let a public URL bounce the delivery to an internal one.
    mock.enqueue({ status: 302, headers: { location: "http://127.0.0.1:8080/" } });
    mock.enqueue({ status: 302, headers: { location: "http://127.0.0.1:8080/" } });
    mock.enqueue({ status: 302, headers: { location: "http://127.0.0.1:8080/" } });
    const ok = await runWithTimers(
      fireRaw("https://hook.example/x", samplePayload, "rec-1", "audio_ready"),
    );
    expect(ok).toBe(false);
    expect(mock.calls[0]?.init?.redirect).toBe("manual");
    const row = db
      .prepare<[], { error: string | null }>("SELECT error FROM webhook_log ORDER BY id ASC LIMIT 1")
      .get();
    expect(row?.error).toMatch(/redirect not followed/);
  });
});

describe("webhook payload http_urls", () => {
  let db: Database.Database;
  let mock: FetchMock;
  const row = {
    id: "rec-1",
    filename: "Standup",
    startTime: 1_000_000,
    endTime: 1_060_000,
    durationMs: 60_000,
    filesizeBytes: 100,
    serialNumber: "S1",
    folder: "2026-04-11_Standup__rec10000",
    audioFilename: "audio.mp3",
  } as RecordingRow;
  const config = (over: Partial<AppConfig>): AppConfig =>
    ({
      ...DEFAULT_CONFIG,
      webhook: { url: "https://hook.example/x", enabled: true },
      ...over,
    }) as AppConfig;

  beforeEach(() => {
    db = setupTestDb();
    mock = installFetchMock();
    mock.enqueue({ status: 200 });
  });
  afterEach(() => {
    mock.restore();
    teardownTestDb(db);
    loadConfig.mockReset();
  });

  const sentUrls = async (): Promise<WebhookPayload["http_urls"]> => {
    expect(await fireWebhookForRecording("audio_ready", row, { maxAttempts: 1 })).toBe(true);
    return (JSON.parse(String(mock.calls[0]!.init!.body)) as WebhookPayload).http_urls;
  };

  it("roots URLs at publicBaseUrl and signs them for just this folder when a LAN token is set", async () => {
    loadConfig.mockReturnValue(
      config({ publicBaseUrl: "https://applaud.example.com", lanToken: "a-long-enough-lan-token" }),
    );
    const urls = await sentUrls();
    const audio = new URL(urls.audio);
    expect(`${audio.origin}${audio.pathname}`).toBe(
      "https://applaud.example.com/media/2026-04-11_Standup__rec10000/audio.mp3",
    );
    const ticket = audio.searchParams.get("ticket")!;
    expect(verifyTicket(ticket, "/media/2026-04-11_Standup__rec10000/transcript.json")).toBe(true);
    expect(verifyTicket(ticket, "/media/some-other-recording/audio.mp3")).toBe(false);
    // The LAN token itself never appears in the payload.
    expect(JSON.stringify(urls)).not.toContain("a-long-enough-lan-token");
  });

  it("falls back to the bind address with no ticket when nothing is configured", async () => {
    loadConfig.mockReturnValue(config({}));
    const urls = await sentUrls();
    expect(urls.audio).toBe("http://127.0.0.1:44471/media/2026-04-11_Standup__rec10000/audio.mp3");
  });
});
