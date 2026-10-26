export interface BindConfig {
  host: string;
  port: number;
}

export interface WebhookConfig {
  url: string;
  enabled: boolean;
  secret?: string;
  /**
   * When the webhook last went from off/unconfigured to active (epoch ms). Set
   * server-side. Automatic re-delivery only covers assets downloaded at or
   * after this point, so enabling a webhook doesn't replay the whole library.
   * Unset on configs that predate it, which means "no cutoff".
   */
  enabledAt?: number;
}

export interface AppConfig {
  version: number;
  setupComplete: boolean;
  /**
   * Plaud OAuth session, obtained through Plaud's hosted authorisation server
   * (`mcp.plaud.ai`) with dynamic client registration and PKCE. `token` is
   * the short-lived access token sent to Plaud's developer API; it is renewed
   * from `refreshToken` before it expires. All expiries are seconds since epoch.
   */
  token: string | null;
  tokenExp: number | null;
  tokenEmail: string | null;
  refreshToken: string | null;
  refreshTokenExp: number | null;
  /** Client id issued to this install by dynamic client registration. */
  plaudClientId: string | null;
  /** The redirect URI `plaudClientId` was registered with. */
  plaudRedirectUri: string | null;
  /** When the current Plaud session was established by sign-in (epoch ms). */
  plaudConnectedAt: number | null;
  recordingsDir: string | null;
  webhook: WebhookConfig | null;
  pollIntervalMinutes: number;
  bind: BindConfig;
  /**
   * Base URL other machines use to reach this instance (e.g.
   * `http://192.168.1.20:44471` or `https://applaud.example.com`), for the
   * `http_urls` in webhook payloads. Null falls back to `http://<bind host>:<port>`,
   * which is only reachable from this machine.
   */
  publicBaseUrl: string | null;
  lanToken: string | null;
  /**
   * How many days of history before `installedAt` are downloaded in full.
   * Older recordings are indexed as metadata only and can be downloaded one
   * at a time on request. Recordings made after install always download.
   */
  historyDays: number;
  /** When sync was first set up (epoch ms); the anchor for `historyDays`. */
  installedAt: number | null;
  /**
   * When the discovery walk last reached the end of the Plaud list (epoch ms).
   * Until set, every poll walks the whole list; after, routine polls stop at
   * the first page with nothing new.
   */
  libraryIndexedAt: number | null;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 2,
  setupComplete: false,
  token: null,
  tokenExp: null,
  tokenEmail: null,
  refreshToken: null,
  refreshTokenExp: null,
  plaudClientId: null,
  plaudRedirectUri: null,
  plaudConnectedAt: null,
  recordingsDir: null,
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  publicBaseUrl: null,
  lanToken: null,
  historyDays: 30,
  installedAt: null,
  libraryIndexedAt: null,
};
