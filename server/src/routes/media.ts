import { Router } from "express";
import { createReadStream, existsSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";

export const mediaRouter = Router();

const CONTENT_TYPES: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function resolveSafe(base: string, rel: string): string | null {
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
  const ctype = CONTENT_TYPES[ext] ?? "application/octet-stream";
  res.setHeader("Content-Type", ctype);

  // Range support for audio seeking
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : st.size - 1;
      if (start >= st.size || end >= st.size || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${st.size}`).end();
        return;
      }
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
