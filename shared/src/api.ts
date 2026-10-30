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

/**
 * `off`: switched off. `checking`: capability check running. `available`: jobs
 * run. `unsupported`: this host can't run the model. `unavailable`: the check
 * or the process failed; Retry runs the check again.
 */
export type SpeakerState = "off" | "checking" | "available" | "unsupported" | "unavailable";

export interface SpeakerStatus {
  state: SpeakerState;
  reason: string | null;
  modelId: string | null;
  dim: number | null;
  /** Model the voiceprint library is built with; differs from `modelId` while re-embedding. */
  activeModelId: string | null;
  queued: number;
  failed: number;
  reembedding: number;
  /** Recording being analysed now. */
  current: string | null;
  lastRun: {
    recordingId: string;
    kind: "analyse" | "reembed";
    at: number;
    ok: boolean;
    error: string | null;
  } | null;
}

export interface SpeakerStatusResponse extends SpeakerStatus {
  enabled: boolean;
  ownerName: string | null;
  plaudNickname: string | null;
  /** Names Plaud has tagged speakers with, by number of recordings: candidates for the owner. */
  plaudNames: { name: string; recordings: number }[];
  /** The matching bands in use. */
  thresholds: SpeakerThresholds;
}

export interface SpeakerThresholds {
  autoThreshold: number;
  autoMargin: number;
  minSpeechSec: number;
  suggestThreshold: number;
}

/** `POST /api/config` body for speaker settings. */
export interface SpeakerSettingsPatch extends Partial<SpeakerThresholds> {
  enabled?: boolean;
  /** "" or null falls back to the Plaud nickname. */
  ownerName?: string | null;
}

export type SpeakerLabelStatus = "confirmed" | "auto" | "suggested" | "unknown" | "ignored";

export interface SpeakerPerson {
  id: number;
  name: string;
  isOwner: boolean;
  /** Voiceprints held for this person (never the voiceprints themselves). */
  voiceprints: number;
  /** Recordings where they are confirmed or named automatically. */
  recordings: number;
  /** Voiceprints that don't sound like the person's others. */
  lowResemblance: number;
}

/** A clip of one label's speech to listen to. */
export interface SpeakerClip {
  segmentKey: string;
  startMs: number;
  endMs: number;
  text: string;
}

/** A transcript segment with Applaud's names applied (as in `transcript-Applaud.json`). */
export interface SpeakerTranscriptSegment {
  key: string;
  startMs: number;
  endMs: number;
  text: string;
  /** Applaud's name: the person when confirmed or automatic, else Plaud's name. */
  speaker: string;
  speakerId: number | null;
  /** Plaud's name for the segment. */
  plaudSpeaker: string;
  /** Plaud's label (`original_speaker`). */
  plaudLabel: string;
  status: SpeakerLabelStatus;
  suggestedSpeaker: string | null;
  override: boolean;
}

/** One of a person's voiceprints, described. */
export interface SpeakerVoiceprint {
  id: number;
  recordingId: string;
  recordingTitle: string | null;
  recordingStart: number | null;
  plaudLabel: string;
  source: string;
  isAnchor: boolean;
  lowResemblance: boolean;
  speechMs: number;
  createdAt: number;
}

/** `GET /api/speakers/people`. */
export interface SpeakerPeopleResponse {
  people: SpeakerPerson[];
}

/** `GET /api/speakers/review`: labels still to name or confirm, by recording id. */
export interface SpeakerReviewResponse {
  enabled: boolean;
  recordings: Record<string, number>;
}

/** One Plaud speaker label in a recording, and who Applaud thinks it is. */
export interface RecordingSpeakerLabel {
  /** Plaud's `original_speaker`. */
  plaudLabel: string;
  /** Plaud's name for most of the label's segments. */
  plaudName: string | null;
  status: SpeakerLabelStatus;
  /** Who decided: Plaud's owner tag, the user, or the matcher. */
  assignedBy: "plaud_owner" | "user" | "matcher" | null;
  speakerId: number | null;
  speakerName: string | null;
  confidence: number | null;
  margin: number | null;
  /** Speech the label's voiceprint was built from. */
  speechMs: number | null;
  /** Best-matching people, best first. */
  candidates: { speakerId: number; name: string; score: number }[];
  /** Up to five stretches of this label's speech, best first. */
  clips: SpeakerClip[];
  /** Segments Plaud gave this label. */
  segments: number;
}

/** `GET /api/recordings/:id/speakers`. */
export interface RecordingSpeakersResponse {
  enabled: boolean;
  /** False until the recording has been analysed. */
  analysed: boolean;
  labels: RecordingSpeakerLabel[];
  /** Segment key → person, for segments assigned on their own. */
  overrides: Record<string, number>;
  people: SpeakerPerson[];
  /** The transcript with Applaud's names; empty until analysed. */
  segments: SpeakerTranscriptSegment[];
}

/** Assign by an existing person's id, or by name (an existing person's, or a new one). */
export type SpeakerPersonRef = { speakerId: number } | { name: string };

/** `PUT /api/recordings/:id/speakers/:label`. */
export type SetSpeakerLabelRequest =
  | { status: "confirmed"; person: SpeakerPersonRef }
  | { status: "ignored" }
  /** Hand the label back to automatic matching. */
  | { status: "unknown" };

/**
 * Response to setting a label: the recording's speakers, and what happened to
 * the voiceprint a confirmation offers (`too_short`: under the minimum speech;
 * `duplicate`: nearly identical to one the person already has).
 */
export interface SetSpeakerLabelResponse extends RecordingSpeakersResponse {
  voiceprint: "added" | "replaced" | "duplicate" | "too_short" | "none";
}

/** `PUT /api/recordings/:id/segments/:segmentKey/speaker`; `person: null` clears the override. */
export interface SetSegmentSpeakerRequest {
  person: SpeakerPersonRef | null;
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
