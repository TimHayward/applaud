import { logger } from "../logger.js";
import { loadConfig } from "../config.js";
import { PLAUD_USER_AGENT, PLAUD_FETCH_MAX_ATTEMPTS } from "../constants.js";

const REGION_API_BASES: Record<string, string> = {
  "aws:us-west-2": "https://api.plaud.ai",
  "aws:eu-central-1": "https://api-euc1.plaud.ai",
  "aws:ap-southeast-1": "https://api-apse1.plaud.ai",
};
const DEFAULT_API_BASE = "https://api.plaud.ai";

export const PLAUD_API_BASES = Object.values(REGION_API_BASES);

export function getPlaudApiBaseForRegion(region: string | null): string {
  if (region) {
    return REGION_API_BASES[region] ?? DEFAULT_API_BASE;
  }
  return DEFAULT_API_BASE;
}

export function getPlaudRegionForBase(base: string): string | null {
  const match = Object.entries(REGION_API_BASES).find(([, value]) => value === base);
  return match ? match[0] : null;
}

/** Reverse lookup: API base hostname → region key. */
const API_BASE_TO_REGION = new Map(
  Object.entries(REGION_API_BASES).map(([region, url]) => [new URL(url).hostname, region]),
);

/**
 * Given an API base URL returned by Plaud's region-mismatch response,
 * resolve the corresponding region key (e.g. "aws:eu-central-1").
 * Returns `null` if the hostname is not in the known map.
 */
export function resolveRegionFromDomain(apiBaseUrl: string): string | null {
  try {
    const hostname = new URL(apiBaseUrl).hostname;
    return API_BASE_TO_REGION.get(hostname) ?? null;
  } catch {
    return null;
  }
}

export function getPlaudApiBase(): string {
  const cfg = loadConfig();
  if (cfg.plaudRegion) {
    return REGION_API_BASES[cfg.plaudRegion] ?? DEFAULT_API_BASE;
  }
  return DEFAULT_API_BASE;
}

/**
 * Resolve an explicit region key to its API base, independent of config.
 * Used by the first-party session helpers, which thread a region through
 * their own `-302` follow rather than reading the stored config.
 */
export function apiBaseForRegion(region: string | null): string {
  if (region && REGION_API_BASES[region]) return REGION_API_BASES[region];
  return DEFAULT_API_BASE;
}

/** A parsed Plaud `-302` region-mismatch redirect. */
export type RegionRedirect =
  | { ok: true; region: string; apiBase: string }
  | { ok: false; apiBase: string | null };

/**
 * Detect Plaud's `{ status: -302, data: { domains: { api } } }` region
 * redirect and resolve its target through the known-region allowlist.
 * Returns `null` when `body` is not a `-302` envelope so callers fall
 * through to normal handling.
 */
export function parseRegionRedirect(body: unknown): RegionRedirect | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { status?: unknown; data?: unknown };
  if (b.status !== -302) return null;
  const data = b.data as { domains?: { api?: unknown } } | undefined;
  const apiBase = typeof data?.domains?.api === "string" ? data.domains.api : null;
  if (!apiBase) return { ok: false, apiBase: null };
  const region = resolveRegionFromDomain(apiBase);
  if (!region) return { ok: false, apiBase };
  return { ok: true, region, apiBase };
}

export class PlaudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaudAuthError";
  }
}

export class PlaudApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "PlaudApiError";
  }
}

type FetchInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
  authOverride?: string;
  apiBase?: string;
};

function getToken(): string {
  const cfg = loadConfig();
  if (!cfg.token) throw new PlaudAuthError("no token configured");
  return cfg.token;
}

export async function plaudFetch(pathOrUrl: string, init: FetchInit = {}): Promise<Response> {
  const base = init.apiBase ?? getPlaudApiBase();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${base}${pathOrUrl}`;
  const token = init.authOverride ?? getToken();
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": PLAUD_USER_AGENT,
    authorization: `Bearer ${token}`,
    ...init.headers,
  };
  // Default JSON content type for methods that likely send a body.
  if (init.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  const maxAttempts = PLAUD_FETCH_MAX_ATTEMPTS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers });
      if (res.status === 401) {
        throw new PlaudAuthError("Plaud returned 401 — token expired or revoked");
      }
      if (
        res.status === 403 &&
        (res.headers.get("cf-ray") || res.headers.get("server") === "cloudflare")
      ) {
        throw new PlaudApiError(
          "Request blocked by Cloudflare WAF — check your network or try again later",
          403,
          "",
        );
      }
      if (res.status >= 500 && attempt < maxAttempts) {
        const waitMs = attempt * 1000;
        logger.warn({ url, status: res.status, attempt }, "Plaud 5xx — retrying");
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      return res;
    } catch (err) {
      if (err instanceof PlaudAuthError || err instanceof PlaudApiError) throw err;
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }
    }
  }
  throw new PlaudApiError(
    `network error after ${maxAttempts} attempts: ${String(lastErr)}`,
    0,
    "",
  );
}

export async function plaudJson<T>(path: string, init: FetchInit = {}): Promise<T> {
  const res = await plaudFetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    throw new PlaudApiError(
      `Plaud ${init.method ?? "GET"} ${path} → ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new PlaudApiError(
      `Plaud ${path} returned non-JSON: ${String(err)}`,
      res.status,
      text.slice(0, 500),
    );
  }
}
