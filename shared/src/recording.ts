export interface PlaudRawRecording {
  id: string;
  filename: string;
  fullname: string;
  filesize: number;
  file_md5: string;
  start_time: number;
  end_time: number;
  duration: number;
  version: number;
  version_ms: number;
  edit_time: number;
  is_trash: boolean;
  is_trans: boolean;
  is_summary: boolean;
  serial_number: string;
  filetype?: string;
  timezone?: number;
  zonemins?: number;
  scene?: number;
  filetag_id_list?: string[];
  is_markmemo?: boolean;
  wait_pull?: number;
}

export interface PlaudListResponse {
  status: number;
  msg: string;
  request_id?: string;
  data_file_total: number;
  data_file_list: PlaudRawRecording[];
}

export type RecordingStatus =
  | "pending_audio"
  | "audio_only"
  | "pending_transcript"
  | "complete"
  | "error"
  | "historical";

export interface RecordingRow {
  id: string;
  filename: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  filesizeBytes: number;
  serialNumber: string;
  folder: string;
  audioPath: string | null;
  transcriptPath: string | null;
  summaryPath: string | null;
  metadataPath: string | null;
  audioDownloadedAt: number | null;
  transcriptDownloadedAt: number | null;
  webhookAudioFiredAt: number | null;
  webhookTranscriptFiredAt: number | null;
  isTrash: boolean;
  isHistorical: boolean;
  lastError: string | null;
  status: RecordingStatus;
}

export interface RecordingDetail extends RecordingRow {
  transcriptText: string | null;
  summaryMarkdown: string | null;
  metadata: Record<string, unknown> | null;
  attachments: RecordingAttachment[];
}

export interface RecordingAttachment {
  filename: string;
  url: string;
}

export type SyncEventType =
  | "poll_start"
  | "poll_end"
  | "recording_new"
  | "recording_downloaded"
  | "recording_renamed"
  | "error"
  | "auth_required";

export interface SyncEvent {
  type: SyncEventType;
  at: number;
  recordingId?: string;
  message?: string;
}

export type WebhookEvent = "audio_ready" | "transcript_ready";

export type WebhookAssetType = "markdown" | "image";

export interface WebhookFileAsset {
  name: string;
  type: WebhookAssetType;
  path: string;
}

export interface WebhookHttpAsset {
  name: string;
  type: WebhookAssetType;
  url: string;
}

export interface WebhookContentAsset {
  name: string;
  type: WebhookAssetType;
  path: string;
  url: string;
  markdown_text?: string | null;
}

export interface WebhookPayload {
  event: WebhookEvent;
  recording: {
    id: string;
    filename: string;
    start_time_ms: number;
    end_time_ms: number;
    duration_ms: number;
    filesize_bytes: number;
    serial_number: string;
  };
  files: {
    folder: string;
    audio: string;
    transcript: string;
    summary: string;
    assets?: WebhookFileAsset[];
  };
  http_urls: {
    audio: string;
    transcript: string;
    summary: string;
    assets?: WebhookHttpAsset[];
  };
  /**
   * On `transcript_ready` events we include the flattened transcript text and
   * summary markdown inline so webhook consumers (e.g. n8n) can build workflows
   * without a second fetch. Omitted on `audio_ready`. Raw transcript.json with
   * speaker embeddings is NOT inlined because of size; fetch it from
   * `http_urls.transcript` when needed.
   */
  content?: {
    transcript_text: string | null;
    summary_markdown: string | null;
    assets?: WebhookContentAsset[];
  };
}
