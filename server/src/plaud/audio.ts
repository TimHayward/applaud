import { createWriteStream, renameSync, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { plaudJson } from "./client.js";
import { AUDIO_DOWNLOAD_TIMEOUT_MS } from "../constants.js";

interface TempUrlResponse {
  status: number;
  temp_url: string;
  msg?: string;
}

/**
 * Ask Plaud for a pre-signed S3 URL for the given recording's audio file.
 */
export async function getAudioUrl(id: string): Promise<string> {
  const res = await plaudJson<TempUrlResponse>(`/file/temp-url/${id}`);
  if (!res.temp_url) throw new Error(`no temp_url in response for ${id}`);
  return res.temp_url;
}

/**
 * Stream the audio file to disk. Returns the actual number of bytes written.
 *
 * The streamed byte count is verified against `Content-Length` (and, if given,
 * the expected `filesizeBytes` from Plaud metadata) before the temp file is
 * renamed into place, so a clean short-close from S3 can't publish a truncated
 * file and mark it done.
 */
export async function downloadAudio(
  id: string,
  destPath: string,
  expectedBytes?: number | null,
): Promise<number> {
  const url = await getAudioUrl(id);
  // Bound the whole streaming download so a stalled S3 connection can't hang
  // the poll forever.
  const res = await fetch(url, { signal: AbortSignal.timeout(AUDIO_DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`audio fetch ${id} → HTTP ${res.status}`);
  if (!res.body) throw new Error(`audio fetch ${id} → empty body`);

  const sizeHeader = res.headers.get("content-length");
  const contentLength = sizeHeader ? Number(sizeHeader) : null;

  // Stream to a temp file and rename on success, so a crash or aborted
  // fetch mid-stream never leaves a truncated file at destPath.
  const tmpPath = `${destPath}.tmp-${id}`;
  let bytesWritten = 0;
  try {
    const writer = createWriteStream(tmpPath);
    // Node's fetch returns a web ReadableStream; Readable.fromWeb bridges to a Node stream.
    await pipeline(Readable.fromWeb(res.body as never), writer);
    bytesWritten = writer.bytesWritten;

    // Reject a short read before publishing the file. A Content-Length mismatch
    // means the connection closed early; a filesizeBytes mismatch (only when no
    // Content-Length is available) catches the chunked-transfer case.
    if (contentLength != null && contentLength > 0 && bytesWritten !== contentLength) {
      throw new Error(
        `audio download ${id} truncated: wrote ${bytesWritten} of ${contentLength} bytes`,
      );
    }
    if (
      contentLength == null &&
      expectedBytes != null &&
      expectedBytes > 0 &&
      bytesWritten !== expectedBytes
    ) {
      throw new Error(
        `audio download ${id} size mismatch: wrote ${bytesWritten}, expected ${expectedBytes} bytes`,
      );
    }

    renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
  return bytesWritten;
}
