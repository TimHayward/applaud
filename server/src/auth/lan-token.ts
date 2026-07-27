import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { loadConfig } from "../config.js";
import { RATE_LIMIT_AUTH_FAILURES, RATE_LIMIT_WINDOW_MS } from "../constants.js";
import { clientKey, createRateLimiter } from "../security/rate-limit.js";

/**
 * Constant-time string comparison. Both sides are hashed first so the compare
 * is over fixed-length buffers — `timingSafeEqual` throws on a length mismatch,
 * and the length itself is a (small) leak.
 */
export function secretEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Throttles wrong-token attempts per client so a weak `lanToken` can't be
 * brute-forced over a LAN. Only failures are counted — a client with the right
 * token is never limited here.
 */
const authFailures = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_AUTH_FAILURES,
  message: "too many failed authentication attempts",
});

export function resetAuthFailures(): void {
  authFailures.reset();
}

/**
 * Gates /api and /media behind cfg.lanToken when one is configured. No-op when
 * no token is set (the default for a loopback install; container mode always
 * has one — see `index.ts`).
 *
 * Accepts `Authorization: Bearer <token>` everywhere. The `?token=` query form
 * is accepted only where it's actually needed — `/media`, for `<audio>`/`<a>`/
 * `<img>` elements that can't set headers — because query strings leak into
 * proxy logs, browser history, and `Referer`. `/api` is header-only.
 */
export function createLanTokenGuard(opts: { allowQueryToken: boolean }): RequestHandler {
  return function requireToken(req: Request, res: Response, next: NextFunction): void {
    const token = loadConfig().lanToken;
    if (!token) {
      next();
      return;
    }
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const queryToken =
      opts.allowQueryToken && typeof req.query.token === "string" ? req.query.token : undefined;
    const presented = bearer ?? queryToken;
    if (presented !== undefined && secretEquals(presented, token)) {
      next();
      return;
    }
    if (!authFailures.consume(clientKey(req))) {
      res.setHeader("Retry-After", String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
      res.status(429).json({ error: "too many failed authentication attempts" });
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  };
}

/** Header-only guard for `/api`. */
export const requireLanToken = createLanTokenGuard({ allowQueryToken: false });

/** Guard for `/media`, which additionally accepts `?token=`. */
export const requireLanTokenMedia = createLanTokenGuard({ allowQueryToken: true });
