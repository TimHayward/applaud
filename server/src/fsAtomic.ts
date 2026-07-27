import { writeFileSync, renameSync, unlinkSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Marker embedded in every atomic temp filename, used by the startup sweep. */
const TEMP_MARKER = ".tmp-";

interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
}

/**
 * Write a file via temp-file-then-rename so a crash or process kill mid-write
 * never leaves a truncated/corrupt file at destPath — readers only ever see
 * the old complete file or the new complete file, never a partial one.
 */
export function writeFileAtomic(
  destPath: string,
  data: string | NodeJS.ArrayBufferView,
  opts?: BufferEncoding | AtomicWriteOptions,
): void {
  const encoding = typeof opts === "string" ? opts : opts?.encoding;
  const mode = typeof opts === "object" ? opts.mode : undefined;
  const tmpPath = `${destPath}${TEMP_MARKER}${randomBytes(6).toString("hex")}`;
  const writeOpts: { encoding?: BufferEncoding; mode?: number } = {};
  if (encoding) writeOpts.encoding = encoding;
  // Set the restrictive mode on the temp file itself so a secret is never
  // briefly world-readable between write and rename.
  if (mode !== undefined) writeOpts.mode = mode;
  writeFileSync(tmpPath, data, writeOpts);
  try {
    renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/**
 * Remove orphaned atomic temp files left behind when a process died between
 * writeFileSync and renameSync. Both writeFileAtomic (`.tmp-<hex>`) and the
 * audio downloader (`.tmp-<id>`) share the `.tmp-` marker. Recurses so temp
 * files inside per-recording folders are swept too. Best-effort: any error on
 * a single entry is logged by the caller's intent (silently skipped here).
 */
export function sweepOrphanedTempFiles(rootDir: string): number {
  let removed = 0;
  const walk = (dirAbs: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dirAbs);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = path.join(dirAbs, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile() && name.includes(TEMP_MARKER)) {
        try {
          unlinkSync(abs);
          removed += 1;
        } catch {
          /* ignore — another process may own it */
        }
      }
    }
  };
  walk(rootDir);
  return removed;
}
