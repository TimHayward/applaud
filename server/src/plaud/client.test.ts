import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AppConfig } from "@applaud/shared";

// Mock the config module BEFORE importing client.ts so that plaudJson sees
// our controlled loadConfig / updateConfig. vi.hoisted is required because
// vi.mock factories run before module imports.
const { loadConfig, updateConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
}));
vi.mock("../config.js", () => ({ loadConfig, updateConfig }));

// And silence the logger so the test output stays clean.
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { plaudJson, PlaudApiError, PlaudAuthError, getPlaudRegionForBase } from "./client.js";
import { installFetchMock, type FetchMock } from "../test/fixtures/fetch.js";

const baseConfig: AppConfig = {
  version: 1,
  setupComplete: true,
  token: "test-token",
  tokenExp: null,
  tokenEmail: null,
  plaudRegion: null,
  recordingsDir: "/tmp/r",
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  lanToken: null,
  importPlaudDeleted: false,
};

describe("getPlaudRegionForBase", () => {
  it("maps the EU central API host back to its region key", () => {
    expect(getPlaudRegionForBase("https://api-euc1.plaud.ai")).toBe("aws:eu-central-1");
  });

  it("maps the US default API host back to its region key", () => {
    expect(getPlaudRegionForBase("https://api.plaud.ai")).toBe("aws:us-west-2");
  });

  it("maps the AP southeast API host back to its region key", () => {
    expect(getPlaudRegionForBase("https://api-apse1.plaud.ai")).toBe("aws:ap-southeast-1");
  });

  it("returns null for an unknown base URL", () => {
    expect(getPlaudRegionForBase("https://api-rogue.plaud.ai")).toBeNull();
  });
});

describe("plaudJson", () => {
  let mock: FetchMock;

  beforeEach(() => {
    loadConfig.mockReset();
    updateConfig.mockReset();
    loadConfig.mockReturnValue(baseConfig);
    mock = installFetchMock();
  });

  afterEach(() => {
    mock.restore();
    vi.useRealTimers();
  });

  async function runWithTimers<T>(p: Promise<T>): Promise<T> {
    let done = false;
    const wrapped = p.finally(() => {
      done = true;
    });
    while (!done) {
      await Promise.resolve();
      await vi.runAllTimersAsync();
    }
    return wrapped;
  }

  it("parses normal JSON payloads", async () => {
    mock.enqueue({
      status: 200,
      body: JSON.stringify({ ok: true, items: [] }),
    });
    const out = await plaudJson<{ ok: boolean }>("/file/list");
    expect(out).toEqual({ ok: true, items: [] });

    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]!.url).toBe("https://api.plaud.ai/file/list");
    expect(updateConfig).not.toHaveBeenCalledWith({ plaudRegion: expect.anything() });
  });

  it("returns Plaud -302 JSON body as-is in current architecture", async () => {
    mock.enqueue({
      status: 200,
      body: JSON.stringify({
        status: -302,
        msg: "wrong region",
        data: { domains: { api: "https://api-rogue.plaud.ai" } },
      }),
    });

    const out = await plaudJson<{ status: number; msg: string }>("/file/list");
    expect(out.status).toBe(-302);
    expect(out.msg).toBe("wrong region");
    expect(mock.calls.length).toBe(1);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("authOverride uses override token and explicit apiBase", async () => {
    mock.enqueue({
      status: 200,
      body: JSON.stringify({ ok: true }),
    });

    const out = await plaudJson<{ ok: boolean }>("/auth/validate", {
      method: "POST",
      body: "{}",
      authOverride: "candidate-token",
      apiBase: "https://api-euc1.plaud.ai",
    });
    expect(out).toEqual({ ok: true });
    expect(mock.calls.length).toBe(1);
    const auth1 = (mock.calls[0]!.init!.headers as Record<string, string>)["authorization"];
    expect(mock.calls[0]!.url).toBe("https://api-euc1.plaud.ai/auth/validate");
    expect(auth1).toBe("Bearer candidate-token");
    expect(updateConfig).not.toHaveBeenCalledWith({ plaudRegion: expect.anything() });
  });

  it("HTTP 401 throws PlaudAuthError without retrying for region", async () => {
    mock.enqueue({ status: 401, body: '{"err":"unauthorized"}' });
    await expect(plaudJson("/file/list")).rejects.toBeInstanceOf(PlaudAuthError);
    expect(mock.calls.length).toBe(1);
  });

  it("retries on 5xx and succeeds on the third attempt", async () => {
    vi.useFakeTimers();
    mock.enqueue({ status: 502, body: "bad gateway" });
    mock.enqueue({ status: 503, body: "service unavailable" });
    mock.enqueue({ status: 200, body: JSON.stringify({ ok: true }) });

    const out = await runWithTimers(plaudJson<{ ok: boolean }>("/file/list"));
    expect(out).toEqual({ ok: true });
    expect(mock.calls.length).toBe(3);
  });

  it("throws PlaudApiError on non-JSON success body", async () => {
    mock.enqueue({ status: 200, body: "not-json" });
    await expect(plaudJson("/file/list")).rejects.toBeInstanceOf(PlaudApiError);
    expect(mock.calls.length).toBe(1);
  });
});
