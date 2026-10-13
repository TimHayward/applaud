import { describe, it, expect, vi, beforeEach } from "vitest";

const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
vi.mock("../config.js", () => ({ loadConfig }));

import { issueTicket, verifyTicket, withTicket } from "./ticket.js";

const NOW = Date.UTC(2026, 9, 13, 12, 0);
const HOUR = 60 * 60 * 1000;

describe("signed tickets", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    loadConfig.mockReturnValue({ lanToken: "a-long-enough-lan-token" });
  });

  const issue = (scope: string, ttl = HOUR): string => issueTicket(scope, ttl, NOW)!.ticket;

  it("is not issued when no LAN token is configured", () => {
    loadConfig.mockReturnValue({ lanToken: null });
    expect(issueTicket("/", HOUR, NOW)).toBeNull();
  });

  it("reports its expiry", () => {
    expect(issueTicket("/", HOUR, NOW)?.expiresAt).toBe(NOW + HOUR);
  });

  it("grants paths under its scope until it expires", () => {
    const t = issue("/media/rec-A/");
    expect(verifyTicket(t, "/media/rec-A/audio.ogg", NOW)).toBe(true);
    expect(verifyTicket(t, "/media/rec-A/audio.ogg", NOW + HOUR + 1)).toBe(false);
  });

  it("does not grant paths outside its scope", () => {
    const t = issue("/media/rec-A/");
    expect(verifyTicket(t, "/media/rec-B/audio.ogg", NOW)).toBe(false);
    expect(verifyTicket(t, "/media/rec-AB/audio.ogg", NOW)).toBe(false);
    expect(verifyTicket(t, "/api/sync/events", NOW)).toBe(false);
  });

  it("can't climb out of its scope with ..", () => {
    const t = issue("/media/rec-A/");
    expect(verifyTicket(t, "/media/rec-A/../rec-B/audio.ogg", NOW)).toBe(false);
    expect(verifyTicket(t, "/media/rec-A/x/../../rec-B/audio.ogg", NOW)).toBe(false);
  });

  it("rejects a tampered scope or signature", () => {
    const t = issue("/media/rec-A/");
    const [payload, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ p: "/", e: Math.floor(NOW / 1000) + 3600 })).toString("base64url");
    expect(verifyTicket(`${forged}.${sig}`, "/media/rec-B/audio.ogg", NOW)).toBe(false);
    expect(verifyTicket(`${payload}.${sig!.slice(0, -2)}AA`, "/media/rec-A/audio.ogg", NOW)).toBe(false);
    expect(verifyTicket("garbage", "/media/rec-A/audio.ogg", NOW)).toBe(false);
  });

  it("is revoked by changing the LAN token", () => {
    const t = issue("/");
    loadConfig.mockReturnValue({ lanToken: "a-different-lan-token" });
    expect(verifyTicket(t, "/media/rec-A/audio.ogg", NOW)).toBe(false);
  });

  it("withTicket appends to bare and already-queried URLs", () => {
    expect(withTicket("/media/a/b.ogg", "x.y")).toBe("/media/a/b.ogg?ticket=x.y");
    expect(withTicket("/api/sync/events?a=1", "x.y")).toBe("/api/sync/events?a=1&ticket=x.y");
  });
});
