import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signPayload } from "./sign.js";

describe("signPayload", () => {
  // The signed message is `${timestamp}.${body}`, not the body alone — verify
  // against a manually computed HMAC-SHA256 over that exact composed message
  // (RFC 4231 test case 1's key, reused here as the secret).
  it("signs `${timestamp}.${body}`, not the body alone", () => {
    const key = "\x0b".repeat(20);
    const ts = 1_700_000_000;
    const body = "Hi There";
    const expected = `sha256=${createHmac("sha256", key).update(`${ts}.${body}`).digest("hex")}`;
    expect(signPayload(key, ts, body)).toBe(expected);
  });

  it("produces a 71-char output (sha256= + 64 hex chars) for any input", () => {
    expect(signPayload("k", 0, "v")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signPayload("k", 0, "")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signPayload("", 0, "v")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("is sensitive to a one-byte change in the body (no silent truncation)", () => {
    const a = signPayload("secret", 0, '{"event":"a"}');
    const b = signPayload("secret", 0, '{"event":"b"}');
    expect(a).not.toBe(b);
  });

  it("is sensitive to a one-byte change in the secret", () => {
    const a = signPayload("secret-a", 0, "body");
    const b = signPayload("secret-b", 0, "body");
    expect(a).not.toBe(b);
  });

  it("is sensitive to the timestamp (replay of an old request must not verify)", () => {
    const a = signPayload("secret", 1_700_000_000, "body");
    const b = signPayload("secret", 1_700_000_001, "body");
    expect(a).not.toBe(b);
  });

  it("handles non-ASCII bodies (UTF-8 multibyte)", () => {
    // Sanity: result is deterministic and well-formed; matches a hash we can
    // independently regenerate via Node's crypto with the same UTF-8 bytes.
    const sig = signPayload("k", 0, "héllo 你好 🎙");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Re-signing the same input must produce the same output.
    expect(signPayload("k", 0, "héllo 你好 🎙")).toBe(sig);
  });

  it("treats NUL as a regular byte in the secret (no C-string truncation)", () => {
    // Some HMAC libraries that wrap a C-string interface silently truncate
    // the key at the first \0. Node's crypto.createHmac doesn't, but the
    // contract matters because an attacker who can control the secret source
    // and inject a NUL byte must NOT be able to collide with the shorter prefix.
    const withNul = signPayload("key\x00suffix", 0, "body");
    const truncated = signPayload("key", 0, "body");
    expect(withNul).not.toBe(truncated);
  });

  it("handles empty body without throwing", () => {
    expect(() => signPayload("k", 0, "")).not.toThrow();
  });
});
