import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { loadConfig, updateConfig } from "../config.js";
import { logger } from "../logger.js";
import { poller } from "../sync/poller.js";
import type { AuthStartResponse, AuthStatusResponse, TicketResponse } from "@applaud/shared";
import { issueTicket } from "../auth/ticket.js";
import { BROWSER_TICKET_TTL_MS } from "../constants.js";
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeCode,
  registerClient,
  revokeToken,
} from "../plaud/oauth.js";
import { sessionPatch } from "../plaud/session.js";
import { getCurrentUser } from "../plaud/client.js";

export const authRouter = Router();

/** Path Plaud's authorisation server sends the browser back to. */
export const OAUTH_CALLBACK_PATH = "/api/auth/plaud/callback";

/** How long a started sign-in stays valid (Plaud's own state TTL is 30 minutes). */
const PENDING_TTL_MS = 15 * 60 * 1000;

interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  expiresAt: number;
}

/** Started sign-ins by `state`. In memory: a restart simply asks the user to start again. */
const pending = new Map<string, PendingAuth>();

function prunePending(now = Date.now()): void {
  for (const [state, p] of pending) if (p.expiresAt <= now) pending.delete(state);
}

/** Test-only. */
export function resetPendingAuthForTests(): void {
  pending.clear();
}

/**
 * The redirect URI for this browser: the origin it is using to reach Applaud,
 * so the sign-in returns to a host it can actually reach (loopback, a LAN
 * name, or a reverse-proxied domain). The Host header has already passed the
 * DNS-rebinding check; the Origin header is preferred only when it names the
 * same host, since it also carries the scheme a TLS-terminating proxy hides.
 */
export function redirectUriFor(req: Request): string {
  const host = req.get("host") ?? "127.0.0.1";
  const origin = req.get("origin");
  if (origin) {
    try {
      const o = new URL(origin);
      if (o.host === host && (o.protocol === "http:" || o.protocol === "https:")) {
        return `${o.protocol}//${o.host}${OAUTH_CALLBACK_PATH}`;
      }
    } catch {
      // Malformed Origin: fall back to the request itself.
    }
  }
  return `${req.protocol}://${host}${OAUTH_CALLBACK_PATH}`;
}

/**
 * A short-lived signed ticket for requests that can't send the bearer header:
 * `<audio>`/`<img>`/download links and `EventSource` streams (see
 * `auth/ticket.ts`). Behind the /api bearer guard like every other route.
 * `ticket` is null when no LAN token is configured (nothing to gate).
 */
authRouter.get("/ticket", (_req, res) => {
  const issued = issueTicket("/", BROWSER_TICKET_TTL_MS);
  const body: TicketResponse = issued ?? { ticket: null, expiresAt: null };
  res.json(body);
});

authRouter.get("/status", (_req, res) => {
  const cfg = loadConfig();
  const body: AuthStatusResponse = {
    connected: !!cfg.token && !!cfg.refreshToken,
    connectedAt: cfg.plaudConnectedAt,
    email: cfg.tokenEmail,
    accessTokenExp: cfg.tokenExp,
    refreshTokenExp: cfg.refreshTokenExp,
  };
  res.json(body);
});

/**
 * Start a sign-in: register this install with Plaud's authorisation server
 * for this redirect URI (once per URI), then hand back the authorisation URL
 * for the browser to open.
 */
