import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Minimal in-memory fixed-window rate limiter — no new dependency, and this
 * process is the only thing serving these routes, so a shared store would buy
 * nothing.
 *
 * Applied to the routes where an unthrottled caller is the actual problem:
 * brute-forcing a weak `lanToken`, and using `test-webhook` /
 * `validate-recordings-dir` as a scanner. Media and the general API get a much
 * looser cap so normal use (range requests, SSE, polling) never trips it.
 */
export interface RateLimitOptions {
  /** Window length in ms. */
  windowMs: number;
  /** Requests allowed per key per window. */
  max: number;
  /** Response message on 429. */
  message?: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Cleans up idle buckets so a long-running server doesn't accumulate IPs. */
const SWEEP_EVERY = 1000;

export function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export interface RateLimiter extends RequestHandler {
  /** Count a request against the limit without responding. Returns false when over. */
  consume(key: string): boolean;
  reset(): void;
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let sinceSweep = 0;

  const consume = (key: string): boolean => {
    const now = Date.now();
    if (++sinceSweep >= SWEEP_EVERY) {
      sinceSweep = 0;
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    }
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= opts.max;
  };

  const middleware = ((req: Request, res: Response, next: NextFunction): void => {
    const key = clientKey(req);
    if (consume(key)) {
      next();
      return;
    }
    const bucket = buckets.get(key);
    const retryAfter = bucket ? Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000)) : 60;
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: opts.message ?? "too many requests" });
  }) as RateLimiter;

  middleware.consume = consume;
  middleware.reset = (): void => {
    buckets.clear();
    sinceSweep = 0;
  };
  return middleware;
}
