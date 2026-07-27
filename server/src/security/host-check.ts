import type { NextFunction, Request, Response } from "express";
import net from "node:net";
import { loadConfig } from "../config.js";
import { EXTRA_ALLOWED_HOSTS } from "../constants.js";

/**
 * Host-header allowlist — the standard defense against DNS rebinding.
 *
 * On a default localhost install there is no token to steal, so a page the
 * user merely visits can point `evil.example` at `127.0.0.1`, wait for the DNS
 * TTL to expire, and then talk to the API *same-origin* (no CORS involved, so
 * neither a CORS policy nor a CSRF token would help). Rebinding always arrives
 * with the attacker's own DNS name in `Host`; a request that legitimately
 * reaches this server carries an IP literal or a name the operator chose.
 *
 * Allowed by default: any IP literal, `localhost`, LAN/mDNS/VPN name suffixes,
 * and whatever `bind.host` is set to. Anything else needs
 * `APPLAUD_ALLOWED_HOSTS` (comma-separated; `*` disables the check, and a
 * leading `*.` matches subdomains) — needed when fronting Applaud with a
 * reverse proxy on a real domain.
 */

/** Suffixes that can't be pointed at this machine from the public internet. */
const LAN_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa", ".localhost", ".ts.net"];

/** Splits `host:port` / `[::1]:port` into a bare hostname, lowercased. */
export function hostnameFromHeader(header: string): string {
  const trimmed = header.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? "" : trimmed.slice(1, end);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

export function isAllowedHost(header: string | undefined, allowed: readonly string[]): boolean {
  if (!header) return false;
  const host = hostnameFromHeader(header);
  if (!host) return false;
  if (net.isIP(host) !== 0) return true;
  if (host === "localhost") return true;
  if (LAN_SUFFIXES.some((s) => host.endsWith(s))) return true;
  for (const entry of allowed) {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (host === pattern.slice(2) || host.endsWith(suffix)) return true;
      continue;
    }
    if (host === pattern) return true;
  }
  return false;
}

export function requireAllowedHost(req: Request, res: Response, next: NextFunction): void {
  const allowed = [...EXTRA_ALLOWED_HOSTS, loadConfig().bind.host];
  if (isAllowedHost(req.headers.host, allowed)) {
    next();
    return;
  }
  res.status(403).json({
    error:
      "host not allowed — set APPLAUD_ALLOWED_HOSTS to the hostname you serve Applaud on " +
      "(comma-separated; `*` disables this check)",
  });
}
