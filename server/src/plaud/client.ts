// Client for Plaud's official developer API (`platform.plaud.ai/developer/api`),
// authenticated with the OAuth access token from `session.ts`.
//
// The surface is small: the current user, a paged file list with server-side
// date filtering, and a per-file record. The record carries a pre-signed audio
// URL plus `source_list` (transcript, polished transcript, outline, highlights)
// and `note_list` (summary and other note tabs). Each block's body is inline
// (`data_content`) and/or behind a pre-signed `data_link`, sometimes gzipped.
// Pre-signed URLs measured on 2026-10-26 expire after one hour, so callers
// download straight after fetching the record.

import { createWriteStream, renameSync, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { logger } from "../logger.js";
import {
  AUDIO_DOWNLOAD_TIMEOUT_MS,
  HTTP_FETCH_TIMEOUT_MS,
  PLAUD_API_BASE,
  PLAUD_CONTENT_HOST_SUFFIXES,
  PLAUD_FETCH_MAX_ATTEMPTS,
} from "../constants.js";
import { getAccessToken, PlaudAuthError } from "./session.js";

export { PlaudAuthError };

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

export interface PlaudUser {
  id: string | null;
  nickname: string | null;
  email: string | null;
}

/** One row of `GET /open/third-party/files/`. Timestamps are UTC without a zone suffix. */
export interface PlaudFileSummary {
  id: string;
  name: string;
  created_at: string | null;
  start_at: string | null;
  /** Milliseconds. */
  duration: number | null;
  serial_number: string | null;
}

export interface PlaudContentBlock {
  data_id?: string;
  data_type?: string;
  data_title?: string;
  data_tab_name?: string;
  data_content?: string;
  data_link?: string;
  [k: string]: unknown;
}

export interface PlaudFileDetail extends PlaudFileSummary {
  presigned_url: string | null;
  source_list?: PlaudContentBlock[];
  note_list?: PlaudContentBlock[];
  [k: string]: unknown;
}

/**
 * Parse Plaud's API timestamps (`2026-10-26T10:30:29.542000`, no zone) as UTC,
 * the same rule Plaud's own CLI applies. Returns epoch ms or null.
 */
export function parseApiTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hasTime = /\d{2}:\d{2}/.test(trimmed);
  const hasZone = /(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/.test(trimmed);
  const ms = new Date(hasTime && !hasZone ? `${trimmed}Z` : trimmed).getTime();
  return Number.isNaN(ms) ? null : ms;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * GET a JSON resource from the developer API. Renews the access token once on
 * a 401 (Plaud may revoke a token before its stated expiry); a second 401 is a
 * `PlaudAuthError`. 5xx and network failures are retried with backoff.
 */
async function plaudGet<T>(path: string): Promise<T> {
  const url = `${PLAUD_API_BASE.replace(/\/$/, "")}${path}`;
  let forced = false;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= PLAUD_FETCH_MAX_ATTEMPTS; attempt++) {
    const token = await getAccessToken(forced);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = err;
      if (attempt < PLAUD_FETCH_MAX_ATTEMPTS) await sleep(attempt * 1000);
      continue;
    }
    if (res.status === 401) {
      if (forced) throw new PlaudAuthError("Plaud rejected the renewed access token; sign in again");
      forced = true;
      continue;
    }
    const text = await res.text().catch(() => "");
    if (res.status >= 500 && attempt < PLAUD_FETCH_MAX_ATTEMPTS) {
      logger.warn({ path, status: res.status, attempt }, "Plaud 5xx; retrying");
      await sleep(attempt * 1000);
      continue;
    }
    if (!res.ok) {
      throw new PlaudApiError(`Plaud GET ${path} → HTTP ${res.status}`, res.status, text.slice(0, 500));
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new PlaudApiError(`Plaud GET ${path} returned non-JSON: ${String(err)}`, res.status, text.slice(0, 500));
    }
  }
  throw new PlaudApiError(`Plaud GET ${path} failed after ${PLAUD_FETCH_MAX_ATTEMPTS} attempts: ${String(lastErr)}`, 0, "");
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : v != null && typeof v === "number" ? String(v) : null;
}

