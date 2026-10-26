import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { installFetchMock, type FetchMock } from "../test/fixtures/fetch.js";
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  PlaudOAuthError,
  refreshTokens,
  registerClient,
  revokeToken,
} from "./oauth.js";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>): string => `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;

describe("Plaud OAuth", () => {
  let fm: FetchMock;

  beforeEach(() => {
    fm = installFetchMock();
  });

  afterEach(() => {
    fm.restore();
  });

  it("creates an S256 PKCE pair", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("registers a public client for the redirect URI", async () => {
    fm.enqueue({ status: 201, body: JSON.stringify({ client_id: "cid.sig" }) });
    const id = await registerClient("http://127.0.0.1:44471/api/auth/plaud/callback");
    expect(id).toBe("cid.sig");
    expect(fm.calls[0]!.url).toBe("https://mcp.plaud.ai/register");
    const body = JSON.parse(String(fm.calls[0]!.init?.body));
    expect(body).toMatchObject({
      client_name: "Applaud",
      redirect_uris: ["http://127.0.0.1:44471/api/auth/plaud/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
  });

  it("builds the authorisation URL with PKCE and state", () => {
    const url = new URL(
      buildAuthorizeUrl({ clientId: "cid", redirectUri: "http://x/cb", codeChallenge: "ch", state: "st" }),
    );
    expect(url.origin + url.pathname).toBe("https://mcp.plaud.ai/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: "http://x/cb",
      response_type: "code",
      code_challenge: "ch",
      code_challenge_method: "S256",
      state: "st",
    });
  });

  it("exchanges a code for tokens and reads the refresh token's expiry", async () => {
    const rt = jwt({ exp: 2_000_000_000 });
    fm.enqueue({ body: JSON.stringify({ access_token: "at", refresh_token: rt, expires_in: 3600 }) });
    const before = Math.floor(Date.now() / 1000);
    const t = await exchangeCode({ clientId: "cid", code: "c", codeVerifier: "v", redirectUri: "http://x/cb" });
    expect(t.accessToken).toBe("at");
    expect(t.refreshToken).toBe(rt);
    expect(t.refreshTokenExp).toBe(2_000_000_000);
    expect(t.accessTokenExp).toBeGreaterThanOrEqual(before + 3600);
    const form = new URLSearchParams(String(fm.calls[0]!.init?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      client_id: "cid",
      code: "c",
      code_verifier: "v",
      redirect_uri: "http://x/cb",
    });
  });

  it("keeps the current refresh token when a refresh response omits it", async () => {
    fm.enqueue({ body: JSON.stringify({ access_token: "at2", expires_in: 60 }) });
    const t = await refreshTokens({ clientId: "cid", refreshToken: "old-rt" });
    expect(t.refreshToken).toBe("old-rt");
    expect(t.accessToken).toBe("at2");
  });

  it("classifies a refused grant as rejected and a 5xx as transient", async () => {
    fm.enqueue({ status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: "expired" }) });
    await expect(refreshTokens({ clientId: "cid", refreshToken: "rt" })).rejects.toMatchObject({
      kind: "rejected",
      message: expect.stringContaining("invalid_grant: expired"),
    });
    fm.enqueue({ status: 503, body: "busy" });
    await expect(refreshTokens({ clientId: "cid", refreshToken: "rt" })).rejects.toMatchObject({ kind: "transient" });
    fm.enqueue({ throws: new TypeError("fetch failed") });
    const err = await refreshTokens({ clientId: "cid", refreshToken: "rt" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaudOAuthError);
    expect((err as PlaudOAuthError).kind).toBe("transient");
  });

  it("revoke is best effort", async () => {
    fm.enqueue({ status: 200, body: "{}" });
    expect(await revokeToken({ clientId: "cid", token: "rt" })).toBe(true);
    fm.enqueue({ throws: new TypeError("fetch failed") });
    expect(await revokeToken({ clientId: "cid", token: "rt" })).toBe(false);
  });
});
