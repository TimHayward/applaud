import type { AppConfig } from "./config.js";
import type { RecordingRow, RecordingDetail } from "./recording.js";

export interface AuthDetectResponse {
  found: boolean;
  /**
   * False when this OS can't read the browser session off disk. Windows cookies
   * are DPAPI / App-Bound encrypted, so we skip auto-detection there entirely
   * and the client goes straight to the manual paste flow. Absent means
   * supported (legacy clients / Linux / macOS).
   */
  autoDetectSupported?: boolean;
  /** Which credential model was detected: legacy `tokenstr` vs first-party cookies. */
  authMode?: "legacy" | "first_party";
  /** Legacy only: the detected bearer JWT. */
  token?: string;
  /** First-party only: the detected `pld_ut` / `pld_urt` cookie pair. */
  ut?: string;
  urt?: string;
  profile?: string;
  browser?: string;
  email?: string;
  error?: string;
}

export interface AuthWatchStartResponse {
  watchId: string;
}

export type AuthWatchEvent =
  | { type: "waiting"; elapsedMs: number }
  | { type: "found"; authMode: "legacy" | "first_party"; profile: string; browser: string; email?: string }
  | { type: "timeout" }
  | { type: "error"; message: string };

export interface AuthManualRequest {
  /** Legacy: a pasted bearer JWT. */
  token?: string;
  /** First-party: pasted `pld_ut` / `pld_urt` cookie values. */
  ut?: string;
  urt?: string;
}

export interface AuthValidateResponse {
  ok: boolean;
  email?: string;
  exp?: number;
  error?: string;
}

/**
 * `GET /api/auth/ticket`: a short-lived signed credential for requests that
 * can't send the bearer header (media links, `EventSource`), passed as
 * `?ticket=`. Both fields are null when no LAN token is configured.
 */
export interface TicketResponse {
  ticket: string | null;
  /** Expiry, epoch ms. */
  expiresAt: number | null;
}

export interface SetupStatusResponse {
  setupComplete: boolean;
  hasToken: boolean;
  hasRecordingsDir: boolean;
}

export type RecordingsSort =
  | "date_desc"
  | "date_asc"
  | "duration_desc"
  | "duration_asc"
  | "size_desc"
  | "size_asc";

export interface RecordingsListQuery {
  limit?: number;
  offset?: number;
  search?: string;
  from?: number;
  to?: number;
  sort?: RecordingsSort;
}

export interface RecordingsListResponse {
  total: number;
  totalBytes: number;
  items: RecordingRow[];
}

export interface RecordingDetailResponse {
  recording: RecordingDetail;
}

export interface RenameRecordingRequest {
  /** New title, or `null` to clear the override and revert to Plaud's filename. */
  displayName: string | null;
}

export interface RenameRecordingResponse {
  recording: RecordingRow;
}

export interface SyncStatusResponse {
  lastPollAt: number | null;
  nextPollAt: number | null;
  polling: boolean;
  pendingTranscripts: number;
  pendingSummaries: number;
  errorsLast24h: number;
  lastError: string | null;
  authRequired: boolean;
}

export interface ClearSyncIgnoreResponse {
  ok: boolean;
  cleared: number;
}

export interface SyncBlocklistEntry {
  id: string;
  ignoredAt: number;
}

export interface SyncBlocklistResponse {
  items: SyncBlocklistEntry[];
}

export interface ConfigResponse {
  config: AppConfig;
}

export interface WebhookLogEntry {
  id: number;
  recordingId: string | null;
  recordingFilename: string | null;
  event: string;
  url: string;
  statusCode: number | null;
  responseSnippet: string | null;
  firedAt: number;
  durationMs: number | null;
  error: string | null;
}

export interface WebhookLogResponse {
  total: number;
  items: WebhookLogEntry[];
}

export interface WebhookRedeliverRequest {
  recordingId: string;
  event: "audio_ready" | "transcript_ready";
}

export interface WebhookRedeliverResponse {
  ok: boolean;
  error?: string;
}

export interface WebhookTestRequest {
  url: string;
}

export interface WebhookTestResponse {
  ok: boolean;
  statusCode?: number;
  bodySnippet?: string;
  error?: string;
  durationMs: number;
}

export interface RecordingsDirValidateRequest {
  path: string;
  /**
   * Create the directory if it's missing. Off by default — the server only
   * creates a single leaf under an existing parent, and only when asked.
   */
  create?: boolean;
}

export interface RecordingsDirValidateResponse {
  ok: boolean;
  absolutePath?: string;
  exists?: boolean;
  writable?: boolean;
  freeBytes?: number;
  error?: string;
}
