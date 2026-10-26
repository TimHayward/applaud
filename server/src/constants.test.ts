import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = [
  "APPLAUD_PLAUD_MAX_ATTEMPTS",
  "APPLAUD_POLLER_PAGE_SIZE",
  "APPLAUD_WEBHOOK_BACKOFF_MS",
  "APPLAUD_TRASH_RETENTION_DAYS",
  "APPLAUD_RECORDINGS_MAX_LIMIT",
  "APPLAUD_PLAUD_CONTENT_HOSTS",
] as const;

describe("constants", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.resetModules();
  });

  it("falls back to the documented defaults when no env vars are set", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const {
      PLAUD_FETCH_MAX_ATTEMPTS,
      POLLER_LIST_PAGE_SIZE,
      WEBHOOK_RETRY_BACKOFF_MS,
      SOFT_DELETE_RETENTION_MS,
      RECORDINGS_LIST_MAX_LIMIT,
    } = await import("./constants.js");
    expect(PLAUD_FETCH_MAX_ATTEMPTS).toBe(3);
    expect(POLLER_LIST_PAGE_SIZE).toBe(50);
    expect(WEBHOOK_RETRY_BACKOFF_MS).toEqual([5_000, 30_000, 120_000]);
    expect(SOFT_DELETE_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(RECORDINGS_LIST_MAX_LIMIT).toBe(500);
  });

  it("honors a valid integer override", async () => {
    process.env.APPLAUD_POLLER_PAGE_SIZE = "10";
    const { POLLER_LIST_PAGE_SIZE } = await import("./constants.js");
    expect(POLLER_LIST_PAGE_SIZE).toBe(10);
  });

  it("falls back to the default on a non-numeric override", async () => {
    process.env.APPLAUD_POLLER_PAGE_SIZE = "not-a-number";
    const { POLLER_LIST_PAGE_SIZE } = await import("./constants.js");
    expect(POLLER_LIST_PAGE_SIZE).toBe(50);
  });

  it("falls back to the default on a zero or negative override", async () => {
    process.env.APPLAUD_POLLER_PAGE_SIZE = "-5";
    const { POLLER_LIST_PAGE_SIZE } = await import("./constants.js");
    expect(POLLER_LIST_PAGE_SIZE).toBe(50);
  });

  it("parses a comma-separated backoff override", async () => {
    process.env.APPLAUD_WEBHOOK_BACKOFF_MS = "1000, 2000,3000";
    const { WEBHOOK_RETRY_BACKOFF_MS } = await import("./constants.js");
    expect(WEBHOOK_RETRY_BACKOFF_MS).toEqual([1000, 2000, 3000]);
  });

  it("converts APPLAUD_TRASH_RETENTION_DAYS to milliseconds", async () => {
    process.env.APPLAUD_TRASH_RETENTION_DAYS = "3";
    const { SOFT_DELETE_RETENTION_MS } = await import("./constants.js");
    expect(SOFT_DELETE_RETENTION_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("extends the Plaud content host allowlist from APPLAUD_PLAUD_CONTENT_HOSTS", async () => {
    process.env.APPLAUD_PLAUD_CONTENT_HOSTS = "cdn.example.net, storage.example.org";
    const { PLAUD_CONTENT_HOST_SUFFIXES } = await import("./constants.js");
    expect(PLAUD_CONTENT_HOST_SUFFIXES).toEqual(
      expect.arrayContaining(["amazonaws.com", "plaud.ai", "cdn.example.net", "storage.example.org"]),
    );
  });
});
