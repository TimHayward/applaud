import { Router } from "express";
import { createReadStream, existsSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { MEDIA_CSP } from "../security/headers.js";

export const mediaRouter = Router();

const CONTENT_TYPES: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Extensions a browser will happily execute as script in the app's own origin
 * if it renders them inline. Recording folders are user-writable and their
 * contents are auto-discovered (surfaced as `/media/...` links and in webhook
 * payloads), so an `.svg` dropped in one would otherwise be stored XSS against
 * the token-bearing origin. These are always served as an opaque download.
 */
const ACTIVE_EXTENSIONS = new Set([
  ".svg",
  ".svgz",
  ".html",
  ".htm",
  ".xhtml",
  ".xml",
  ".xsl",
  ".xslt",
  ".mhtml",
  ".pdf",
]);

/** Types safe to render inline: audio the player streams, raster thumbnails. */
const INLINE_TYPES = new Set([
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/flac",
  "audio/webm",
  "image/jpeg",
  "image/png",
]);

/**
 * Decides `Content-Type` + `Content-Disposition` for a served file.
 * Anything not on the inline allowlist is handed back as an attachment so a
 * browser never treats it as a document in this origin — belt and braces with
 * `nosniff` and the sandboxed `MEDIA_CSP` set on every media response.
 */
export function contentDisposition(
  ext: string,
  filename: string,
): { type: string; disposition: string | null } {
  const known = CONTENT_TYPES[ext];
  if (known && INLINE_TYPES.has(known.split(";")[0] ?? known) && !ACTIVE_EXTENSIONS.has(ext)) {
    return { type: known, disposition: null };
  }
  const type = ACTIVE_EXTENSIONS.has(ext) ? "application/octet-stream" : (known ?? "application/octet-stream");
  // RFC 5987 form as well, so non-ASCII filenames survive.
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return {
    type,
    disposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  };
}

/**
 * Parse a single-range `Range` header against a known file size.
 * Returns the inclusive `{ start, end }`, `"unsatisfiable"` for a 416, or
 * `null` if the header isn't a form we handle (caller serves the full file).
 * Handles the suffix form `bytes=-N` (the LAST N bytes) correctly.
 */
export function computeRange(
  rangeHeader: string,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!/^bytes=/.test(rangeHeader)) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return null;

  let start: number;
  let end: number;
  if (match[1] === "" && match[2] !== "") {
    // Suffix range `bytes=-N` — the LAST N bytes, not the first N.
    const suffixLen = Number(match[2]);
    if (suffixLen === 0) return "unsatisfiable";
    start = Math.max(0, size - suffixLen);
    end = size - 1;
  } else if (match[1] === "" && match[2] === "") {
    // `bytes=-` with no numbers on either side — not a range we handle.
    return null;
  } else {
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (start >= size || end >= size || start > end) return "unsatisfiable";
  return { start, end };
}

export function resolveSafe(base: string, rel: string): string | null {
  // Normalize out any traversal attempts before joining.
  const decoded = decodeURIComponent(rel);
  if (decoded.includes("\0")) return null;
  const joined = path.join(base, decoded);
  const normalized = path.normalize(joined);
  let resolvedBase: string;
  let resolvedTarget: string;
  try {
    resolvedBase = realpathSync(base);
    resolvedTarget = existsSync(normalized) ? realpathSync(normalized) : normalized;
  } catch {
    return null;
  }
  // Ensure the resolved target stays inside the recordings dir.
  const rel2 = path.relative(resolvedBase, resolvedTarget);
  if (rel2.startsWith("..") || path.isAbsolute(rel2)) return null;
  return resolvedTarget;
}

mediaRouter.get(/^\/(.*)$/, (req, res) => {
  const cfg = loadConfig();
  if (!cfg.recordingsDir) {
    res.status(503).send("recordings dir not configured");
    return;
  }
  const rel = (req.params as unknown as string[])[0] ?? "";
  if (!rel) {
    res.status(404).send("not found");
    return;
  }
  const abs = resolveSafe(cfg.recordingsDir, rel);
  if (!abs || !existsSync(abs)) {
    res.status(404).send("not found");
    return;
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    res.status(404).send("not found");
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const { type, disposition } = contentDisposition(ext, path.basename(abs));
  res.setHeader("Content-Type", type);
  if (disposition) res.setHeader("Content-Disposition", disposition);
  // Overrides the app-wide CSP set in index.ts: media is data, not a document.
  res.setHeader("Content-Security-Policy", MEDIA_CSP);

  // Range support for audio seeking
  const range = req.headers.range;
  if (range) {
    const parsed = computeRange(range, st.size);
    if (parsed === "unsatisfiable") {
      res.status(416).setHeader("Content-Range", `bytes */${st.size}`).end();
      return;
    }
    if (parsed) {
      const { start, end } = parsed;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(abs, { start, end }).pipe(res);
      return;
    }
  }

  res.setHeader("Content-Length", String(st.size));
  res.setHeader("Accept-Ranges", "bytes");
  createReadStream(abs).pipe(res);
});
