import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { loadConfig } from "../config.js";
import { RATE_LIMIT_AUTH_FAILURES, RATE_LIMIT_WINDOW_MS } from "../constants.js";
import { clientKey, createRateLimiter } from "../security/rate-limit.js";
import { verifyTicket } from "./ticket.js";

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
 * Accepts `Authorization: Bearer <token>` everywhere. Requests that can't send
 * a header (`<audio>`/`<img>`/download links, `EventSource`) instead carry a
 * short-lived, path-scoped `?ticket=` (see `auth/ticket.ts`), accepted only
 * on read-only GETs where `ticketPath` says so. `?token=<lanToken>` on /media
 * is still honored for existing automations but is deprecated — the raw token
 * in a query string leaks into proxy logs, history, and `Referer`.
 */
export function createLanTokenGuard(opts: {
  allowQueryToken: boolean;
  /** The decoded path a ticket must grant for this request, or null when tickets aren't accepted here. */
  ticketPath?: (req: Request) => string | null;
}): RequestHandler {
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
    const ticket = typeof req.query.ticket === "string" ? req.query.ticket : undefined;
    if (ticket && (req.method === "GET" || req.method === "HEAD") && opts.ticketPath) {
      const scoped = opts.ticketPath(req);
      if (scoped !== null && verifyTicket(ticket, scoped)) {
        next();
        return;
      }
    }
    if (!authFailures.consume(clientKey(req))) {
      res.setHeader("Retry-After", String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
      res.status(429).json({ error: "too many failed authentication attempts" });
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  };
}

/** `/api` routes an `EventSource` connects to — the only API reads that take a ticket. */
const SSE_PATH = /^\/(sync\/events|auth\/watch\/[^/]+\/events)$/;

/**
 * Guard for `/api` (mount there): bearer header, plus a ticket on the two
 * server-sent-event streams.
 */
export const requireLanToken = createLanTokenGuard({
  allowQueryToken: false,
  ticketPath: (req) => (SSE_PATH.test(req.path) ? `/api${req.path}` : null),
});

/**
 * Guard for `/media` (mount there): bearer header, a ticket, or the deprecated
 * `?token=`. The ticket's scope is checked against the path the media route
 * will actually resolve — Express decodes the route param once and
 * `resolveSafe` decodes it again — so a double-encoded `..` (`%252e%252e`)
 * can't carry a folder-scoped ticket into another folder.
 */
export const requireLanTokenMedia = createLanTokenGuard({
  allowQueryToken: true,
  ticketPath: (req) => {
    try {
      return `/media${decodeURIComponent(decodeURIComponent(req.path))}`;
    } catch {
      return null;
    }
  },
});
