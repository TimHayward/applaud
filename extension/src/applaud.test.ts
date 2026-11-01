import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { PLAUD_WRITEBACK_PROTOCOL, PLAUD_WRITEBACK_PROTOCOL_HEADER } from "@applaud/shared";
import { ApplaudClient, normaliseApplaudUrl } from "./applaud.js";

describe("normaliseApplaudUrl", () => {
  it("keeps only the origin and assumes http without a scheme", () => {
    expect(normaliseApplaudUrl("192.168.1.20:44471")).toBe("http://192.168.1.20:44471");
    expect(normaliseApplaudUrl(" https://applaud.lan/settings?x=1 ")).toBe("https://applaud.lan");
  });

  it("refuses other schemes, credentials and junk", () => {
    expect(normaliseApplaudUrl("file:///etc")).toBeNull();
    expect(normaliseApplaudUrl("http://user:pw@host")).toBeNull();
    expect(normaliseApplaudUrl("")).toBeNull();
    expect(normaliseApplaudUrl("http://")).toBeNull();
  });
});

describe("ApplaudClient", () => {
  it("sends the token and protocol, and always asks for a dry run", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ status: "nothing" }), { status: 200 }),
    );
    await new ApplaudClient("http://a.lan:1", "tok", fetchImpl as unknown as typeof fetch).dryRun(
      "f_1",
      [],
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://a.lan:1/api/plaud-writeback/plan");
    expect(init.headers).toMatchObject({
      authorization: "Bearer tok",
      [PLAUD_WRITEBACK_PROTOCOL_HEADER]: String(PLAUD_WRITEBACK_PROTOCOL),
    });
    expect(JSON.parse(String(init.body))).toEqual({
      recordingId: "f_1",
      documents: [],
      dryRun: true,
    });
  });

  it("turns Applaud's errors into readable ones", async () => {
    const off = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "sending names to Plaud is off" }), { status: 409 }),
    );
    await expect(
      new ApplaudClient("http://a", "t", off as unknown as typeof fetch).pending(),
    ).rejects.toThrow("sending names to Plaud is off");
    const gone = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(
      new ApplaudClient("http://a", "t", gone as unknown as typeof fetch).pending(),
    ).rejects.toThrow(/Pair it again/);
    const down = vi.fn(async () => {
      throw new TypeError("network");
    });
    await expect(
      new ApplaudClient("http://a", "t", down as unknown as typeof fetch).pending(),
    ).rejects.toThrow(/Couldn't reach/);
  });
});

describe("writes to Plaud", () => {
  it("happen only in plaud.ts, in writeOne", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      const writes = src.match(/method: "PATCH"/g) ?? [];
      expect(writes.length, f).toBe(f === "plaud.ts" ? 1 : 0);
      if (f !== "plaud.ts") expect(src, f).not.toMatch(/update\/content/);
    }
  });
});
