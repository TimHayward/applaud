import net from "node:net";

/**
 * Classification of an IP literal as "not safe to let a user-supplied URL
 * reach." Used by the SSRF guard (see `ssrf.ts`) before any outbound fetch.
 *
 * Covers loopback, RFC1918 private space, CGNAT, link-local (incl. the cloud
 * metadata address 169.254.169.254), IPv6 ULA/link-local, multicast, and the
 * reserved/documentation ranges — plus IPv4-mapped and 6to4/NAT64-embedded
 * IPv4, which are the usual ways a v4 target is smuggled through a v6 check.
 */

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

/** Expand any valid IPv6 literal (incl. `::ffff:1.2.3.4`) to its 16 bytes. */
export function ipv6ToBytes(ip: string): number[] | null {
  let s = ip;
  // Strip a zone index (`fe80::1%eth0`) — irrelevant to the range check.
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);

  // A trailing dotted-quad (`::ffff:192.168.0.1`) becomes two hex groups.
  const lastColon = s.lastIndexOf(":");
  const tail = lastColon === -1 ? "" : s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToBytes(tail);
    if (!v4) return null;
    const [q0 = 0, q1 = 0, q2 = 0, q3 = 0] = v4;
    const hi = ((q0 << 8) | q1).toString(16);
    const lo = ((q2 << 8) | q3).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tailGroups = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const groups: string[] =
    halves.length === 2
      ? [...head, ...Array<string>(8 - head.length - tailGroups.length).fill("0"), ...tailGroups]
      : head;
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function isPrivateIpv4(b: number[]): boolean {
  const [a = 0, c = 0, d = 0] = b;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && c >= 64 && c <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && c === 254) return true; // link-local (incl. 169.254.169.254)
  if (a === 172 && c >= 16 && c <= 31) return true; // RFC1918
  if (a === 192 && c === 0 && d === 0) return true; // IETF protocol assignments
  if (a === 192 && c === 0 && d === 2) return true; // TEST-NET-1
  if (a === 192 && c === 88 && d === 99) return true; // 6to4 relay anycast
  if (a === 192 && c === 168) return true; // RFC1918
  if (a === 198 && (c === 18 || c === 19)) return true; // benchmarking
  if (a === 198 && c === 51 && d === 100) return true; // TEST-NET-2
  if (a === 203 && c === 0 && d === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateIpv6(b: number[]): boolean {
  const allZero = b.every((x) => x === 0);
  if (allZero) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) — check the v4.
  const first10Zero = b.slice(0, 10).every((x) => x === 0);
  if (first10Zero && b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4(b.slice(12));
  if (first10Zero && b[10] === 0 && b[11] === 0) return isPrivateIpv4(b.slice(12));

  // 64:ff9b::/96 NAT64 — the low 32 bits are an embedded IPv4 address.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return isPrivateIpv4(b.slice(12));
  }
  // 2002::/16 6to4 — bytes 2-5 are the embedded IPv4 address.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4(b.slice(2, 6));

  const b0 = b[0] ?? 0;
  const b1 = b[1] ?? 0;
  if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b0 === 0xff) return true; // ff00::/8 multicast
  return false;
}

/**
 * True when `ip` is loopback, private, link-local, multicast, or otherwise not
 * a routable public address. Unparseable input is treated as private (fail
 * closed) — callers only pass literals that already came from `net.isIP` or
 * `dns.lookup`.
 */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const b = ipv4ToBytes(ip);
    return b ? isPrivateIpv4(b) : true;
  }
  if (family === 6) {
    const b = ipv6ToBytes(ip);
    return b ? isPrivateIpv6(b) : true;
  }
  return true;
}
