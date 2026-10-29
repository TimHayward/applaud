import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SPEAKER_CONFIG, type AppConfig } from "@applaud/shared";
import type { Request, Response } from "express";

const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
vi.mock("../config.js", () => ({ loadConfig }));

import {
  requireLanToken,
  requireLanTokenMedia,
  resetAuthFailures,
  secretEquals,
} from "./lan-token.js";
import { issueTicket } from "./ticket.js";

const baseConfig: AppConfig = {
  version: 1,
  setupComplete: true,
  token: null,
  tokenExp: null,
  tokenEmail: null,
  refreshToken: null,
  refreshTokenExp: null,
  plaudClientId: null,
  plaudRedirectUri: null,
  plaudConnectedAt: null,
  historyDays: 30,
  installedAt: null,
  libraryIndexedAt: null,
  plaudNickname: null,
  speakers: DEFAULT_SPEAKER_CONFIG,
  recordingsDir: "/tmp/r",
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  publicBaseUrl: null,
  lanToken: null,
};

function makeReq(
  opts: { authorization?: string; token?: string; ticket?: string; ip?: string; path?: string; method?: string } = {},
): Request {
  return {
    headers: opts.authorization ? { authorization: opts.authorization } : {},
    query: {
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.ticket ? { ticket: opts.ticket } : {}),
    },
    method: opts.method ?? "GET",
    path: opts.path ?? "/",
    ip: opts.ip ?? "10.0.0.1",
    socket: { remoteAddress: opts.ip ?? "10.0.0.1" },
  } as unknown as Request;
}

function makeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res as Response;
  });
  res.setHeader = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

describe("requireLanToken", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    resetAuthFailures();
  });

  it("is a no-op when no lanToken is configured", () => {
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: null });
    const next = vi.fn();
    requireLanToken(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects requests with no credentials when a lanToken is set", () => {
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: "secret123" });
    const next = vi.fn();
    const res = makeRes();
    requireLanToken(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects an incorrect bearer token", () => {
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: "secret123" });
    const next = vi.fn();
    const res = makeRes();
    requireLanToken(makeReq({ authorization: "Bearer wrong" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("accepts a correct Authorization bearer token", () => {
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: "secret123" });
    const next = vi.fn();
    requireLanToken(makeReq({ authorization: "Bearer secret123" }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("ignores a ?token= query param on /api — the query form is media-only", () => {
    // Query strings leak into proxy logs, history, and Referer, so /api takes
    // the token by header only.
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: "secret123" });
    const next = vi.fn();
    const res = makeRes();
    requireLanToken(makeReq({ token: "secret123" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("accepts a correct ?token= query param on /media (for <audio>/<a> elements)", () => {
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: "secret123" });
    const next = vi.fn();
    requireLanTokenMedia(makeReq({ token: "secret123" }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects an incorrect ?token= query param on /media", () => {
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: "secret123" });
    const next = vi.fn();
    const res = makeRes();
    requireLanTokenMedia(makeReq({ token: "wrong" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("locks a client out with 429 after repeated failures (brute-force guard)", () => {
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: "secret123" });
    const ip = "192.0.2.55";
    let last = makeRes();
    for (let i = 0; i < 25; i++) {
      last = makeRes();
      requireLanToken(makeReq({ authorization: "Bearer wrong", ip }), last, vi.fn());
    }
    expect(last.statusCode).toBe(429);
  });

  it("does not throttle a different client", () => {
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: "secret123" });
    for (let i = 0; i < 25; i++) {
      requireLanToken(makeReq({ authorization: "Bearer wrong", ip: "192.0.2.9" }), makeRes(), vi.fn());
    }
    const next = vi.fn();
    requireLanToken(makeReq({ authorization: "Bearer secret123", ip: "192.0.2.10" }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("signed tickets in the guards", () => {
  const TOKEN = "a-long-enough-lan-token";
  beforeEach(() => {
    loadConfig.mockReset();
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: TOKEN });
    resetAuthFailures();
  });
  const pass = (guard: typeof requireLanToken, req: Request): boolean => {
    const next = vi.fn();
    guard(req, makeRes(), next);
    return next.mock.calls.length === 1;
  };
  const browserTicket = (): string => issueTicket("/", 60_000)!.ticket;

  it("lets an EventSource reach the sync and login-watch streams with a ticket", () => {
    expect(pass(requireLanToken, makeReq({ path: "/sync/events", ticket: browserTicket() }))).toBe(true);
    expect(pass(requireLanToken, makeReq({ path: "/auth/watch/w1/events", ticket: browserTicket() }))).toBe(true);
  });

  it("does not accept a ticket on any other /api route, or on a non-GET", () => {
    expect(pass(requireLanToken, makeReq({ path: "/recordings", ticket: browserTicket() }))).toBe(false);
    expect(pass(requireLanToken, makeReq({ path: "/auth/ticket", ticket: browserTicket() }))).toBe(false);
    expect(pass(requireLanToken, makeReq({ path: "/sync/events", ticket: browserTicket(), method: "POST" }))).toBe(false);
  });

  it("serves media with a browser ticket", () => {
    expect(pass(requireLanTokenMedia, makeReq({ path: "/rec-A/audio.ogg", ticket: browserTicket() }))).toBe(true);
  });

  it("confines a folder-scoped ticket to its folder, even through double-encoded ..", () => {
    const t = issueTicket("/media/rec-A/", 60_000)!.ticket;
    expect(pass(requireLanTokenMedia, makeReq({ path: "/rec-A/audio.ogg", ticket: t }))).toBe(true);
    expect(pass(requireLanTokenMedia, makeReq({ path: "/rec-B/audio.ogg", ticket: t }))).toBe(false);
    // Express decodes the route param once and resolveSafe decodes it again.
    expect(pass(requireLanTokenMedia, makeReq({ path: "/rec-A/%252e%252e/rec-B/audio.ogg", ticket: t }))).toBe(false);
    expect(pass(requireLanTokenMedia, makeReq({ path: "/rec-A/%2e%2e/rec-B/audio.ogg", ticket: t }))).toBe(false);
  });

  it("rejects an expired ticket", () => {
    const t = issueTicket("/", 60_000, Date.now() - 120_000)!.ticket;
    expect(pass(requireLanTokenMedia, makeReq({ path: "/rec-A/audio.ogg", ticket: t }))).toBe(false);
  });
});

describe("secretEquals", () => {
  it("matches identical strings", () => {
    expect(secretEquals("a-token", "a-token")).toBe(true);
  });

  it("rejects different strings of the same length", () => {
    expect(secretEquals("a-token", "b-token")).toBe(false);
  });

  it("rejects different lengths without throwing (hashed before compare)", () => {
    expect(secretEquals("short", "a-much-longer-token")).toBe(false);
  });

  it("rejects the empty string against a token", () => {
    expect(secretEquals("", "a-token")).toBe(false);
  });
});
