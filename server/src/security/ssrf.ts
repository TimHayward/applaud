import { lookup } from "node:dns/promises";
import net from "node:net";
import { WEBHOOK_ALLOW_PRIVATE_TARGETS } from "../constants.js";
import { isPrivateAddress } from "./ip.js";

/**
 * Thrown when a webhook target URL is rejected before any connection is made.
 * The message is safe to show the user — it never echoes response content.
 */
export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validates a webhook target before we connect to it.
 *
 * Without this, `POST /api/config/test-webhook` is a read oracle: it fetches
 * an arbitrary caller-supplied URL and hands back the first 500 bytes of the
 * response (and persists them to `webhook_log`). That turns the server into a
 * probe for anything it can reach but the caller can't — `127.0.0.1` services,
 * LAN admin panels, and cloud metadata endpoints (169.254.169.254).
 *
 * Guarantees:
 *   - scheme is http(s) — no `file:`, `gopher:`, `data:` …
 *   - no embedded credentials (`http://user:pass@host`), which leak into logs
 *   - every DNS answer for the host is a public address
 *
 * Callers must also pass `redirect: "manual"` to `fetch`, or a public host can
 * simply 302 to an internal one and defeat all of the above (see
 * `assertNotRedirect`). DNS rebinding between this check and the connect is
 * still theoretically possible — Node gives us no connect-time hook — but it
 * requires an attacker-controlled resolver and a sub-second flip.
 *
 * Set `APPLAUD_WEBHOOK_ALLOW_PRIVATE=1` to allow private/loopback targets,
 * which self-hosters pointing Applaud at a LAN or same-machine automation
 * runner (n8n, Home Assistant, Node-RED) will need.
 */
export async function assertWebhookTargetAllowed(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedTargetError("not a valid URL");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedTargetError(`unsupported scheme "${url.protocol}" — use http or https`);
  }
  if (url.username || url.password) {
    throw new BlockedTargetError("URLs with embedded credentials are not allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new BlockedTargetError("URL has no host");

  if (WEBHOOK_ALLOW_PRIVATE_TARGETS) return url;

  const literal = net.isIP(host) !== 0;
  const addresses = literal ? [host] : await resolveAll(host);
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new BlockedTargetError(
        `refusing to connect to a private/loopback address (${addr}). ` +
          `Set APPLAUD_WEBHOOK_ALLOW_PRIVATE=1 to allow LAN and localhost webhook targets.`,
      );
    }
  }
  return url;
}

async function resolveAll(host: string): Promise<string[]> {
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (records.length === 0) throw new Error("no records");
    return records.map((r) => r.address);
  } catch {
    throw new BlockedTargetError(`could not resolve host "${host}"`);
  }
}

/**
 * With `redirect: "manual"` a 3xx comes back as an ordinary response instead
 * of being followed, so the SSRF check above can't be bypassed by redirecting
 * to an internal address. Deliveries treat that as a failed attempt: a webhook
 * receiver that redirects is misconfigured, and silently chasing the hop is
 * exactly the hole we're closing.
 */
export function redirectFailureMessage(res: Response): string | null {
  if (res.status < 300 || res.status >= 400) return null;
  const location = res.headers.get("location");
  return `HTTP ${res.status} redirect not followed${location ? ` (to ${location})` : ""}`;
}
