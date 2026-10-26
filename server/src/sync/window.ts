import type { AppConfig } from "@applaud/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Start of the history window (epoch ms): recordings that started at or after
 * this are downloaded in full; older ones are indexed as metadata only unless
 * the user asks for them. Anchored on the install time so the window doesn't
 * slide forward and strand recordings that were once inside it. Before setup
 * completes `installedAt` is unset and the window is anchored on now.
 */
export function historyWindowStart(cfg: Pick<AppConfig, "historyDays" | "installedAt">, now = Date.now()): number {
  const days = Number.isFinite(cfg.historyDays) && cfg.historyDays >= 0 ? cfg.historyDays : 0;
  return (cfg.installedAt ?? now) - days * DAY_MS;
}
