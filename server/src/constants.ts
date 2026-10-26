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

/**
 * Plaud's hosted OAuth authorisation server (dynamic client registration +
 * PKCE). Overridable for testing against a staging deployment.
 */
export const PLAUD_OAUTH_ISSUER = process.env.APPLAUD_PLAUD_OAUTH_ISSUER ?? "https://mcp.plaud.ai";

/** Plaud's official developer API, which accepts the OAuth access token. */
export const PLAUD_API_BASE =
  process.env.APPLAUD_PLAUD_API_BASE ?? "https://platform.plaud.ai/developer/api";

/** Renew the OAuth access token this long before it expires. */
export const PLAUD_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Hosts Plaud's pre-signed content links (audio, transcript blocks, notes)
 * may point at. Applaud never sends a credential to these, but only fetches
 * from hosts on this list so a tampered response can't aim the downloader at
 * the LAN. Suffix match on whole labels. Extend with
 * `APPLAUD_PLAUD_CONTENT_HOSTS` if Plaud moves its storage.
 */
export const PLAUD_CONTENT_HOST_SUFFIXES: readonly string[] = [
  "amazonaws.com",
  "plaud.ai",
  ...envList("APPLAUD_PLAUD_CONTENT_HOSTS"),
];

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

/** Backoff schedule between webhook delivery retries. */
export const WEBHOOK_RETRY_BACKOFF_MS: readonly number[] = process.env.APPLAUD_WEBHOOK_BACKOFF_MS
  ? process.env.APPLAUD_WEBHOOK_BACKOFF_MS.split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  : [5_000, 30_000, 120_000];

/**
 * Automatic webhook re-delivery (poller Phase 2b). Each failed delivery pushes
 * that recording/event's next attempt out by BASE × 3^(attempts-1), capped at
 * MAX_DELAY; after MAX_ATTEMPTS it is left for a manual Redeliver. At most
 * MAX_PER_POLL deliveries are re-driven per cycle, so a dead receiver can't
 * stall syncing.
 */
export const WEBHOOK_REDRIVE_BASE_DELAY_MS = envMs("APPLAUD_WEBHOOK_REDRIVE_BASE_MINUTES", 5 * 60_000, 60_000);
export const WEBHOOK_REDRIVE_MAX_DELAY_MS = envMs("APPLAUD_WEBHOOK_REDRIVE_MAX_HOURS", DAY_MS, HOUR_MS);
export const WEBHOOK_REDRIVE_MAX_ATTEMPTS = envInt("APPLAUD_WEBHOOK_REDRIVE_MAX_ATTEMPTS", 8);
export const WEBHOOK_REDRIVE_MAX_PER_POLL = envInt("APPLAUD_WEBHOOK_REDRIVE_MAX_PER_POLL", 10);

/**
 * Lifetime of the signed ticket the web UI uses for media links and live
 * updates (see `auth/ticket.ts`). The UI renews it after half this, so an
 * open page always has at least half of it left.
 */
export const BROWSER_TICKET_TTL_MS = envMs("APPLAUD_BROWSER_TICKET_TTL_HOURS", DAY_MS, HOUR_MS);

/**
 * Lifetime of the signed media URLs in webhook payloads (`http_urls`) when a
 * LAN token is set — long enough for a receiver to fetch files after retries
 * and queueing, short enough that a stored payload doesn't grant access forever.
 */
export const WEBHOOK_MEDIA_URL_TTL_MS = envMs("APPLAUD_WEBHOOK_URL_TTL_HOURS", 7 * DAY_MS, HOUR_MS);

/** Soft-deleted recordings are purged from disk and DB after this delay. */
export const SOFT_DELETE_RETENTION_MS = envMs("APPLAUD_TRASH_RETENTION_DAYS", 7 * DAY_MS, DAY_MS);

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
