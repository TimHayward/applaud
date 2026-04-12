export interface BindConfig {
  host: string;
  port: number;
}

export interface WebhookConfig {
  url: string;
  enabled: boolean;
  secret?: string;
}

export interface AppConfig {
  version: number;
  setupComplete: boolean;
  token: string | null;
  tokenExp: number | null;
  tokenEmail: string | null;
  recordingsDir: string | null;
  webhook: WebhookConfig | null;
  pollIntervalMinutes: number;
  bind: BindConfig;
  lanToken: string | null;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  setupComplete: false,
  token: null,
  tokenExp: null,
  tokenEmail: null,
  recordingsDir: null,
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  lanToken: null,
};
