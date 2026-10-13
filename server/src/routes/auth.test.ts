import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { DEFAULT_CONFIG, type AppConfig } from "@applaud/shared";

const { loadConfig, updateConfig, trigger, plaudFetch } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
  trigger: vi.fn(),
  plaudFetch: vi.fn(),
}));
vi.mock("../config.js", () => ({ loadConfig, updateConfig }));
vi.mock("../sync/poller.js", () => ({ poller: { trigger } }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../plaud/client.js", async () => {
  const actual = await vi.importActual<typeof import("../plaud/client.js")>("../plaud/client.js");
  return { ...actual, plaudFetch };
});

import { authRouter } from "./auth.js";
import { verifyTicket } from "../auth/ticket.js";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const legacyJwt = `eyJ${b64({ alg: "none" }).slice(3)}.${b64({ exp: 4_000_000_000 })}.sig`;

describe("authRouter", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    loadConfig.mockReset();
    updateConfig.mockReset();
    trigger.mockReset();
    plaudFetch.mockReset();
    plaudFetch.mockResolvedValue(new Response(JSON.stringify({ status: 0 }), { status: 200 }));
    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api/auth`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const config = (over: Partial<AppConfig>): AppConfig => ({ ...DEFAULT_CONFIG, ...over });
  const accept = (): Promise<globalThis.Response> =>
    fetch(`${base}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: `bearer ${legacyJwt}` }),
    });

  describe("GET /ticket", () => {
    it("returns nulls when no LAN token is configured", async () => {
      loadConfig.mockReturnValue(config({ lanToken: null }));
      expect(await (await fetch(`${base}/ticket`)).json()).toEqual({ ticket: null, expiresAt: null });
    });

    it("issues a browser ticket valid for media and the sync stream", async () => {
      loadConfig.mockReturnValue(config({ lanToken: "a-long-enough-lan-token" }));
      const body = (await (await fetch(`${base}/ticket`)).json()) as { ticket: string; expiresAt: number };
      expect(body.expiresAt).toBeGreaterThan(Date.now());
      expect(verifyTicket(body.ticket, "/media/rec/audio.ogg")).toBe(true);
      expect(verifyTicket(body.ticket, "/api/sync/events")).toBe(true);
    });
  });

  describe("POST /accept", () => {
    it("syncs straight away when reconnecting after setup", async () => {
      loadConfig.mockReturnValue(config({ setupComplete: true }));
      const res = await accept();
      expect(res.status).toBe(200);
      expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ authMode: "legacy", token: legacyJwt }));
      expect(trigger).toHaveBeenCalledTimes(1);
    });

    it("does not start syncing during the setup wizard", async () => {
      loadConfig.mockReturnValue(config({ setupComplete: false }));
      expect((await accept()).status).toBe(200);
      expect(trigger).not.toHaveBeenCalled();
    });
  });
});
