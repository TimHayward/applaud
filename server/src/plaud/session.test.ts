import { describe, it, expect, beforeEach, vi } from "vitest";
import { DEFAULT_CONFIG, type AppConfig } from "@applaud/shared";

const { loadConfig, updateConfig, refreshTokens } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
  refreshTokens: vi.fn(),
}));
vi.mock("../config.js", () => ({ loadConfig, updateConfig }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./oauth.js", async () => {
  const actual = await vi.importActual<typeof import("./oauth.js")>("./oauth.js");
  return { ...actual, refreshTokens };
});

import { getAccessToken, PlaudAuthError, resetSessionForTests } from "./session.js";
import { PlaudOAuthError } from "./oauth.js";

const nowS = (): number => Math.floor(Date.now() / 1000);
const cfg = (over: Partial<AppConfig>): AppConfig => ({
  ...DEFAULT_CONFIG,
  token: "at",
  tokenExp: nowS() + 3600,
  refreshToken: "rt",
  refreshTokenExp: nowS() + 30 * 86400,
  plaudClientId: "cid",
  ...over,
});

describe("getAccessToken", () => {
  beforeEach(() => {
    resetSessionForTests();
    loadConfig.mockReset();
    updateConfig.mockReset();
    refreshTokens.mockReset();
  });

  it("returns the stored token while it is fresh", async () => {
    loadConfig.mockReturnValue(cfg({}));
    expect(await getAccessToken()).toBe("at");
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it("renews a token near expiry and persists the rotated pair", async () => {
    loadConfig.mockReturnValue(cfg({ tokenExp: nowS() + 60 }));
    refreshTokens.mockResolvedValue({ accessToken: "at2", refreshToken: "rt2", accessTokenExp: 1, refreshTokenExp: 2 });
    expect(await getAccessToken()).toBe("at2");
    expect(refreshTokens).toHaveBeenCalledWith({ clientId: "cid", refreshToken: "rt" });
    expect(updateConfig).toHaveBeenCalledWith({ token: "at2", tokenExp: 1, refreshToken: "rt2", refreshTokenExp: 2 });
  });

  it("runs one refresh for concurrent callers, so a single-use refresh token isn't spent twice", async () => {
    loadConfig.mockReturnValue(cfg({ tokenExp: nowS() - 1 }));
    let release!: (v: unknown) => void;
    refreshTokens.mockImplementation(() => new Promise((r) => (release = r)));
    const a = getAccessToken();
    const b = getAccessToken();
    release({ accessToken: "at2", refreshToken: "rt2", accessTokenExp: null, refreshTokenExp: null });
    expect(await Promise.all([a, b])).toEqual(["at2", "at2"]);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("force renews even a fresh-looking token", async () => {
    loadConfig.mockReturnValue(cfg({}));
    refreshTokens.mockResolvedValue({ accessToken: "at2", refreshToken: "rt", accessTokenExp: null, refreshTokenExp: null });
    expect(await getAccessToken(true)).toBe("at2");
  });

  it("asks for sign-in when not connected, the refresh token has expired, or Plaud refuses it", async () => {
    loadConfig.mockReturnValue(cfg({ token: null }));
    await expect(getAccessToken()).rejects.toBeInstanceOf(PlaudAuthError);

    loadConfig.mockReturnValue(cfg({ tokenExp: nowS() - 1, refreshTokenExp: nowS() - 1 }));
    await expect(getAccessToken()).rejects.toBeInstanceOf(PlaudAuthError);
    expect(refreshTokens).not.toHaveBeenCalled();

    loadConfig.mockReturnValue(cfg({ tokenExp: nowS() - 1 }));
    refreshTokens.mockRejectedValue(new PlaudOAuthError("rejected", "invalid_grant"));
    await expect(getAccessToken()).rejects.toBeInstanceOf(PlaudAuthError);
  });

  it("surfaces a transient refresh failure as a plain error, keeping the session", async () => {
    loadConfig.mockReturnValue(cfg({ tokenExp: nowS() - 1 }));
    refreshTokens.mockRejectedValue(new PlaudOAuthError("transient", "HTTP 503"));
    const err = await getAccessToken().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PlaudAuthError);
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
