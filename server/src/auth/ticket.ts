import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { loadConfig } from "../config.js";

/**
 * Short-lived, path-scoped signed tickets: the credential for requests that
 * can't send an `Authorization` header — `<audio>`/`<img>`/download links,
 * `EventSource` streams, and the media URLs handed to webhook receivers.
 *
 * Unlike the old `?token=<lanToken>`, a ticket that leaks into a proxy log,
 * browser history, or a webhook receiver's storage is limited to read-only
 * GETs under its path prefix and expires on its own. Tickets are HMAC-signed
 * with a key derived from `lanToken`, so changing the LAN token revokes every
 * outstanding ticket. With no `lanToken` there is nothing to gate, and
 * `issueTicket` returns null.
 *
 * Format: `<base64url(JSON {p, e})>.<base64url(HMAC-SHA256)>`, where `p` is the
 * path prefix the ticket grants (`/` for the browser, `/media/<folder>/` for a
 * webhook delivery) and `e` the expiry in epoch seconds.
 */

interface TicketClaims {
  /** Granted path prefix, decoded (e.g. `/media/2026-04-11_Standup__abcdef01/`). */
  p: string;
  /** Expiry, epoch seconds. */
  e: number;
}

function signingKey(lanToken: string): Buffer {
  return createHmac("sha256", lanToken).update("applaud-ticket-v1").digest();
}

function mac(lanToken: string, payload: string): Buffer {
  return createHmac("sha256", signingKey(lanToken)).update(payload).digest();
}

/** Issue a ticket granting GETs under `scope` for `ttlMs`. Null when no LAN token is configured. */
export function issueTicket(scope: string, ttlMs: number, now = Date.now()): { ticket: string; expiresAt: number } | null {
  const lanToken = loadConfig().lanToken;
  if (!lanToken) return null;
  const e = Math.floor((now + ttlMs) / 1000);
  const payload = Buffer.from(JSON.stringify({ p: scope, e } satisfies TicketClaims)).toString("base64url");
  return { ticket: `${payload}.${mac(lanToken, payload).toString("base64url")}`, expiresAt: e * 1000 };
}

/**
 * True when `ticket` is authentic, unexpired, and grants `requestPath` (the
 * fully decoded request path). The path is normalized first and must not
 * contain `..` afterwards, so a folder-scoped ticket can't climb out.
 */
export function verifyTicket(ticket: string, requestPath: string, now = Date.now()): boolean {
  const lanToken = loadConfig().lanToken;
  if (!lanToken) return false;
  const dot = ticket.indexOf(".");
  if (dot <= 0) return false;
  const payload = ticket.slice(0, dot);
  const presented = Buffer.from(ticket.slice(dot + 1), "base64url");
  const expected = mac(lanToken, payload);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return false;

  let claims: TicketClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TicketClaims;
  } catch {
    return false;
  }
  if (typeof claims.p !== "string" || typeof claims.e !== "number") return false;
  if (claims.e * 1000 <= now) return false;

  const normalized = path.posix.normalize(requestPath);
  if (normalized.split("/").includes("..")) return false;
  return normalized.startsWith(claims.p);
}

/** Append `ticket` to a URL (path or absolute) as the `ticket` query param. */
export function withTicket(url: string, ticket: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
}
