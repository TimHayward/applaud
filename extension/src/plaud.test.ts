import { describe, it, expect, vi } from "vitest";
import {
  diagnose,
  findApiOrigin,
  parseDetail,
  PlaudError,
  readDocuments,
  readToken,
  type PageContext,
} from "./plaud.js";

const TOKEN = `bearer ${"x".repeat(40)}`;

function storage(items: Record<string, string>): PageContext["storage"] {
  const keys = Object.keys(items);
  return { getItem: (k) => items[k] ?? null, key: (i) => keys[i] ?? null, length: keys.length };
}

// Shaped like the spike capture (plan Appendix A.8); ids and content are synthetic.
const detail = (objects: Record<string, unknown>[]) => ({ status: 0, data: { objects } });
const object = (type: string, n: number) => ({
  object_id: `o_${n}`,
  object_type: type,
  content_id: `c_${n}`,
  content_url: `https://store.example/${type}?sig=1`,
  version_ms: 1000 + n,
  mime_type: "text/plain",
});

function ctx(
  over: Partial<PageContext> = {},
  responses: Record<string, unknown> = {},
): PageContext {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = Object.entries(responses).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (body instanceof Response) return body;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  });
  return {
    storage: storage({ pld_tokenstr: JSON.stringify(TOKEN) }),
    resourceUrls: () => [
      "https://web.plaud.ai/app.js",
      "https://api-euc1.plaud.ai/user-app/profile/workspace/me",
    ],
    fetch: fetchImpl as unknown as typeof fetch,
    language: "en-GB",
    ...over,
  };
}

describe("page context", () => {
  it("reads the token with or without JSON quotes, and nothing else", () => {
    expect(readToken(storage({ pld_tokenstr: TOKEN }))).toBe(TOKEN);
    expect(readToken(storage({ pld_tokenstr: JSON.stringify(TOKEN) }))).toBe(TOKEN);
    expect(readToken(storage({ pld_tokenstr: "abc" }))).toBeNull();
    expect(readToken(storage({}))).toBeNull();
  });

  it("finds the regional API host from the page's requests, newest first", () => {
    expect(
      findApiOrigin({
        storage: storage({}),
        resourceUrls: () => [
          "https://api.plaud.ai/a",
          "https://api-apse1.plaud.ai/b",
          "https://evil.example/api-x.plaud.ai/",
        ],
      }),
    ).toBe("https://api-apse1.plaud.ai");
  });

  it("falls back to storage, and doesn't accept look-alike hosts", () => {
    expect(
      findApiOrigin({
        storage: storage({ cfg: '{"base":"https://api-usw2.plaud.ai/v1"}' }),
        resourceUrls: () => [],
      }),
    ).toBe("https://api-usw2.plaud.ai");
    expect(
      findApiOrigin({
        storage: storage({}),
        resourceUrls: () => ["https://api.plaud.ai.evil.example/"],
      }),
    ).toBeNull();
  });

  it("diagnoses by key name only", () => {
    const d = diagnose({
      storage: storage({ pld_tokenstr: TOKEN, deviceId: "secret", other: "x" }),
      resourceUrls: () => [],
    });
    expect(d).toEqual({
      signedIn: true,
      apiOrigin: null,
      relevantKeys: ["deviceId", "pld_tokenstr"],
    });
    expect(JSON.stringify(d)).not.toContain("secret");
  });
});

describe("parseDetail", () => {
  it("keeps the three document kinds and ignores the rest", () => {
    const out = parseDetail(
      detail([
        object("AUDIO", 1),
        object("TRANSCRIPT", 2),
        object("POLISHED_TRANSCRIPT", 3),
        object("SUMMARY", 4),
        object("OUTLINE", 5),
      ]),
    );
    expect(out.objects.map((o) => o.object_type)).toEqual([
      "TRANSCRIPT",
      "POLISHED_TRANSCRIPT",
      "SUMMARY",
    ]);
    expect(out.warnings).toEqual([]);
  });

  it("leaves a kind alone when Plaud has more than one (Q3)", () => {
    const out = parseDetail(
      detail([object("TRANSCRIPT", 1), object("SUMMARY", 2), object("SUMMARY", 3)]),
    );
    expect(out.objects.map((o) => o.object_type)).toEqual(["TRANSCRIPT"]);
    expect(out.warnings).toEqual(["Plaud has 2 summary documents; they are left as they are"]);
  });

  it("refuses Plaud errors and unexpected shapes", () => {
    expect(() => parseDetail({ status: -1, msg: "nope" })).toThrow(/nope/);
    expect(() => parseDetail({ status: 0, data: {} })).toThrow(PlaudError);
    expect(() => parseDetail(detail([{ ...object("TRANSCRIPT", 1), version_ms: "1" }]))).toThrow(
      PlaudError,
    );
  });
});

describe("readDocuments", () => {
  const api = "https://api-euc1.plaud.ai/file-app/v4/files/detail/f_1";

  it("reads each document with its ids and version, sending the session token only to Plaud's API", async () => {
    const c = ctx(
      {},
      {
        [api]: detail([object("TRANSCRIPT", 1), object("SUMMARY", 2)]),
        "https://store.example/TRANSCRIPT": "[]",
        "https://store.example/SUMMARY": "# Notes",
      },
    );
    const out = await readDocuments(c, "f_1");
    expect(out.documents).toEqual([
      { kind: "transcript", objectId: "o_1", contentId: "c_1", version: 1001, content: "[]" },
      { kind: "summary", objectId: "o_2", contentId: "c_2", version: 1002, content: "# Notes" },
    ]);
    const calls = (c.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      RequestInit,
    ][];
    expect(calls[0]![1].headers).toMatchObject({
      authorization: TOKEN,
      "app-platform": "web",
      "app-language": "en",
    });
    for (const [, init] of calls.slice(1)) {
      expect(JSON.stringify(init)).not.toContain(TOKEN);
      expect(init.credentials).toBe("omit");
    }
  });

  it("explains what to do when it can't read", async () => {
    await expect(readDocuments(ctx({ storage: storage({}) }), "f_1")).rejects.toThrow(
      /not signed in/,
    );
    await expect(readDocuments(ctx({ resourceUrls: () => [] }), "f_1")).rejects.toThrow(
      /Reload the Plaud tab/,
    );
    await expect(
      readDocuments(ctx({}, { [api]: new Response("", { status: 401 }) }), "f_1"),
    ).rejects.toThrow(/signed out/);
    await expect(
      readDocuments(ctx({}, { [api]: detail([object("SUMMARY", 1)]) }), "f_1"),
    ).rejects.toThrow(/no transcript/);
    await expect(readDocuments(ctx(), "../x")).rejects.toThrow(/invalid/);
  });
});
