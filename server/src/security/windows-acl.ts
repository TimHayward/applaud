import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { platform, userInfo } from "node:os";
import { logger } from "../logger.js";

/**
 * `chmod 600` is a no-op on Windows, so the Plaud tokens, `lanToken`, and
 * `webhook.secret` in `%APPDATA%\applaud\settings.json` inherit whatever ACL
 * the parent directory had. That's usually already user-only, but it isn't
 * guaranteed — a roaming profile or a relocated `%APPDATA%` can be wider.
 *
 * This drops inherited ACEs on the config directory and grants full control to
 * the current user and SYSTEM only. Best-effort: any failure is logged at debug
 * and ignored, and a marker file keeps it to one `icacls` call per install.
 * Set `APPLAUD_SKIP_ACL_HARDENING=1` to skip it entirely.
 */
const MARKER = ".acl-hardened";

export function hardenWindowsConfigDir(dir: string): boolean {
  if (platform() !== "win32") return false;
  if (process.env.APPLAUD_SKIP_ACL_HARDENING === "1") return false;
  const marker = path.join(dir, MARKER);
  if (existsSync(marker)) return false;
  try {
    const user = userInfo().username;
    execFileSync(
      "icacls",
      [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, "/grant:r", "*S-1-5-18:(OI)(CI)F"],
      { stdio: "ignore", timeout: 15_000, windowsHide: true },
    );
    writeFileSync(marker, "icacls /inheritance:r applied\n");
    logger.info({ dir }, "restricted config directory ACL to the current user");
    return true;
  } catch (err) {
    logger.debug({ err, dir }, "config directory ACL hardening failed (non-fatal)");
    return false;
  }
}
