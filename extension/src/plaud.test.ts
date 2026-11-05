import { describe, it, expect, vi } from "vitest";
import {
  diagnose,
  findApiOrigin,
  parseDetail,
  PlaudError,
  readDocuments,
  readDeviceId,
  readToken,
  readSummaryCard,
  readWorkspaceId,
  VERSION_CONFLICT,
  writeDocuments,
  type PageContext,
} from "./plaud.js";
import type { PlaudDocumentWrite } from "@applaud/shared";

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
      tokenSource: "pld_tokenstr",
      apiOrigin: null,
      deviceId: false,
      workspace: false,
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

describe("the tab's own settings (seen on Plaud in Phase 2)", () => {
  it("takes the API host from pld_plaud_user_api_domain, with or without a scheme", () => {
    const at = (v: string) =>
      findApiOrigin({ storage: storage({ pld_plaud_user_api_domain: v }), resourceUrls: () => [] });
    expect(at("https://api-euc1.plaud.ai")).toBe("https://api-euc1.plaud.ai");
    expect(at('"api-euc1.plaud.ai"')).toBe("https://api-euc1.plaud.ai");
    expect(at("evil-api.plaud.ai")).toBeNull();
    expect(at("api.plaud.ai.evil.example")).toBeNull();
  });

  it("reads the device and workspace ids", () => {
    const st = storage({
      pld_DEVICE_ID: '"0a1b2c3d4e5f6789"',
      "pld_session.workspace": '{"id":"ws_AbC123xyz","name":"Personal"}',
    });
    expect(readDeviceId(st)).toBe("0a1b2c3d4e5f6789");
    expect(readWorkspaceId(st)).toBe("ws_AbC123xyz");
    expect(readDeviceId(storage({ pld_DEVICE_ID: "<script>" }))).toBeNull();
    expect(readWorkspaceId(storage({}))).toBeNull();
  });
});

describe("writeDocuments", () => {
  const API = "https://api-euc1.plaud.ai";
  const writes: PlaudDocumentWrite[] = [
    { kind: "transcript", objectId: "o_1", contentId: "c_1", originVersion: 1001, content: "[1]" },
    { kind: "summary", objectId: "o_2", contentId: "c_2", originVersion: 1002, content: "# S" },
  ];
  const detailNow = (over: Record<string, unknown> = {}) =>
    detail([
      object("TRANSCRIPT", 1),
      { ...object("SUMMARY", 2), relation_content_ids: ["c_rel"], ...over },
    ]);

  /** A tab whose Plaud answers each PATCH from `answers`, in order. */
  function tab(answers: (Response | Error)[], detailBody: unknown = detailNow()) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/files/detail/"))
        return new Response(JSON.stringify(detailBody), { status: 200 });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? new Response("", { status: 500 });
    });
    const c: PageContext = {
      storage: storage({
        pld_tokenstr: TOKEN,
        pld_plaud_user_api_domain: API,
        pld_DEVICE_ID: "0a1b2c3d4e5f6789",
        "pld_session.workspace": '{"id":"ws_AbC123xyz"}',
      }),
      resourceUrls: () => [],
      fetch: fetchImpl as unknown as typeof fetch,
      language: "en-GB",
      timeZone: "Europe/London",
      requestId: () => "req-1",
      sleep: async () => {},
    };
    return { c, calls };
  }
  const ok = (v: number) =>
    new Response(JSON.stringify({ status: 0, data: { file_id: "f_1", version_ms: v } }), {
      status: 200,
    });

  it("sends what the web app sends, in order, with each document's version", async () => {
    const { c, calls } = tab([ok(2001), ok(2002)]);
    expect(await writeDocuments(c, "f_1", writes)).toEqual([
      { kind: "transcript", outcome: "applied", newVersion: 2001 },
      { kind: "summary", outcome: "applied", newVersion: 2002 },
    ]);
    const patches = calls.filter((x) => x.init.method === "PATCH");
    expect(patches.map((x) => x.url)).toEqual([
      `${API}/file-app/v4/files/update/content/f_1`,
      `${API}/file-app/v4/files/update/content/f_1`,
    ]);
    expect(JSON.parse(String(patches[0]!.init.body))).toEqual({
      object_id: "o_1",
      content_id: "c_1",
      content: "[1]",
      origin_version: 1001,
    });
    expect(JSON.parse(String(patches[1]!.init.body))).toEqual({
      object_id: "o_2",
      content_id: "c_2",
      content: "# S",
      origin_version: 1002,
      relation_content_ids: ["c_rel"],
    });
    expect(patches[0]!.init.headers).toEqual({
      authorization: TOKEN,
      "app-platform": "web",
      "edit-from": "web",
      "app-language": "en",
      "x-device-id": "0a1b2c3d4e5f6789",
      "x-scope-id": "ws_AbC123xyz",
      "x-scope-type": "workspace",
      "content-type": "application/json",
      "x-request-id": "req-1",
      "x-timezone-iana": "Europe/London",
    });
  });

  it("does not write when Plaud's version moved since the plan, and stops there", async () => {
    const { c, calls } = tab(
      [ok(2001)],
      detail([{ ...object("TRANSCRIPT", 1), version_ms: 9999 }, object("SUMMARY", 2)]),
    );
    expect(await writeDocuments(c, "f_1", writes)).toEqual([
      {
        kind: "transcript",
        outcome: "conflict",
        error: "Plaud's document changed since it was read",
      },
    ]);
    expect(calls.some((x) => x.init.method === "PATCH")).toBe(false);
  });

  it("stops at Plaud's version conflict and treats a non-zero status as failure even on HTTP 200", async () => {
    const conflict = new Response(
      JSON.stringify({ status: VERSION_CONFLICT, msg: "version conflict, re-fetch and retry" }),
      { status: 200 },
    );
    expect(await writeDocuments(tab([conflict]).c, "f_1", writes)).toEqual([
      {
        kind: "transcript",
        outcome: "conflict",
        error: "Plaud: version conflict, re-fetch and retry",
      },
    ]);
    const odd = new Response(JSON.stringify({ status: -1, msg: "nope" }), { status: 200 });
    expect(await writeDocuments(tab([ok(2001), odd]).c, "f_1", writes)).toEqual([
      { kind: "transcript", outcome: "applied", newVersion: 2001 },
      { kind: "summary", outcome: "failed", error: "Plaud: nope" },
    ]);
  });

  it("reports a lost reply as failed, not applied", async () => {
    expect(await writeDocuments(tab([new TypeError("network")]).c, "f_1", writes)).toEqual([
      {
        kind: "transcript",
        outcome: "failed",
        error: "no reply from Plaud; it may have been written",
      },
    ]);
  });
});

