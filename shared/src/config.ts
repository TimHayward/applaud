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

/** Speaker identification (docs/plans/speaker-identification.md). */
export interface SpeakerConfig {
  /** Off by default. Turning it on runs the capability check. */
  enabled: boolean;
  /**
   * The Plaud speaker name that is the account owner. Null falls back to the
   * Plaud account nickname, when Plaud has tagged speakers with it.
   */
  ownerName: string | null;
  /** Matching bands (raw cosine) and the minimum speech for a voiceprint or an automatic label. */
  autoThreshold: number;
  autoMargin: number;
  minSpeechSec: number;
  suggestThreshold: number;
  /** Model the voiceprint library was built with. Set by the server. */
  activeModelId: string | null;
}

export const DEFAULT_SPEAKER_CONFIG: SpeakerConfig = {
  enabled: false,
  ownerName: null,
  autoThreshold: 0.75,
  autoMargin: 0.1,
  minSpeechSec: 20,
  suggestThreshold: 0.55,
  activeModelId: null,
};

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
  /** The Plaud account's nickname, recorded at sign-in; used to recognise the owner's label. */
  plaudNickname: string | null;
  /** Partial in settings files written before it existed; read through `speakerConfig()`. */
  speakers: SpeakerConfig;
}

/** Speaker settings with defaults filled in. */
export function speakerConfig(cfg: Pick<AppConfig, "speakers"> | null | undefined): SpeakerConfig {
  return { ...DEFAULT_SPEAKER_CONFIG, ...cfg?.speakers };
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
  plaudNickname: null,
  speakers: DEFAULT_SPEAKER_CONFIG,
};
