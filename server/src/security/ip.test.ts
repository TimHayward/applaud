import { describe, it, expect } from "vitest";
import { isPrivateAddress, ipv6ToBytes } from "./ip.js";

describe("isPrivateAddress (IPv4)", () => {
  it.each([
    "127.0.0.1",
    "127.5.5.5",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1", // multicast
    "255.255.255.255",
  ])("treats %s as private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.167.1.1", "13.107.42.14"])(
    "treats %s as public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe("isPrivateAddress (IPv6)", () => {
  it.each([
    "::1",
    "::",
    "fd00::1", // unique local
    "fc00::1",
    "fe80::1", // link-local
    "ff02::1", // multicast
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:192.168.0.5",
    "64:ff9b::10.0.0.1", // NAT64-embedded private v4
    "2002:a00:1::", // 6to4-embedded 10.0.0.1
  ])("treats %s as private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"])(
    "treats %s as public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it("fails closed on unparseable input", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("ipv6ToBytes", () => {
  it("expands a compressed address", () => {
    expect(ipv6ToBytes("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("expands an IPv4-mapped address", () => {
    expect(ipv6ToBytes("::ffff:192.168.0.1")?.slice(10)).toEqual([0xff, 0xff, 192, 168, 0, 1]);
  });

  it("strips a zone index", () => {
    expect(ipv6ToBytes("fe80::1%eth0")?.[0]).toBe(0xfe);
  });

  it("returns null for a malformed address", () => {
    expect(ipv6ToBytes("1:2:3")).toBeNull();
  });
});
