import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppConfig } from "@applaud/shared";
import type { Request, Response } from "express";

const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
vi.mock("../config.js", () => ({ loadConfig }));

import { requireLanToken } from "./lan-token.js";

const baseConfig: AppConfig = {
  version: 1,
  setupComplete: true,
  token: null,
  tokenExp: null,
  tokenEmail: null,
  plaudRegion: null,
  authMode: null,
  ut: null,
  utExp: null,
  urt: null,
  urtExp: null,
  plaudWorkspaceId: null,
  recordingsDir: "/tmp/r",
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  lanToken: null,
  importPlaudDeleted: false,
};

function makeReq(opts: { authorization?: string; token?: string } = {}): Request {
  return {
    headers: opts.authorization ? { authorization: opts.authorization } : {},
    query: opts.token ? { token: opts.token } : {},
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
  return res as Response & { statusCode?: number; body?: unknown };
}

describe("requireLanToken", () => {
  beforeEach(() => {
    loadConfig.mockReset();
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

  it("accepts a correct ?token= query param (for <audio>/<a> elements)", () => {
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: "secret123" });
    const next = vi.fn();
    requireLanToken(makeReq({ token: "secret123" }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects an incorrect ?token= query param", () => {
    loadConfig.mockReturnValue({ ...baseConfig, lanToken: "secret123" });
    const next = vi.fn();
    const res = makeRes();
    requireLanToken(makeReq({ token: "wrong" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
