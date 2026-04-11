import path from "node:path";
import { mkdirSync } from "node:fs";

const UNSAFE_CHARS = /[/\\:*?"<>|\r\n\t]/g;

export function sanitizeFilename(name: string): string {
  return name
    .replace(UNSAFE_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 100);
}

export function dateStamp(startTimeMs: number): string {
  const d = new Date(startTimeMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function folderName(startTimeMs: number, filename: string, id: string): string {
  const safe = sanitizeFilename(filename) || "recording";
  const shortId = id.slice(0, 8);
  return `${dateStamp(startTimeMs)}_${safe}__${shortId}`;
}

export interface RecordingPaths {
  folder: string;
  audioPath: string;
  transcriptJsonPath: string;
  transcriptTxtPath: string;
  summaryMdPath: string;
  metadataPath: string;
}

export function recordingPaths(
  recordingsDir: string,
  folder: string,
): RecordingPaths {
  const dir = path.join(recordingsDir, folder);
  return {
    folder: dir,
    audioPath: path.join(dir, "audio.ogg"),
    transcriptJsonPath: path.join(dir, "transcript.json"),
    transcriptTxtPath: path.join(dir, "transcript.txt"),
    summaryMdPath: path.join(dir, "summary.md"),
    metadataPath: path.join(dir, "metadata.json"),
  };
}

export function ensureRecordingFolder(recordingsDir: string, folder: string): RecordingPaths {
  const p = recordingPaths(recordingsDir, folder);
  mkdirSync(p.folder, { recursive: true });
  return p;
}
