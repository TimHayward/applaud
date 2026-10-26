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
  // Plaud ids are time-ordered (`f_019f3c…`), so the tail is the distinctive part.
  const shortId = id.slice(-8);
  return `${dateStamp(startTimeMs)}_${safe}__${shortId}`;
}

/** Default audio filename — used when Plaud's `filetype` is absent or unrecognized. */
export const DEFAULT_AUDIO_FILENAME = "audio.ogg";

// Recognized audio containers, mapping a normalized `filetype` token (or the
// subtype of a mime string) to the on-disk extension we save the file under.
const AUDIO_EXTENSIONS: Record<string, string> = {
  ogg: "ogg",
  oga: "ogg",
  opus: "opus",
  mp3: "mp3",
  mpeg: "mp3",
  mpga: "mp3",
  m4a: "m4a",
  mp4: "m4a",
  aac: "m4a",
  wav: "wav",
  wave: "wav",
  "x-wav": "wav",
  flac: "flac",
  webm: "webm",
};

/**
 * Resolve the on-disk audio filename from a file type or extension (such as
 * the extension of Plaud's signed audio URL). Tolerant of bare extensions
 * ("mp3"), dotted (".mp3"), and mime types ("audio/mpeg"). Falls back to
 * `audio.ogg` for anything unrecognized.
 */
export function audioFilenameForFiletype(filetype?: string | null): string {
  if (!filetype) return DEFAULT_AUDIO_FILENAME;
  let token = filetype.toLowerCase().trim();
  if (token.includes("/")) token = token.split("/").pop() ?? token; // mime → subtype
  token = token.replace(/^\.+/, ""); // strip leading dots
  const ext = AUDIO_EXTENSIONS[token];
  return ext ? `audio.${ext}` : DEFAULT_AUDIO_FILENAME;
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
  audioFilename: string = DEFAULT_AUDIO_FILENAME,
): RecordingPaths {
  const dir = path.join(recordingsDir, folder);
  return {
    folder: dir,
    audioPath: path.join(dir, audioFilename),
    transcriptJsonPath: path.join(dir, "transcript.json"),
    transcriptTxtPath: path.join(dir, "transcript.txt"),
    summaryMdPath: path.join(dir, "summary.md"),
    metadataPath: path.join(dir, "metadata.json"),
  };
}

export function ensureRecordingFolder(
  recordingsDir: string,
  folder: string,
  audioFilename: string = DEFAULT_AUDIO_FILENAME,
): RecordingPaths {
  const p = recordingPaths(recordingsDir, folder, audioFilename);
  mkdirSync(p.folder, { recursive: true });
  return p;
}
