import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));

import { assertWebhookTargetAllowed, BlockedTargetError, redirectFailureMessage } from "./ssrf.js";

function dnsReturns(...addresses: string[]): void {
  lookup.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
}

describe("assertWebhookTargetAllowed", () => {
  beforeEach(() => {
    lookup.mockReset();
  });

  it("allows a public https URL", async () => {
    dnsReturns("93.184.216.34");
    await expect(assertWebhookTargetAllowed("https://example.com/hook")).resolves.toBeInstanceOf(URL);
  });

  it("allows a public IP literal without a DNS lookup", async () => {
    await expect(assertWebhookTargetAllowed("http://93.184.216.34/hook")).resolves.toBeInstanceOf(URL);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "file:///etc/passwd",
    "gopher://example.com/",
    "data:text/plain,hi",
    "ftp://example.com/x",
  ])("rejects the non-http(s) scheme in %s", async (url) => {
    await expect(assertWebhookTargetAllowed(url)).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it("rejects embedded credentials", async () => {
    dnsReturns("93.184.216.34");
    await expect(assertWebhookTargetAllowed("https://user:pw@example.com/x")).rejects.toThrow(
      /credentials/,
    );
  });

  it("rejects a garbage URL", async () => {
    await expect(assertWebhookTargetAllowed("not a url")).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it.each([
    "http://127.0.0.1:8080/probe",
    "http://localhost.localdomain/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:9000/",
    "http://10.1.2.3/admin",
  ])("rejects the private/loopback target %s", async (url) => {
    // Hostnames that aren't literals resolve to a private address in this test.
    dnsReturns("127.0.0.1");
    await expect(assertWebhookTargetAllowed(url)).rejects.toThrow(/private\/loopback/);
  });

  it("rejects a public hostname that resolves to a private address (DNS rebinding)", async () => {
    dnsReturns("10.0.0.7");
    await expect(assertWebhookTargetAllowed("https://evil.example/hook")).rejects.toThrow(
      /private\/loopback/,
    );
  });

  it("rejects when any answer in a multi-record response is private", async () => {
    dnsReturns("93.184.216.34", "192.168.1.10");
    await expect(assertWebhookTargetAllowed("https://mixed.example/hook")).rejects.toThrow(
      /private\/loopback/,
    );
  });

  it("rejects a host that doesn't resolve", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertWebhookTargetAllowed("https://nope.example/hook")).rejects.toThrow(
      /could not resolve/,
    );
  });

  it("names the opt-out env var in the error so self-hosters can find it", async () => {
    await expect(assertWebhookTargetAllowed("http://192.168.1.50:5678/webhook/x")).rejects.toThrow(
      /APPLAUD_WEBHOOK_ALLOW_PRIVATE/,
    );
  });
});

describe("assertWebhookTargetAllowed with APPLAUD_WEBHOOK_ALLOW_PRIVATE=1", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("allows a loopback target (local n8n / Home Assistant)", async () => {
    vi.stubEnv("APPLAUD_WEBHOOK_ALLOW_PRIVATE", "1");
    vi.resetModules();
    const mod = await import("./ssrf.js");
    await expect(
      mod.assertWebhookTargetAllowed("http://127.0.0.1:5678/webhook/abc"),
    ).resolves.toBeInstanceOf(URL);
  });

  it("still rejects a non-http scheme", async () => {
    vi.stubEnv("APPLAUD_WEBHOOK_ALLOW_PRIVATE", "1");
    vi.resetModules();
    const mod = await import("./ssrf.js");
    await expect(mod.assertWebhookTargetAllowed("file:///etc/passwd")).rejects.toThrow(
      /unsupported scheme/,
    );
  });
});

describe("redirectFailureMessage", () => {
  const res = (status: number, location?: string): Response =>
    ({ status, headers: { get: () => location ?? null } }) as unknown as Response;

  it("returns null for a 2xx", () => {
    expect(redirectFailureMessage(res(200))).toBeNull();
  });

  it("returns null for a 4xx", () => {
    expect(redirectFailureMessage(res(404))).toBeNull();
  });

  it("reports an unfollowed redirect, including the target", () => {
    expect(redirectFailureMessage(res(302, "http://169.254.169.254/"))).toMatch(
      /302 redirect not followed \(to http:\/\/169\.254\.169\.254\/\)/,
    );
  });
});