describe("finding the session token", () => {
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl";

  it("uses pld_tokenstr when present", () => {
    expect(readToken(storage({ pld_tokenstr: `"bearer ${JWT}"` }))).toBe(`bearer ${JWT}`);
  });

  it("falls back to pld_session.tokens, preferring the access token over the refresh token", () => {
    const st = storage({
      "pld_session.tokens": JSON.stringify({ refreshToken: "r".repeat(40), accessToken: JWT }),
      pld_tokenType: '"Bearer"',
    });
    expect(readToken(st)).toBe(`bearer ${JWT}`);
    expect(diagnose({ storage: st, resourceUrls: () => [] }).tokenSource).toBe(
      "pld_session.tokens",
    );
  });

  it("accepts nested and already-prefixed shapes", () => {
    expect(
      readToken(
        storage({
          "pld_session.tokens": JSON.stringify({ data: { access_token: `bearer ${JWT}` } }),
        }),
      ),
    ).toBe(`bearer ${JWT}`);
    expect(readToken(storage({ "pld_session.tokens": JSON.stringify(JWT) }))).toBe(`bearer ${JWT}`);
  });

  it("finds nothing in an empty or unrelated session", () => {
    expect(readToken(storage({ "pld_session.tokens": "{}" }))).toBeNull();
    expect(
      readToken(storage({ "pld_session.tokens": JSON.stringify({ user: "someone" }) })),
    ).toBeNull();
    expect(readToken(storage({ pld_tokenstr: "abc" }))).toBeNull();
  });
});

describe("readSummaryCard", () => {
  const API = "https://api-euc1.plaud.ai";
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const cardId = "c_01a1a6b64bfe7828b02b1c7d4b230986";

  function tab(opts: { summary?: string; mapping?: Record<string, string>; card?: Response }) {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/files/detail/")) {
        return new Response(
          JSON.stringify({
            status: 0,
            data: {
              objects: [object("TRANSCRIPT", 1), object("SUMMARY", 2)],
              relation_content_mapping: opts.mapping ?? {},
            },
          }),
        );
      }
      if (url.startsWith("https://store.example/SUMMARY")) return new Response(opts.summary ?? "");
      if (url.startsWith("https://cards.example/")) return opts.card ?? new Response(PNG);
      return new Response("", { status: 404 });
    });
    const c: PageContext = {
      storage: storage({ pld_tokenstr: TOKEN, pld_plaud_user_api_domain: API }),
      resourceUrls: () => [],
      fetch: fetchImpl as unknown as typeof fetch,
      language: "en",
    };
    return { c, fetchImpl };
  }
  const withRef = `[](plaud://image?type=summaryCard&id=${cardId})\n\n## Summary`;

  it("downloads the card the summary refers to, without credentials", async () => {
    const { c, fetchImpl } = tab({
      summary: withRef,
      mapping: { [cardId]: "https://cards.example/card_1.png?sig=1" },
    });
    const out = await readSummaryCard(c, "f_1");
    expect(out).toEqual({ status: "found", png: Buffer.from(PNG).toString("base64") });
    const cardCall = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).find(([u]) =>
      u.startsWith("https://cards.example/"),
    );
    expect(cardCall?.[1].credentials).toBe("omit");
  });

  it("tells a summary without a card from a card Plaud hasn't made yet", async () => {
    expect(await readSummaryCard(tab({ summary: "## Summary" }).c, "f_1")).toEqual({
      status: "none",
    });
    expect(await readSummaryCard(tab({ summary: withRef }).c, "f_1")).toEqual({
      status: "not_ready",
    });
  });

  it("refuses anything that isn't a PNG", async () => {
    const t = tab({
      summary: withRef,
      mapping: { [cardId]: "https://cards.example/x" },
      card: new Response("<svg/>"),
    });
    await expect(readSummaryCard(t.c, "f_1")).rejects.toThrow(/PNG/);
  });
});
