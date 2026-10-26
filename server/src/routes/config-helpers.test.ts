import { describe, it, expect } from "vitest";
import type { AppConfig } from "@applaud/shared";
import { redactConfig, mergeWebhookSecret, SECRET_REDACTED } from "./config-helpers.js";

const baseConfig: AppConfig = {
  version: 1,
  setupComplete: true,
  token: null,
  tokenExp: null,
  tokenEmail: null,
  refreshToken: null,
  refreshTokenExp: null,
  plaudClientId: null,
  plaudRedirectUri: null,
  plaudConnectedAt: null,
  historyDays: 30,
  installedAt: null,
  libraryIndexedAt: null,
  recordingsDir: "/tmp/recordings",
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  publicBaseUrl: null,
  lanToken: null,
};

describe("redactConfig", () => {
  it("redacts a non-null token", () => {
    const out = redactConfig({ ...baseConfig, token: "eyJ.real-jwt.value" });
    expect(out.token).toBe(SECRET_REDACTED);
  });

  it("leaves a null token alone (no redaction sentinel for absence)", () => {
    const out = redactConfig({ ...baseConfig, token: null });
    expect(out.token).toBeNull();
  });

  it("redacts the Plaud refresh token when set, leaves it null when absent", () => {
    expect(redactConfig({ ...baseConfig, refreshToken: "eyJ.rt" }).refreshToken).toBe(SECRET_REDACTED);
    expect(redactConfig({ ...baseConfig, refreshToken: null }).refreshToken).toBeNull();
  });

  it("redacts webhook.secret when set", () => {
    const out = redactConfig({
      ...baseConfig,
      webhook: { url: "https://x", enabled: true, secret: "real-secret" },
    });
    expect(out.webhook?.secret).toBe(SECRET_REDACTED);
    // url + enabled survive
    expect(out.webhook?.url).toBe("https://x");
    expect(out.webhook?.enabled).toBe(true);
  });

  it("does not add a `secret` key when webhook has none", () => {
    const out = redactConfig({
      ...baseConfig,
      webhook: { url: "https://x", enabled: true },
    });
    expect(out.webhook).not.toHaveProperty("secret");
  });

  it("preserves a null webhook", () => {
    const out = redactConfig({ ...baseConfig, webhook: null });
    expect(out.webhook).toBeNull();
  });

  it("redacts a non-null lanToken", () => {
    const out = redactConfig({ ...baseConfig, lanToken: "real-lan-token" });
    expect(out.lanToken).toBe(SECRET_REDACTED);
  });

  it("leaves a null lanToken alone", () => {
    const out = redactConfig({ ...baseConfig, lanToken: null });
    expect(out.lanToken).toBeNull();
  });

  it("does not mutate the input", () => {
    const cfg: AppConfig = { ...baseConfig, token: "real" };
    const snap = JSON.stringify(cfg);
    redactConfig(cfg);
    expect(JSON.stringify(cfg)).toBe(snap);
  });
});

describe("mergeWebhookSecret — full truth table", () => {
  it("undefined incoming + prev set → preserves prev", () => {
    expect(mergeWebhookSecret("prev-secret", undefined)).toBe("prev-secret");
  });

  it("undefined incoming + prev unset → undefined", () => {
    expect(mergeWebhookSecret(undefined, undefined)).toBeUndefined();
  });

  it("redaction sentinel + prev set → preserves prev (UI didn't really edit)", () => {
    expect(mergeWebhookSecret("prev-secret", SECRET_REDACTED)).toBe("prev-secret");
  });

  it("redaction sentinel + prev unset → undefined (no secret to preserve)", () => {
    expect(mergeWebhookSecret(undefined, SECRET_REDACTED)).toBeUndefined();
  });

  it("empty string + prev set → undefined (Clear button)", () => {
    expect(mergeWebhookSecret("prev-secret", "")).toBeUndefined();
  });

  it("empty string + prev unset → undefined", () => {
    expect(mergeWebhookSecret(undefined, "")).toBeUndefined();
  });

  it("non-empty incoming overwrites prev", () => {
    expect(mergeWebhookSecret("old", "new")).toBe("new");
  });

  it("non-empty incoming + prev unset → new value", () => {
    expect(mergeWebhookSecret(undefined, "new")).toBe("new");
  });

  it("the literal string 'undefined' is treated as a real value, not as absence", () => {
    // Defensive: our schema accepts any string; only the JS undefined or the
    // explicit sentinel mean "preserve".
    expect(mergeWebhookSecret("prev", "undefined")).toBe("undefined");
  });
});
