import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Response hardening for the app origin.
 *
 * `nosniff` is the load-bearing one: without it a served file whose extension
 * we don't recognise (or that we deliberately serve as octet-stream) can still
 * be sniffed into HTML and executed. The CSP then bounds what the SPA — and
 * anything injected into it — is allowed to load or connect to.
 *
 * `Referrer-Policy: no-referrer` also keeps the `?token=` media credential out
 * of the `Referer` header on any outbound navigation (see `auth/lan-token.ts`).
 */

/** Fonts are loaded from Google Fonts by `web/index.html`. */
const FONT_CSS_ORIGIN = "https://fonts.googleapis.com";
const FONT_FILE_ORIGIN = "https://fonts.gstatic.com";

/**
 * CSP for `/media` responses. `sandbox` (with no `allow-*`) drops the response
 * into an opaque origin with scripting disabled, so an `.svg`/`.html` file
 * sitting in a recording folder can't run script against the token-bearing app
 * origin even if a browser is talked into rendering it inline.
 */
export const MEDIA_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

/**
 * Builds the app CSP, hashing any inline `<script>` in the built index.html
 * (currently the anti-flash theme bootstrap) so it stays allowed without
 * `'unsafe-inline'` on script-src. `style-src` does need `'unsafe-inline'`:
 * React writes `style` attributes, and Tailwind/Google Fonts inject styles.
 */
export function buildAppCsp(indexHtml = ""): string {
  const hashes = inlineScriptHashes(indexHtml);
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.map((h) => ` '${h}'`).join("")}`,
    `style-src 'self' 'unsafe-inline' ${FONT_CSS_ORIGIN}`,
    `font-src 'self' data: ${FONT_FILE_ORIGIN}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = m[1] ?? "";
    if (!body.trim()) continue;
    hashes.push(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
  }
  return hashes;
}

export function securityHeaders(appCsp: string) {
  return function applySecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", appCsp);
    next();
  };
}
