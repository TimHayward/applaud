import type { AppConfig } from "./config.js";
import type { RecordingRow, RecordingDetail } from "./recording.js";

/** `POST /api/auth/plaud/start`: where to send the browser to sign in to Plaud. */
export interface AuthStartResponse {
  authorizeUrl: string;
  /** The address Plaud will send the browser back to after sign-in. */
  redirectUri: string;
}

/** `GET /api/auth/status`. Expiries are seconds since epoch. */
export interface AuthStatusResponse {
  connected: boolean;
  /** When this session was established (epoch ms); changes on every sign-in. */
  connectedAt: number | null;
  email: string | null;
  accessTokenExp: number | null;
  refreshTokenExp: number | null;
}

export interface AuthCompleteResponse {
  ok: boolean;
  email?: string | null;
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
