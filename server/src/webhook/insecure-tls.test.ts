import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { DEFAULT_CONFIG } from "@applaud/shared";

// The receiver here is on 127.0.0.1, which the SSRF guard only allows with this flag.
vi.hoisted(() => {
  process.env.APPLAUD_WEBHOOK_ALLOW_PRIVATE = "1";
});
const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
vi.mock("../config.js", () => ({ loadConfig }));

import { testWebhook } from "./post.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/tls");

describe("webhook to a receiver with a self-signed certificate", () => {
  const received: string[] = [];
  const server = https.createServer(
    {
      key: readFileSync(path.join(fixtures, "self-signed.key")),
      cert: readFileSync(path.join(fixtures, "self-signed.crt")),
    },
    (req, res) => {
      received.push(req.url ?? "");
      res.end("ok");
    },
  );
  let url = "";

  beforeAll(async () => {
    loadConfig.mockReturnValue({ ...DEFAULT_CONFIG, webhook: null });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/webhook/applaud`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("is refused while certificates are checked", async () => {
    const out = await testWebhook(url);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/certificate/);
    expect(received).toEqual([]);
  });

  it("is delivered with certificate checks off", async () => {
    const out = await testWebhook(url, { insecureTls: true });
    expect(out).toMatchObject({ ok: true, statusCode: 200 });
    expect(received).toEqual(["/webhook/applaud"]);
  });

  it("follows the saved setting when the test doesn't say", async () => {
    loadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      webhook: { url, enabled: true, insecureTls: true },
    });
    expect((await testWebhook(url)).ok).toBe(true);
  });
});
