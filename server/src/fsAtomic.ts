import { writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * Write a file via temp-file-then-rename so a crash or process kill mid-write
 * never leaves a truncated/corrupt file at destPath — readers only ever see
 * the old complete file or the new complete file, never a partial one.
 */
export function writeFileAtomic(
  destPath: string,
  data: string | NodeJS.ArrayBufferView,
  encoding?: BufferEncoding,
): void {
  const tmpPath = `${destPath}.tmp-${randomBytes(6).toString("hex")}`;
  if (typeof data === "string" && encoding) {
    writeFileSync(tmpPath, data, encoding);
  } else {
    writeFileSync(tmpPath, data);
  }
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
