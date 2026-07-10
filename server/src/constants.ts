/**
 * Central home for values that were previously magic numbers scattered
 * across the sync/webhook code. Each is overridable via an environment
 * variable for self-hosters who need different tuning (larger libraries,
 * flakier networks, stricter retention) without a UI. Defaults match the
 * values this project has always shipped with.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envMs(name: string, fallbackMs: number, unitMs: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n * unitMs : fallbackMs;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Spoofed as a desktop browser so Cloudflare's WAF doesn't 403 the "applaud/x.y.z" UA (see #26). */
export const PLAUD_USER_AGENT =
  process.env.APPLAUD_PLAUD_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** Retries for a single Plaud API call (5xx / network errors). */
export const PLAUD_FETCH_MAX_ATTEMPTS = envInt("APPLAUD_PLAUD_MAX_ATTEMPTS", 3);

/** Page size / hard page cap for the discovery walk (poller Phase 1). */
export const POLLER_LIST_PAGE_SIZE = envInt("APPLAUD_POLLER_PAGE_SIZE", 50);
export const POLLER_LIST_MAX_PAGES = envInt("APPLAUD_POLLER_MAX_PAGES", 200);

/** Backoff schedule between webhook delivery retries. */
export const WEBHOOK_RETRY_BACKOFF_MS: readonly number[] = process.env.APPLAUD_WEBHOOK_BACKOFF_MS
  ? process.env.APPLAUD_WEBHOOK_BACKOFF_MS.split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  : [5_000, 30_000, 120_000];

/** Soft-deleted recordings are purged from disk and DB after this delay. */
export const SOFT_DELETE_RETENTION_MS = envMs("APPLAUD_TRASH_RETENTION_DAYS", 7 * DAY_MS, DAY_MS);

/** Throttled Plaud-trash rows to check for transcript/summary (poller Phase 3). */
export const PLAUD_TRASH_ASSET_PROBE_INTERVAL_MS = envMs(
  "APPLAUD_TRASH_PROBE_INTERVAL_HOURS",
  6 * HOUR_MS,
  HOUR_MS,
);
/** Max trash rows probed per scheduled poll. */
export const PLAUD_TRASH_ASSET_PROBE_SCHEDULED_LIMIT = envInt("APPLAUD_TRASH_PROBE_SCHEDULED_LIMIT", 25);
/** Sync Now: higher than scheduled poll, but bounded so one manual sync can't fan out without limit. */
export const PLAUD_TRASH_ASSET_PROBE_MANUAL_SYNC_LIMIT = envInt("APPLAUD_TRASH_PROBE_MANUAL_LIMIT", 100);

/** Hard cap on `limit` for recording list/search queries, regardless of what the client asks for. */
export const RECORDINGS_LIST_MAX_LIMIT = envInt("APPLAUD_RECORDINGS_MAX_LIMIT", 500);
