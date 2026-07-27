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

function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw?.toLowerCase() === "true";
}

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Spoofed as a desktop browser so Cloudflare's WAF doesn't 403 the "applaud/x.y.z" UA (see #26). */
export const PLAUD_USER_AGENT =
  process.env.APPLAUD_PLAUD_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** Retries for a single Plaud API call (5xx / network errors). */
export const PLAUD_FETCH_MAX_ATTEMPTS = envInt("APPLAUD_PLAUD_MAX_ATTEMPTS", 3);

/**
 * Per-request timeout for a normal (non-streaming) Plaud/webhook/asset fetch.
 * Guards against a half-open TCP stall wedging the poller forever.
 */
export const HTTP_FETCH_TIMEOUT_MS = envMs("APPLAUD_HTTP_TIMEOUT_SECONDS", 30_000, 1000);

/**
 * Timeout for a streaming audio download. Larger than a normal request since a
 * legitimate large file can take a while, but still bounded so a stalled S3
 * connection can't hang the poll indefinitely.
 */
export const AUDIO_DOWNLOAD_TIMEOUT_MS = envMs("APPLAUD_AUDIO_TIMEOUT_SECONDS", 5 * 60_000, 1000);

/**
 * Hard watchdog on a single poll cycle. If pollAndProcess hasn't settled by
 * this long, runOnce aborts it so `inFlight` can't stick true forever (which
 * would silently no-op every later tick).
 */
export const POLLER_RUN_WATCHDOG_MS = envMs("APPLAUD_POLL_WATCHDOG_MINUTES", 30 * 60_000, 60_000);

/** Page size / hard page cap for the discovery walk (poller Phase 1). */
export const POLLER_LIST_PAGE_SIZE = envInt("APPLAUD_POLLER_PAGE_SIZE", 50);
export const POLLER_LIST_MAX_PAGES = envInt("APPLAUD_POLLER_MAX_PAGES", 200);
/**
 * Rows to re-read from the end of the previous page on each subsequent page of
 * the discovery walk. A delete mid-walk shifts items up across the page
 * boundary; overlapping a few rows keeps a brand-new recording from being
 * skipped for a cycle. Upsert is idempotent, so the re-reads are free.
 */
export const POLLER_LIST_PAGE_OVERLAP = envInt("APPLAUD_POLLER_PAGE_OVERLAP", 5);

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

/**
 * Allow webhook deliveries and `test-webhook` to reach private/loopback/
 * link-local addresses. Off by default so an attacker who can reach the API
 * can't use it to probe the machine's own services or the LAN (SSRF); turn it
 * on when your webhook target really is local — an n8n / Home Assistant /
 * Node-RED instance on this machine or the same network.
 */
export const WEBHOOK_ALLOW_PRIVATE_TARGETS = envFlag("APPLAUD_WEBHOOK_ALLOW_PRIVATE");

/**
 * Extra `Host` header values accepted beyond IP literals, `localhost`, and LAN
 * name suffixes. Needed when Applaud sits behind a reverse proxy on a real
 * domain. A leading `*.` matches subdomains; `*` disables the check.
 */
export const EXTRA_ALLOWED_HOSTS = envList("APPLAUD_ALLOWED_HOSTS");

/**
 * Minimum length for a `lanToken`. Short tokens are brute-forceable over a LAN
 * even with the rate limiter in front of them; the Settings "Generate" button
 * produces 48 hex chars.
 */
export const LAN_TOKEN_MIN_LENGTH = envInt("APPLAUD_LAN_TOKEN_MIN_LENGTH", 16);

/** Rate-limit windows/caps, per client IP. */
export const RATE_LIMIT_WINDOW_MS = envMs("APPLAUD_RATE_LIMIT_WINDOW_SECONDS", 60_000, 1000);
/** General `/api` traffic: generous — polling + SSE + a browsing user. */
export const RATE_LIMIT_API_MAX = envInt("APPLAUD_RATE_LIMIT_API_MAX", 600);
/** `/media`: one audio scrub can fire many range requests. */
export const RATE_LIMIT_MEDIA_MAX = envInt("APPLAUD_RATE_LIMIT_MEDIA_MAX", 900);
/** Outbound-fetch and filesystem-probe routes (`test-webhook`, `validate-recordings-dir`). */
export const RATE_LIMIT_SENSITIVE_MAX = envInt("APPLAUD_RATE_LIMIT_SENSITIVE_MAX", 20);
/** Failed LAN-token attempts before the client is locked out for the window. */
export const RATE_LIMIT_AUTH_FAILURES = envInt("APPLAUD_RATE_LIMIT_AUTH_FAILURES", 20);
