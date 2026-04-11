import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { plaudJson } from "./client.js";

interface TempUrlResponse {
  status: number;
  temp_url: string;
  msg?: string;
}

/**
 * Ask Plaud for a pre-signed S3 URL for the given recording's audio file.
 */
export async function getAudioUrl(id: string, opus = false): Promise<string> {
  const q = opus ? "?is_opus=1" : "";
  const res = await plaudJson<TempUrlResponse>(`/file/temp-url/${id}${q}`);
  if (!res.temp_url) throw new Error(`no temp_url in response for ${id}`);
  return res.temp_url;
}

/**
 * Stream the audio file to disk. Returns the number of bytes written.
 */
export async function downloadAudio(id: string, destPath: string): Promise<number> {
  const url = await getAudioUrl(id);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio fetch ${id} → HTTP ${res.status}`);
  if (!res.body) throw new Error(`audio fetch ${id} → empty body`);
  const writer = createWriteStream(destPath);
  // Node's fetch returns a web ReadableStream; Readable.fromWeb bridges to a Node stream.
  await pipeline(Readable.fromWeb(res.body as never), writer);
  const sizeHeader = res.headers.get("content-length");
  return sizeHeader ? Number(sizeHeader) : 0;
}

export function md5File(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("md5").update(buf).digest("hex");
}