authRouter.post("/plaud/start", async (req, res) => {
  const redirectUri = redirectUriFor(req);
  const cfg = loadConfig();
  try {
    let clientId = cfg.plaudClientId;
    if (!clientId || cfg.plaudRedirectUri !== redirectUri) {
      clientId = await registerClient(redirectUri);
      updateConfig({ plaudClientId: clientId, plaudRedirectUri: redirectUri });
      logger.info({ redirectUri }, "registered Applaud with Plaud's authorisation server");
    }
    const { verifier, challenge } = createPkcePair();
    const state = createState();
    prunePending();
    pending.set(state, { clientId, redirectUri, codeVerifier: verifier, expiresAt: Date.now() + PENDING_TTL_MS });
    const body: AuthStartResponse = {
      authorizeUrl: buildAuthorizeUrl({ clientId, redirectUri, codeChallenge: challenge, state }),
      redirectUri,
    };
    res.json(body);
  } catch (err) {
    logger.error({ err }, "failed to start Plaud sign-in");
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

type CompleteResult = { ok: true; email: string | null } | { ok: false; status: number; error: string };

/** Finish a sign-in from the authorisation server's `code` + `state`. */
async function completeSignIn(params: {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}): Promise<CompleteResult> {
  if (params.error) {
    return { ok: false, status: 400, error: `Plaud sign-in was not completed: ${params.errorDescription ?? params.error}` };
  }
  if (!params.code || !params.state) return { ok: false, status: 400, error: "missing code or state" };
  prunePending();
  const p = pending.get(params.state);
  if (!p) return { ok: false, status: 400, error: "this sign-in has expired or was already used; start again" };
  // Single use, whatever happens next.
  pending.delete(params.state);
  try {
    const tokens = await exchangeCode({
      clientId: p.clientId,
      code: params.code,
      codeVerifier: p.codeVerifier,
      redirectUri: p.redirectUri,
    });
    updateConfig({
      ...sessionPatch(tokens),
      plaudClientId: p.clientId,
      plaudRedirectUri: p.redirectUri,
      plaudConnectedAt: Date.now(),
    });
    let email: string | null = null;
    let nickname: string | null = null;
    try {
      ({ email, nickname } = await getCurrentUser());
    } catch (err) {
      logger.warn({ err }, "signed in, but the Plaud account lookup failed");
    }
    updateConfig({ tokenEmail: email, plaudNickname: nickname });
    logger.info("Plaud account connected");
    // After setup this is a reconnect: sync now rather than at the next tick.
    if (loadConfig().setupComplete) void poller.trigger();
    return { ok: true, email };
  } catch (err) {
    logger.error({ err }, "Plaud token exchange failed");
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function callbackPage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">Return to Applaud</a></p></body></html>`;
}

/**
 * The browser lands here from Plaud. Mounted ahead of the LAN-token guard
 * (a top-level navigation can't carry the bearer header): the single-use,
 * short-lived `state` minted by /plaud/start is what authorises it.
 */
export async function oauthCallbackHandler(req: Request, res: Response): Promise<void> {
  const q = (k: string): string | undefined => (typeof req.query[k] === "string" ? (req.query[k] as string) : undefined);
  const result = await completeSignIn({
    code: q("code"),
    state: q("state"),
    error: q("error"),
    errorDescription: q("error_description"),
  });
  res.setHeader("Cache-Control", "no-store");
  if (result.ok) {
    res
      .status(200)
      .type("html")
      .send(callbackPage("Plaud connected", "You can close this tab and return to Applaud."));
  } else {
    res.status(result.status).type("html").send(callbackPage("Plaud sign-in failed", result.error));
  }
}

const CompleteSchema = z.object({ callbackUrl: z.string().min(10).max(4096) });

/**
 * Fallback for when the browser can't reach the redirect URI (e.g. Applaud is
 * opened through a different address than the one Plaud sends you back to):
 * paste the address you ended up on and Applaud finishes the sign-in.
 */
authRouter.post("/plaud/complete", async (req, res) => {
  const parsed = CompleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid body" });
    return;
  }
  let url: URL;
  try {
    url = new URL(parsed.data.callbackUrl.trim());
  } catch {
    res.status(400).json({ ok: false, error: "that is not a valid address" });
    return;
  }
  const g = (k: string): string | undefined => url.searchParams.get(k) ?? undefined;
  const result = await completeSignIn({
    code: g("code"),
    state: g("state"),
    error: g("error"),
    errorDescription: g("error_description"),
  });
  if (result.ok) res.json({ ok: true, email: result.email });
  else res.status(result.status).json({ ok: false, error: result.error });
});

/** Revoke the session at Plaud (best effort) and forget it locally. */
authRouter.post("/disconnect", async (_req, res) => {
  const cfg = loadConfig();
  if (cfg.plaudClientId && cfg.refreshToken) {
    const revoked = await revokeToken({ clientId: cfg.plaudClientId, token: cfg.refreshToken });
    if (!revoked) logger.warn("Plaud did not confirm the token revocation; clearing the local session anyway");
  }
  updateConfig({
    token: null,
    tokenExp: null,
    refreshToken: null,
    refreshTokenExp: null,
    tokenEmail: null,
    plaudConnectedAt: null,
  });
  res.json({ ok: true });
});
