import { readFileSync, existsSync, chmodSync } from "node:fs";
import { DEFAULT_CONFIG, type AppConfig } from "@applaud/shared";
import { ensureConfigDir, settingsPath } from "./paths.js";
import { writeFileAtomic } from "./fsAtomic.js";
import { logger } from "./logger.js";

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  ensureConfigDir();
  const p = settingsPath();
  if (!existsSync(p)) {
    cached = { ...DEFAULT_CONFIG };
    return cached;
  }
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    cached = { ...DEFAULT_CONFIG, ...parsed };
    return cached;
  } catch (err) {
    logger.error({ err, path: p }, "failed to parse settings.json — using defaults");
    cached = { ...DEFAULT_CONFIG };
    return cached;
  }
}

export function saveConfig(next: AppConfig): void {
  ensureConfigDir();
  const p = settingsPath();
  // Atomic write so a crash mid-write can't leave corrupt JSON that loadConfig
  // would silently fall back to DEFAULT_CONFIG for — permanently destroying the
  // stored session on the next updateConfig. The temp file carries mode 0o600
  // so the secrets are never briefly world-readable.
  writeFileAtomic(p, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    // Best-effort; Windows will ignore.
  }
  cached = next;
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}
