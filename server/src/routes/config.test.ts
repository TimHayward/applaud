import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "@applaud/shared";

const { loadConfig, updateConfig, testWebhook } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
  testWebhook: vi.fn(),
}));
vi.mock("../config.js", () => ({ loadConfig, updateConfig }));
vi.mock("../webhook/post.js", () => ({ testWebhook }));
vi.mock("../sync/poller.js", () => ({
  poller: { trigger: vi.fn(), restart: vi.fn(), start: vi.fn() },
}));
vi.mock("../sync/state.js", () => ({ clearSyncIgnore: vi.fn(() => 0) }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { configRouter } from "./config.js";

const baseConfig = {
  version: 1,
  setupComplete: true,
  token: null,
  recordingsDir: "/tmp/r",
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  lanToken: null,
  importPlaudDeleted: false,
} as unknown as AppConfig;

describe("configRouter", () => {
  let server: Server;
  let baseUrl: string;
  let tmp: string;

  const post = (url: string, body: unknown): Promise<globalThis.Response> =>
    fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "applaud-config-test-"));
    loadConfig.mockReset();
    loadConfig.mockReturnValue(baseConfig);
    updateConfig.mockReset();
    updateConfig.mockImplementation((patch: Partial<AppConfig>) => ({ ...baseConfig, ...patch }));
    testWebhook.mockReset();
    testWebhook.mockResolvedValue({ ok: true, statusCode: 200, durationMs: 1 });

    const app = express();
    app.use(express.json());
    app.use("/api/config", configRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}/api/config`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("POST / — lanToken policy", () => {
    it("rejects a 1-character token", async () => {
      const res = await post("", { lanToken: "x" });
      expect(res.status).toBe(400);
      expect(updateConfig).not.toHaveBeenCalled();
    });

    it("accepts a token at the minimum length", async () => {
      const res = await post("", { lanToken: "0123456789abcdef" });
      expect(res.status).toBe(200);
      expect(updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ lanToken: "0123456789abcdef" }),
      );
    });

    it("still accepts the empty string (clears the token)", async () => {
      const res = await post("", { lanToken: "" });
      expect(res.status).toBe(200);
      expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ lanToken: null }));
    });

    it("still accepts the redaction sentinel (preserve existing)", async () => {
      loadConfig.mockReturnValue({ ...baseConfig, lanToken: "an-existing-long-token" });
      const res = await post("", { lanToken: "***REDACTED***" });
      expect(res.status).toBe(200);
      expect(updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ lanToken: "an-existing-long-token" }),
      );
    });
  });

  describe("POST / — webhook URL scheme", () => {
    it("rejects a non-http(s) webhook URL", async () => {
      const res = await post("", { webhook: { url: "file:///etc/passwd" } });
      expect(res.status).toBe(400);
    });

    it("accepts an https URL", async () => {
      const res = await post("", { webhook: { url: "https://example.com/hook" } });
      expect(res.status).toBe(200);
    });

    it("answers 400 (not 500) for a string that isn't a URL at all", async () => {
      const res = await post("", { webhook: { url: "not a url" } });
      expect(res.status).toBe(400);
    });
  });

  describe("POST / — webhook enabledAt (re-delivery cutoff)", () => {
    const savedWebhook = (): { enabledAt?: number } | null =>
      (updateConfig.mock.calls[0]?.[0] as Partial<AppConfig>).webhook ?? null;

    it("stamps enabledAt when a webhook is first configured", async () => {
      const before = Date.now();
      await post("", { webhook: { url: "https://example.com/hook" } });
      expect(savedWebhook()?.enabledAt).toBeGreaterThanOrEqual(before);
    });

    it("keeps the original stamp when an active webhook is edited", async () => {
      loadConfig.mockReturnValue({
        ...baseConfig,
        webhook: { url: "https://example.com/old", enabled: true, enabledAt: 1234 },
      });
      await post("", { webhook: { url: "https://example.com/new" } });
      expect(savedWebhook()?.enabledAt).toBe(1234);
    });

    it("re-stamps when a disabled webhook is turned back on", async () => {
      loadConfig.mockReturnValue({
        ...baseConfig,
        webhook: { url: "https://example.com/hook", enabled: false, enabledAt: 1234 },
      });
      await post("", { webhook: { url: "https://example.com/hook", enabled: true } });
      expect(savedWebhook()?.enabledAt).toBeGreaterThan(1234);
    });

    it("does not stamp a disabled webhook", async () => {
      await post("", { webhook: { url: "https://example.com/hook", enabled: false } });
      expect(savedWebhook()?.enabledAt).toBeUndefined();
    });
  });

  describe("POST / — publicBaseUrl", () => {
    it("stores it without a trailing slash", async () => {
      const res = await post("", { publicBaseUrl: "https://applaud.example.com/" });
      expect(res.status).toBe(200);
      expect(updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ publicBaseUrl: "https://applaud.example.com" }),
      );
    });

    it("clears it with an empty string", async () => {
      await post("", { publicBaseUrl: "" });
      expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ publicBaseUrl: null }));
    });

    it("rejects a non-http(s) URL", async () => {
      const res = await post("", { publicBaseUrl: "ftp://example.com" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /test-webhook", () => {
    it("rejects a non-http(s) URL before any fetch happens", async () => {
      const res = await post("/test-webhook", { url: "file:///etc/passwd" });
      expect(res.status).toBe(400);
      expect(testWebhook).not.toHaveBeenCalled();
    });
  });

  describe("POST /validate-recordings-dir", () => {
    it("reports a missing directory instead of creating it", async () => {
      const target = path.join(tmp, "not-created");
      const res = await post("/validate-recordings-dir", { path: target });
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, exists: false });
      expect(existsSync(target)).toBe(false);
    });

    it("creates a leaf directory when explicitly asked", async () => {
      const target = path.join(tmp, "recordings");
      const res = await post("/validate-recordings-dir", { path: target, create: true });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(existsSync(target)).toBe(true);
    });

    it("refuses to create a whole missing tree (no recursive mkdir)", async () => {
      const target = path.join(tmp, "a", "b", "c");
      const res = await post("/validate-recordings-dir", { path: target, create: true });
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/parent directory does not exist/);
      expect(existsSync(path.join(tmp, "a"))).toBe(false);
    });

    it("validates an existing directory as writable", async () => {
      const res = await post("/validate-recordings-dir", { path: tmp });
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, exists: true, writable: true });
    });

    it("rejects a path that exists but isn't a directory", async () => {
      const res = await post("/validate-recordings-dir", {
        path: path.join(tmp, "..", path.basename(tmp)),
      });
      expect((await res.json()).ok).toBe(true); // sanity: the dir itself is fine
      const file = path.join(tmp, "file.txt");
      await import("node:fs").then((fs) => fs.writeFileSync(file, "x"));
      const res2 = await post("/validate-recordings-dir", { path: file });
      const body = await res2.json();
      expect(body).toMatchObject({ ok: false, error: "path is not a directory" });
    });
  });
});
