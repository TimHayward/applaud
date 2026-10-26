// Keeps the stored Plaud OAuth session usable: hands out the current access
// token, renewing it from the refresh token shortly before it expires, and
// persists whatever Plaud rotates. Renewal is single-flight: a refresh token
// may be single-use, so two concurrent refreshes would burn it.

import type { AppConfig } from "@applaud/shared";
import { loadConfig, updateConfig } from "../config.js";
import { logger } from "../logger.js";
import { PLAUD_TOKEN_REFRESH_SKEW_MS } from "../constants.js";
import { PlaudOAuthError, refreshTokens, type TokenSet } from "./oauth.js";

/** The stored session is missing or Plaud refused it: the user must sign in again. */
export class PlaudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaudAuthError";
  }
}

/** Config fields written when a session is established or renewed. */
export function sessionPatch(tokens: TokenSet): Partial<AppConfig> {
  return {
    token: tokens.accessToken,
    tokenExp: tokens.accessTokenExp,
    refreshToken: tokens.refreshToken,
    refreshTokenExp: tokens.refreshTokenExp,
  };
}

function isStale(expSeconds: number | null, skewMs: number): boolean {
  // An access token with no known expiry is used until Plaud rejects it.
  if (expSeconds == null) return false;
  return expSeconds * 1000 - Date.now() <= skewMs;
}

let inFlight: Promise<string> | null = null;

async function renew(cfg: AppConfig): Promise<string> {
  if (!cfg.plaudClientId || !cfg.refreshToken) {
    throw new PlaudAuthError("Plaud session cannot be renewed; sign in again");
  }
  if (cfg.refreshTokenExp != null && cfg.refreshTokenExp * 1000 <= Date.now()) {
    throw new PlaudAuthError("Plaud refresh token has expired; sign in again");
  }
  try {
    const tokens = await refreshTokens({ clientId: cfg.plaudClientId, refreshToken: cfg.refreshToken });
    updateConfig(sessionPatch(tokens));
    logger.info(
      { accessTokenExp: tokens.accessTokenExp, refreshTokenExp: tokens.refreshTokenExp },
      "Plaud access token renewed",
    );
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof PlaudOAuthError && err.kind === "rejected") {
      throw new PlaudAuthError(`Plaud refused the refresh token; sign in again (${err.message})`);
    }
    throw err;
  }
}

/**
 * The access token to send to Plaud. Renews first when it is about to expire,
 * or always when `force` is set (Plaud rejected a token that looked current).
 * Throws `PlaudAuthError` when the user has to sign in again, and a plain
 * error for a transient failure that the next poll can retry.
 */
export async function getAccessToken(force = false): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.token) throw new PlaudAuthError("Not connected to Plaud");
  if (!force && !isStale(cfg.tokenExp, PLAUD_TOKEN_REFRESH_SKEW_MS)) return cfg.token;
  if (!inFlight) {
    inFlight = renew(cfg).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Test-only: forget an in-flight renewal between tests. */
export function resetSessionForTests(): void {
  inFlight = null;
}