export async function getCurrentUser(): Promise<PlaudUser> {
  const body = await plaudGet<Record<string, unknown>>("/open/third-party/users/current");
  // Accept a `{ data: {...} }` wrapper as well as the bare object.
  const u = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
  return { id: str(u.id), nickname: str(u.nickname), email: str(u.email) };
}

export interface ListFilesOptions {
  /** 1-based. */
  page: number;
  /** Plaud rejects anything under 10. */
  pageSize: number;
  /** Inclusive epoch-ms bounds on the recording start time. */
  startMs?: number;
  endMs?: number;
}

export async function listFiles(opts: ListFilesOptions): Promise<PlaudFileSummary[]> {
  const q = new URLSearchParams({ page: String(opts.page), page_size: String(Math.max(10, opts.pageSize)) });
  if (opts.startMs !== undefined) q.set("start_date", String(opts.startMs));
  if (opts.endMs !== undefined) q.set("end_date", String(opts.endMs));
  const body = await plaudGet<{ data?: unknown }>(`/open/third-party/files/?${q.toString()}`);
  if (!Array.isArray(body.data)) {
    throw new PlaudApiError("Plaud file list response has no data array", 200, JSON.stringify(body).slice(0, 500));
  }
  return body.data.filter(
    (f): f is PlaudFileSummary => !!f && typeof f === "object" && typeof (f as PlaudFileSummary).id === "string",
  );
}

export async function getFile(id: string): Promise<PlaudFileDetail> {
  return plaudGet<PlaudFileDetail>(`/open/third-party/files/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------
// Pre-signed content links
// ---------------------------------------------------------------------

function hostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return PLAUD_CONTENT_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Validate a content link before fetching it: https, no credentials, known storage host. */
export function assertContentUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Plaud content link is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("Plaud content link is not https");
  if (url.username || url.password) throw new Error("Plaud content link carries credentials");
  if (!hostAllowed(url.hostname)) throw new Error(`Plaud content link host not allowed: ${url.hostname}`);
  return url;
}

const MAX_CONTENT_BYTES = 50 * 1024 * 1024;

/** Fetch a text block behind a pre-signed link, gunzipping when the body is gzip. */
export async function fetchContentText(link: string): Promise<string> {
  const url = assertContentUrl(link);
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Plaud content fetch → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_CONTENT_BYTES) throw new Error("Plaud content exceeds size limit");
  const gzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return (gzip ? gunzipSync(buf) : buf).toString("utf8");
}

/** A block's body: inline content when present, otherwise the linked content. */
export async function loadBlockContent(block: PlaudContentBlock): Promise<string> {
  if (typeof block.data_content === "string" && block.data_content.length > 0) return block.data_content;
  if (typeof block.data_link === "string" && block.data_link.length > 0) return fetchContentText(block.data_link);
  return "";
}

/**
 * Stream a pre-signed file (audio) to disk through a temp file, verifying the
 * byte count against Content-Length so a short close never publishes a
 * truncated file. Returns the bytes written.
 */
export async function downloadToFile(link: string, destPath: string): Promise<number> {
  const url = assertContentUrl(link);
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(AUDIO_DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Plaud download → HTTP ${res.status}`);
  if (!res.body) throw new Error("Plaud download returned an empty body");
  const sizeHeader = res.headers.get("content-length");
  const contentLength = sizeHeader ? Number(sizeHeader) : null;
  const tmpPath = `${destPath}.tmp-${process.pid}`;
  try {
    const writer = createWriteStream(tmpPath);
    await pipeline(Readable.fromWeb(res.body as never), writer);
    const written = writer.bytesWritten;
    if (contentLength != null && contentLength > 0 && written !== contentLength) {
      throw new Error(`Plaud download truncated: wrote ${written} of ${contentLength} bytes`);
    }
    renameSync(tmpPath, destPath);
    return written;
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/** File extension of the audio behind a pre-signed URL (`.ogg`, `.mp3`, ...), or null. */
export function audioExtensionFromUrl(link: string): string | null {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(link).pathname);
    return m ? m[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}
