import type { AppConfig } from "./config.js";
import type { RecordingRow, RecordingDetail } from "./recording.js";

export interface AuthDetectResponse {
  found: boolean;
  token?: string;
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
  | { type: "found"; token: string; profile: string; browser: string; email?: string }
  | { type: "timeout" }
  | { type: "error"; message: string };

export interface AuthManualRequest {
  token: string;
}

export interface AuthValidateResponse {
  ok: boolean;
  email?: string;
  exp?: number;
  error?: string;
}

export interface SetupStatusResponse {
  setupComplete: boolean;
  hasToken: boolean;
  hasRecordingsDir: boolean;
}

export interface RecordingsListQuery {
  limit?: number;
  offset?: number;
  search?: string;
  from?: number;
  to?: number;
}

export interface RecordingsListResponse {
  total: number;
  items: RecordingRow[];
}

export interface RecordingDetailResponse {
  recording: RecordingDetail;
}

export interface SyncStatusResponse {
  lastPollAt: number | null;
  nextPollAt: number | null;
  polling: boolean;
  pendingTranscripts: number;
  errorsLast24h: number;
  lastError: string | null;
  authRequired: boolean;
}

export interface ConfigResponse {
  config: AppConfig;
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
}

export interface RecordingsDirValidateResponse {
  ok: boolean;
  absolutePath?: string;
  exists?: boolean;
  writable?: boolean;
  freeBytes?: number;
  error?: string;
}
