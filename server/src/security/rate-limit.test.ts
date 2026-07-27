import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import { createRateLimiter } from "./rate-limit.js";

function makeReq(ip = "10.0.0.1"): Request {
  return { ip, socket: { remoteAddress: ip } } as unknown as Request;
}

interface FakeRes {
  statusCode?: number;
  headers: Record<string, string>;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
  setHeader: (name: string, value: string) => FakeRes;
}

function makeRes(): FakeRes & Response {
  const res: FakeRes = {
    headers: {},
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn(() => res),
    setHeader: vi.fn((name: string, value: string) => {
      res.headers[name] = String(value);
      return res;
    }),
  };
  return res as FakeRes & Response;
}

describe("createRateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes requests through under the cap", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
    const next = vi.fn();
    for (let i = 0; i < 3; i++) limiter(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it("429s once the cap is exceeded, with a Retry-After header", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    const next = vi.fn();
    limiter(makeReq(), makeRes(), next);
    limiter(makeReq(), makeRes(), next);
    const res = makeRes();
    limiter(makeReq(), res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("counts each client separately", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    const next = vi.fn();
    limiter(makeReq("10.0.0.1"), makeRes(), next);
    limiter(makeReq("10.0.0.2"), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("refills after the window elapses", () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    const next = vi.fn();
    limiter(makeReq(), makeRes(), next);
    limiter(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    limiter(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("falls back to the socket address when req.ip is absent", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    const next = vi.fn();
    const req = { socket: { remoteAddress: "10.9.9.9" } } as unknown as Request;
    limiter(req, makeRes(), next);
    const res = makeRes();
    limiter(req, res, next);
    expect(res.statusCode).toBe(429);
  });
});
