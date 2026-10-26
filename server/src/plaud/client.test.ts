import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { installFetchMock, type FetchMock } from "../test/fixtures/fetch.js";

const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  return { ...actual, getAccessToken };
});
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  assertContentUrl,
  audioExtensionFromUrl,
  fetchContentText,
  getCurrentUser,
  getFile,
  listFiles,
  loadBlockContent,
  parseApiTimestamp,
  PlaudApiError,
  PlaudAuthError,
} from "./client.js";

const API = "https://platform.plaud.ai/developer/api";

describe("Plaud developer API client", () => {
  let fm: FetchMock;

  beforeEach(() => {
    fm = installFetchMock();
    getAccessToken.mockReset();
    getAccessToken.mockResolvedValue("at");
  });

  afterEach(() => {
    fm.restore();
  });

  it("lists files with paging and the date filter, sending the bearer", async () => {
    fm.enqueue({ body: JSON.stringify({ type: "list", data: [{ id: "f_1", name: "A" }, { nope: 1 }], page: 2, page_size: 50 }) });
    const files = await listFiles({ page: 2, pageSize: 50, startMs: 1000, endMs: 2000 });
    expect(files.map((f) => f.id)).toEqual(["f_1"]);
    const call = fm.calls[0]!;
    expect(call.url).toBe(`${API}/open/third-party/files/?page=2&page_size=50&start_date=1000&end_date=2000`);
    expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer at");
  });

  it("never asks for fewer than Plaud's minimum page size", async () => {
    fm.enqueue({ body: JSON.stringify({ data: [] }) });
    await listFiles({ page: 1, pageSize: 1 });
    expect(fm.calls[0]!.url).toContain("page_size=10");
  });

  it("renews the token once on a 401 and gives up on a second", async () => {
    fm.enqueue({ status: 401, body: "{}" });
    fm.enqueue({ body: JSON.stringify({ id: "f_1", name: "A" }) });
    expect((await getFile("f_1")).id).toBe("f_1");
    expect(getAccessToken.mock.calls.map((c) => c[0])).toEqual([false, true]);

    fm.enqueue({ status: 401, body: "{}" });
    fm.enqueue({ status: 401, body: "{}" });
    await expect(getFile("f_1")).rejects.toBeInstanceOf(PlaudAuthError);
  });

  it("surfaces a 404 as a PlaudApiError with the status", async () => {
    fm.enqueue({ status: 404, body: "not found" });
    const err = await getFile("gone").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaudApiError);
    expect((err as PlaudApiError).status).toBe(404);
  });

  it("reads the current user, wrapped or bare", async () => {
    fm.enqueue({ body: JSON.stringify({ data: { id: 7, nickname: "N", email: "a@b.c" } }) });
    expect(await getCurrentUser()).toEqual({ id: "7", nickname: "N", email: "a@b.c" });
    fm.enqueue({ body: JSON.stringify({ id: "u", email: null }) });
    expect(await getCurrentUser()).toEqual({ id: "u", nickname: null, email: null });
  });

  it("only fetches content from https storage hosts on the allowlist", () => {
    expect(() => assertContentUrl("https://euc1-prod.s3-accelerate.amazonaws.com/x.ogg")).not.toThrow();
    expect(() => assertContentUrl("http://bucket.s3.amazonaws.com/x")).toThrow(/https/);
    expect(() => assertContentUrl("https://192.168.1.10/x")).toThrow(/not allowed/);
    expect(() => assertContentUrl("https://evilamazonaws.com/x")).toThrow(/not allowed/);
    expect(() => assertContentUrl("https://u:p@bucket.s3.amazonaws.com/x")).toThrow(/credentials/);
  });

  it("gunzips gzipped content and passes plain content through", async () => {
    fm.enqueue({ body: "plain" });
    expect(await fetchContentText("https://b.s3.amazonaws.com/a.md")).toBe("plain");

    const gz = gzipSync(Buffer.from('[{"content":"hi"}]'));
    fm.fn.mockImplementationOnce(async () => new Response(gz, { status: 200 }));
    expect(await fetchContentText("https://b.s3.amazonaws.com/t.json.gz")).toBe('[{"content":"hi"}]');
  });

  it("prefers inline block content over the link", async () => {
    expect(await loadBlockContent({ data_content: "inline", data_link: "https://b.s3.amazonaws.com/x" })).toBe("inline");
    expect(fm.calls).toHaveLength(0);
    fm.enqueue({ body: "linked" });
    expect(await loadBlockContent({ data_content: "", data_link: "https://b.s3.amazonaws.com/x" })).toBe("linked");
  });

  it("parses Plaud's zone-less timestamps as UTC", () => {
    expect(parseApiTimestamp("2026-10-26T10:30:29.542000")).toBe(Date.UTC(2026, 9, 26, 10, 30, 29, 542));
    expect(parseApiTimestamp("2026-10-26T10:30:29+01:00")).toBe(Date.UTC(2026, 9, 26, 9, 30, 29));
    expect(parseApiTimestamp("")).toBeNull();
    expect(parseApiTimestamp("garbage")).toBeNull();
  });

  it("reads the audio extension from a signed URL", () => {
    expect(audioExtensionFromUrl("https://b.s3.amazonaws.com/audiofiles/f/o_1.ogg?X-Amz-Expires=3600")).toBe("ogg");
    expect(audioExtensionFromUrl("https://b.s3.amazonaws.com/audiofiles/f/o_1")).toBeNull();
  });
});
