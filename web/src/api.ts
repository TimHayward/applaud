import type {
  AuthDetectResponse,
  AuthValidateResponse,
  ConfigResponse,
  RecordingsListResponse,
  RecordingDetail,
  SyncStatusResponse,
  SetupStatusResponse,
  WebhookTestResponse,
  RecordingsDirValidateResponse,
  AppConfig,
  ClearSyncIgnoreResponse,
  SyncBlocklistResponse,
  RecordingsSort,
  WebhookLogResponse,
  WebhookRedeliverResponse,
  RenameRecordingResponse,
  TicketResponse,
} from "@applaud/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const LAN_TOKEN_STORAGE_KEY = "applaud-lan-token";

/** Only set when the server has a lanToken configured (see Settings → LAN access). Absent by default. */
export function getLanToken(): string | null {
  try {
    return localStorage.getItem(LAN_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setLanToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(LAN_TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(LAN_TOKEN_STORAGE_KEY);
  } catch {
    /* private browsing / storage disabled — nothing we can do */
  }
}

/**
 * Appends a signed ticket (from `GET /api/auth/ticket`) for requests that can't
 * set the bearer header — `<audio src>`, `<a href download>`, `<img src>`,
 * `EventSource`. Unlike the raw LAN token, a ticket only grants read access
 * and expires on its own, so it's harmless if it ends up in history or logs.
 * Components get one via `useMediaUrl()`; see `ticketedUrl` for one-offs.
 */
export function withTicket(path: string, ticket: string | null): string {
  if (!ticket) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}ticket=${encodeURIComponent(ticket)}`;
}

/**
 * `path` with a freshly issued ticket appended — for `EventSource`, which
 * reconnects with a new URL each time. Plain `path` when no LAN token is set.
 */
export async function ticketedUrl(path: string): Promise<string> {
  if (!getLanToken()) return path;
  const { ticket } = await api.mediaTicket();
  return withTicket(path, ticket);
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getLanToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(body || `HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  setupStatus: () => jsonFetch<SetupStatusResponse>("/api/setup/status"),
  authDetect: () =>
    jsonFetch<AuthDetectResponse>("/api/auth/detect", { method: "POST", body: "{}" }),
  authAccept: (token: string, email?: string) =>
    jsonFetch<{ ok: boolean; email?: string; exp?: number; error?: string }>(
      "/api/auth/accept",
      {
        method: "POST",
        body: JSON.stringify({ token, ...(email ? { email } : {}) }),
      },
    ),
  /** First-party: submit a captured `pld_ut` / `pld_urt` cookie pair. */
  authAcceptCookies: (ut: string, urt: string) =>
    jsonFetch<{ ok: boolean; email?: string; exp?: number; error?: string }>(
      "/api/auth/accept",
      {
        method: "POST",
        body: JSON.stringify({ ut, urt }),
      },
    ),
  authValidate: (token: string) =>
    jsonFetch<AuthValidateResponse>("/api/auth/validate", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  authStartWatch: () =>
    jsonFetch<{ watchId: string }>("/api/auth/watch", { method: "POST", body: "{}" }),
  mediaTicket: () => jsonFetch<TicketResponse>("/api/auth/ticket"),
  config: () => jsonFetch<ConfigResponse>("/api/config"),
  updateConfig: (patch: Partial<AppConfig>) =>
    jsonFetch<ConfigResponse>("/api/config", {
      method: "POST",
      body: JSON.stringify(patch),
    }),
  testWebhook: (url: string) =>
    jsonFetch<WebhookTestResponse>("/api/config/test-webhook", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  /** `create` is opt-in: the server won't make the folder unless asked to. */
  validateRecordingsDir: (pathStr: string, create = false) =>
    jsonFetch<RecordingsDirValidateResponse>("/api/config/validate-recordings-dir", {
      method: "POST",
      body: JSON.stringify({ path: pathStr, ...(create ? { create: true } : {}) }),
    }),
  completeSetup: () =>
    jsonFetch<{ ok: boolean }>("/api/config/complete-setup", {
      method: "POST",
      body: "{}",
    }),
  listRecordings: (
    params: {
      limit?: number;
      offset?: number;
      search?: string;
      from?: number;
      to?: number;
      sort?: RecordingsSort;
      starred?: boolean;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    if (params.search) qs.set("search", params.search);
    if (params.from != null) qs.set("from", String(params.from));
    if (params.to != null) qs.set("to", String(params.to));
    if (params.sort) qs.set("sort", params.sort);
    if (params.starred) qs.set("starred", "1");
    return jsonFetch<RecordingsListResponse>(`/api/recordings?${qs.toString()}`);
  },
  listTrashRecordings: (params: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return jsonFetch<RecordingsListResponse>(`/api/recordings/trash?${qs.toString()}`);
  },
  syncBlocklist: () => jsonFetch<SyncBlocklistResponse>("/api/recordings/sync-blocklist"),
  recordingDetail: (id: string) =>
    jsonFetch<{ recording: RecordingDetail; mediaBase: string }>(`/api/recordings/${id}`),
  deleteRecording: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/recordings/${id}`, { method: "DELETE" }),
  resyncRecording: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/recordings/${id}/resync`, { method: "POST", body: "{}" }),
  renameRecording: (id: string, displayName: string | null) =>
    jsonFetch<RenameRecordingResponse>(`/api/recordings/${id}/rename`, {
      method: "POST",
      body: JSON.stringify({ displayName }),
    }),
  restoreRecording: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/recordings/${id}/restore`, { method: "POST", body: "{}" }),
  purgeRecordingFromTrash: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/recordings/${id}/purge`, { method: "POST", body: "{}" }),
  clearSyncIgnore: () =>
    jsonFetch<ClearSyncIgnoreResponse>("/api/config/clear-sync-ignore", { method: "POST", body: "{}" }),
  syncStatus: () => jsonFetch<SyncStatusResponse>("/api/sync/status"),
  syncTrigger: () =>
    jsonFetch<{ ok: boolean }>("/api/sync/trigger", { method: "POST", body: "{}" }),
  webhookLog: (params: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return jsonFetch<WebhookLogResponse>(`/api/webhooks/log?${qs.toString()}`);
  },
  webhookRedeliver: (recordingId: string, event: "audio_ready" | "transcript_ready") =>
    jsonFetch<WebhookRedeliverResponse>("/api/webhooks/redeliver", {
      method: "POST",
      body: JSON.stringify({ recordingId, event }),
    }),
};
