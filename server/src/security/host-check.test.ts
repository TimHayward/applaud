import { describe, it, expect } from "vitest";
import { hostnameFromHeader, isAllowedHost } from "./host-check.js";

describe("hostnameFromHeader", () => {
  it("strips the port", () => {
    expect(hostnameFromHeader("localhost:44471")).toBe("localhost");
  });

  it("unwraps a bracketed IPv6 host", () => {
    expect(hostnameFromHeader("[::1]:44471")).toBe("::1");
  });

  it("lowercases and trims", () => {
    expect(hostnameFromHeader("  Example.COM ")).toBe("example.com");
  });
});

describe("isAllowedHost", () => {
  it.each(["127.0.0.1:44471", "192.168.1.20:44471", "[::1]:44471", "localhost:44471", "localhost"])(
    "allows %s by default",
    (host) => {
      expect(isAllowedHost(host, [])).toBe(true);
    },
  );

  it.each(["applaud.local", "nas.lan", "box.home.arpa", "laptop.tail1234.ts.net"])(
    "allows the LAN/VPN name %s",
    (host) => {
      expect(isAllowedHost(host, [])).toBe(true);
    },
  );

  it("rejects an arbitrary public hostname (the DNS-rebinding case)", () => {
    expect(isAllowedHost("rebind.evil.example:44471", [])).toBe(false);
  });

  it("rejects a missing Host header", () => {
    expect(isAllowedHost(undefined, [])).toBe(false);
    expect(isAllowedHost("", [])).toBe(false);
  });

  it("allows an explicitly configured host", () => {
    expect(isAllowedHost("applaud.example.com", ["applaud.example.com"])).toBe(true);
  });

  it("allows a wildcard subdomain pattern, including the apex", () => {
    expect(isAllowedHost("a.example.com", ["*.example.com"])).toBe(true);
    expect(isAllowedHost("example.com", ["*.example.com"])).toBe(true);
    expect(isAllowedHost("example.com.evil.test", ["*.example.com"])).toBe(false);
  });

  it("allows everything when the allowlist is `*`", () => {
    expect(isAllowedHost("anything.example", ["*"])).toBe(true);
  });

  it("ignores empty entries in the allowlist", () => {
    expect(isAllowedHost("other.example", ["", "  "])).toBe(false);
  });
});
