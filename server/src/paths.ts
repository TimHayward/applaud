import { homedir, platform } from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

export function configDir(): string {
  const plat = platform();
  if (plat === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "applaud");
  }
  if (plat === "win32") {
    const appData = process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
    return path.join(appData, "applaud");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".config");
  return path.join(base, "applaud");
}

export function ensureConfigDir(): string {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function settingsPath(): string {
  return path.join(configDir(), "settings.json");
}

export function dbPath(): string {
  return path.join(configDir(), "state.sqlite");
}

export function logPath(): string {
  return path.join(configDir(), "applaud.log");
}

export function lockPath(): string {
  return path.join(configDir(), "applaud.lock");
}

export function isWsl(): boolean {
  if (platform() !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}
