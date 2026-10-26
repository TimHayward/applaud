import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { DEFAULT_CONFIG, type AppConfig } from "@applaud/shared";

const { loadConfig, updateConfig, trigger, registerClient, exchangeCode, revokeToken, getCurrentUser } = vi.hoisted(
  () => ({
    loadConfig: vi.fn(),
    updateConfig: vi.fn(),
    trigger: vi.fn(),
    registerClient: vi.fn(),
    exchangeCode: vi.fn(),
    revokeToken: vi.fn(),
    getCurrentUser: vi.fn(),
  }),
);
vi.mock("../config.js", () => ({ loadConfig, updateConfig }));
vi.mock("../sync/poller.js", () => ({ poller: { trigger } }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../plaud/oauth.js", async () => {
  const actual = await vi.importActual<typeof import("../plaud/oauth.js")>("../plaud/oauth.js");
  return { ...actual, registerClient, exchangeCode, revokeToken };
});
vi.mock("../plaud/client.js", () => ({ getCurrentUser }));

import { authRouter, oauthCallbackHandler, OAUTH_CALLBACK_PATH, resetPendingAuthForTests } from "./auth.js";
import { verifyTicket } from "../auth/ticket.js";

describe("authRouter", () => {
  let server: Server;
  let origin: string;
  let base: string;
  let state: AppConfig;

  beforeEach(async () => {
    resetPendingAuthForTests();
    state = { ...DEFAULT_CONFIG };
    loadConfig.mockReset();
    loadConfig.mockImplementation(() => state);
    updateConfig.mockReset();
    updateConfig.mockImplementation((patch: Partial<AppConfig>) => {
      state = { ...state, ...patch };
      return state;
    });
    trigger.mockReset();
    registerClient.mockReset();
    registerClient.mockResolvedValue("cid.sig");
    exchangeCode.mockReset();
    exchangeCode.mockResolvedValue({ accessToken: "at", refreshToken: "rt", accessTokenExp: 111, refreshTokenExp: 222 });
    revokeToken.mockReset();
    revokeToken.mockResolvedValue(true);
    getCurrentUser.mockReset();
    getCurrentUser.mockResolvedValue({ id: "u1", nickname: null, email: "me@example.com" });

    const app = express();
    app.use(express.json());
    app.get(OAUTH_CALLBACK_PATH, (req, res) => void oauthCallbackHandler(req, res));
    app.use("/api/auth", authRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    base = `${origin}/api/auth`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const start = async (headers: Record<string, string> = {}): Promise<{ authorizeUrl: string; redirectUri: string }> => {
    const res = await fetch(`${base}/plaud/start`, { method: "POST", headers });
    expect(res.status).toBe(200);
    return (await res.json()) as { authorizeUrl: string; redirectUri: string };
  };
  const stateOf = (authorizeUrl: string): string => new URL(authorizeUrl).searchParams.get("state")!;

  describe("GET /ticket", () => {
    it("returns nulls when no LAN token is configured", async () => {
      expect(await (await fetch(`${base}/ticket`)).json()).toEqual({ ticket: null, expiresAt: null });
    });

    it("issues a browser ticket valid for media and the sync stream", async () => {
      state = { ...state, lanToken: "a-long-enough-lan-token" };
      const body = (await (await fetch(`${base}/ticket`)).json()) as { ticket: string; expiresAt: number };
      expect(body.expiresAt).toBeGreaterThan(Date.now());
      expect(verifyTicket(body.ticket, "/media/rec/audio.ogg")).toBe(true);
      expect(verifyTicket(body.ticket, "/api/sync/events")).toBe(true);
    });
  });

  describe("sign-in", () => {
    it("registers once per redirect URI and returns Plaud's authorisation URL", async () => {
      const first = await start();
      expect(first.redirectUri).toBe(`${origin}${OAUTH_CALLBACK_PATH}`);
      expect(registerClient).toHaveBeenCalledWith(first.redirectUri);
      const url = new URL(first.authorizeUrl);
      expect(url.host).toBe("mcp.plaud.ai");
      expect(url.searchParams.get("client_id")).toBe("cid.sig");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");

      await start();
      expect(registerClient).toHaveBeenCalledTimes(1);
    });

    it("re-registers when the browser reaches Applaud through a different address", async () => {
      state = { ...state, plaudClientId: "old", plaudRedirectUri: "http://nas.lan:44471/api/auth/plaud/callback" };
      await start();
      expect(registerClient).toHaveBeenCalledTimes(1);
      expect(state.plaudClientId).toBe("cid.sig");
    });

    it("uses the Origin's scheme when it names the same host (TLS-terminating proxy)", async () => {
      const host = new URL(origin).host;
      const { redirectUri } = await start({ origin: `https://${host}` });
      expect(redirectUri).toBe(`https://${host}${OAUTH_CALLBACK_PATH}`);
      const other = await start({ origin: "https://evil.example" });
      expect(other.redirectUri).toBe(`${origin}${OAUTH_CALLBACK_PATH}`);
    });

    it("completes on the callback, stores the session and the account email", async () => {
      const { authorizeUrl, redirectUri } = await start();
      const res = await fetch(`${origin}${OAUTH_CALLBACK_PATH}?code=abc&state=${stateOf(authorizeUrl)}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Plaud connected");
      expect(exchangeCode).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: "cid.sig", code: "abc", redirectUri, codeVerifier: expect.any(String) }),
      );
      expect(state).toMatchObject({ token: "at", refreshToken: "rt", tokenExp: 111, refreshTokenExp: 222, tokenEmail: "me@example.com" });
      // During setup the poller isn't running yet.
      expect(trigger).not.toHaveBeenCalled();

      const status = await (await fetch(`${base}/status`)).json();
      expect(status).toEqual({
        connected: true,
        connectedAt: expect.any(Number),
        email: "me@example.com",
        accessTokenExp: 111,
        refreshTokenExp: 222,
      });
    });

    it("syncs straight away when reconnecting after setup", async () => {
      state = { ...state, setupComplete: true };
      const { authorizeUrl } = await start();
      await fetch(`${origin}${OAUTH_CALLBACK_PATH}?code=abc&state=${stateOf(authorizeUrl)}`);
      expect(trigger).toHaveBeenCalledTimes(1);
    });

    it("rejects an unknown or reused state", async () => {
      const { authorizeUrl } = await start();
      const s = stateOf(authorizeUrl);
      expect((await fetch(`${origin}${OAUTH_CALLBACK_PATH}?code=abc&state=forged`)).status).toBe(400);
      expect((await fetch(`${origin}${OAUTH_CALLBACK_PATH}?code=abc&state=${s}`)).status).toBe(200);
      expect((await fetch(`${origin}${OAUTH_CALLBACK_PATH}?code=abc&state=${s}`)).status).toBe(400);
      expect(exchangeCode).toHaveBeenCalledTimes(1);
    });

    it("reports a declined consent without exchanging anything", async () => {
      const { authorizeUrl } = await start();
      const res = await fetch(`${origin}${OAUTH_CALLBACK_PATH}?error=access_denied&state=${stateOf(authorizeUrl)}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("access_denied");
      expect(exchangeCode).not.toHaveBeenCalled();
    });

    it("escapes the error text on the callback page", async () => {
      const res = await fetch(`${origin}${OAUTH_CALLBACK_PATH}?error=x&error_description=${encodeURIComponent("<script>")}`);
      expect(await res.text()).not.toContain("<script>");
    });

    it("finishes from a pasted callback address", async () => {
      const { authorizeUrl, redirectUri } = await start();
      const res = await fetch(`${base}/plaud/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callbackUrl: `${redirectUri}?code=abc&state=${stateOf(authorizeUrl)}` }),
      });
      expect(await res.json()).toEqual({ ok: true, email: "me@example.com" });
    });
  });

  it("POST /disconnect revokes the refresh token and clears the session", async () => {
    state = { ...state, token: "at", refreshToken: "rt", plaudClientId: "cid", tokenEmail: "me@example.com" };
    const res = await fetch(`${base}/disconnect`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(revokeToken).toHaveBeenCalledWith({ clientId: "cid", token: "rt" });
    expect(state).toMatchObject({ token: null, refreshToken: null, tokenEmail: null });
  });
});
