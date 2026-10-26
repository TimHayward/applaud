// OAuth against Plaud's hosted authorisation server (`mcp.plaud.ai`).
//
// Plaud does not let individuals register developer apps, but its hosted MCP
// server is an OAuth 2.1 authorisation server that accepts dynamic client
// registration (RFC 7591) for public PKCE clients. Each install registers
// itself once, sends the user to Plaud's own sign-in page, and receives an
// access + refresh token pair. The access token is a Plaud developer-API token:
// the MCP server validates it by calling `/open/third-party/users/current` and
// forwards it unchanged to `platform.plaud.ai/developer/api`, which is how
// Applaud uses it too.
//
// Facts this module relies on, read from `@plaud-ai/mcp` 0.3.14:
//   - Registration binds the redirect URI *hosts* into the signed client id, so
//     a registration survives the server's restarts. Any scheme is accepted,
//     including `http://127.0.0.1:<port>` and LAN hostnames.
//   - Only `token_endpoint_auth_method: "none"` + S256 PKCE is needed.
//   - Refresh may omit `refresh_token`; the caller keeps the current one then.
//
// Pure I/O: no config access. `session.ts` owns persistence.

import { createHash, randomBytes } from "node:crypto";
import { HTTP_FETCH_TIMEOUT_MS, PLAUD_OAUTH_ISSUER } from "../constants.js";
import { parseJwtClaims } from "../auth/jwt.js";

export const OAUTH_CLIENT_NAME = "Applaud";

function endpoint(path: string): string {
  return `${PLAUD_OAUTH_ISSUER.replace(/\/$/, "")}${path}`;
}

/** Why an OAuth call failed: `rejected` needs the user to sign in again; `transient` may be retried. */
export class PlaudOAuthError extends Error {
  constructor(
    public readonly kind: "rejected" | "transient",
    message: string,
  ) {
    super(message);
    this.name = "PlaudOAuthError";
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Seconds since epoch, or null when Plaud gave no lifetime. */
  accessTokenExp: number | null;
  refreshTokenExp: number | null;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createState(): string {
  return randomBytes(16).toString("base64url");
}

function jwtExp(token: string): number | null {
  const exp = parseJwtClaims(token)?.exp;
  return typeof exp === "number" ? exp : null;
}

async function postOAuth(
  path: string,
  body: Record<string, string> | { json: Record<string, unknown> },
): Promise<{ status: number; data: Record<string, unknown> | null; text: string }> {
  const json = "json" in body;
  let res: Response;
  try {
    res = await fetch(endpoint(path), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
      },
      body: "json" in body ? JSON.stringify(body.json) : new URLSearchParams(body),
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PlaudOAuthError(
      "transient",
      `Plaud OAuth ${path} network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text().catch(() => "");
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON body; classified below by status.
  }
  return { status: res.status, data, text };
}

/** OAuth error responses: 5xx and 429 are worth retrying, anything else means re-authorise. */
function failure(path: string, status: number, data: Record<string, unknown> | null, text: string): PlaudOAuthError {
  const code = typeof data?.error === "string" ? data.error : null;
  const desc = typeof data?.error_description === "string" ? data.error_description : null;
  const detail = code ? `${code}${desc ? `: ${desc}` : ""}` : text.slice(0, 200);
  const kind = status >= 500 || status === 429 ? "transient" : "rejected";
  return new PlaudOAuthError(kind, `Plaud OAuth ${path} → HTTP ${status} ${detail}`.trim());
}

/** Dynamic client registration. Returns the issued `client_id`. */
export async function registerClient(redirectUri: string): Promise<string> {
  const { status, data, text } = await postOAuth("/register", {
    json: {
      client_name: OAUTH_CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  if (status < 200 || status >= 300) throw failure("/register", status, data, text);
  const clientId = data?.client_id;
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new PlaudOAuthError("transient", "Plaud OAuth /register returned no client_id");
  }
  return clientId;
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL(endpoint("/authorize"));
  url.search = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    state: opts.state,
  }).toString();
  return url.toString();
}

function parseTokenResponse(
  path: string,
  data: Record<string, unknown> | null,
  fallbackRefresh?: string,
): TokenSet {
  const accessToken = data?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new PlaudOAuthError("transient", `Plaud OAuth ${path} returned no access_token`);
  }
  const rawRefresh = data?.refresh_token;
  const refreshToken = typeof rawRefresh === "string" && rawRefresh.length > 0 ? rawRefresh : fallbackRefresh;
  if (!refreshToken) {
    throw new PlaudOAuthError("rejected", `Plaud OAuth ${path} returned no refresh_token`);
  }
  const expiresIn = typeof data?.expires_in === "number" ? data.expires_in : null;
  return {
    accessToken,
    refreshToken,
    accessTokenExp: expiresIn != null ? Math.floor(Date.now() / 1000) + expiresIn : jwtExp(accessToken),
    refreshTokenExp: jwtExp(refreshToken),
  };
}

export async function exchangeCode(opts: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenSet> {
  const { status, data, text } = await postOAuth("/token", {
    grant_type: "authorization_code",
    client_id: opts.clientId,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
  });
  if (status < 200 || status >= 300) throw failure("/token", status, data, text);
  return parseTokenResponse("/token", data);
}

export async function refreshTokens(opts: { clientId: string; refreshToken: string }): Promise<TokenSet> {
  const { status, data, text } = await postOAuth("/token", {
    grant_type: "refresh_token",
    client_id: opts.clientId,
    refresh_token: opts.refreshToken,
  });
  if (status < 200 || status >= 300) throw failure("/token", status, data, text);
  return parseTokenResponse("/token", data, opts.refreshToken);
}

/** Best effort: a failed revoke never blocks a disconnect. */
export async function revokeToken(opts: { clientId: string; token: string }): Promise<boolean> {
  try {
    const { status } = await postOAuth("/revoke", { client_id: opts.clientId, token: opts.token });
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}
