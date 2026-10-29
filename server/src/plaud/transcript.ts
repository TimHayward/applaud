import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface TranscriptSegment {
  /** Plaud's stable id for the segment; present on every segment seen so far. */
  segment_uid?: string;
  start_time: number;
  end_time: number;
  content: string;
  speaker: string;
  original_speaker: string;
}

export function flattenTranscript(segments: TranscriptSegment[] | null): string {
  if (!segments || segments.length === 0) return "";
  const lines: string[] = [];
  for (const s of segments) {
    const speaker = s.speaker || s.original_speaker || "Speaker";
    const ts = formatTimestamp(s.start_time);
    lines.push(`[${ts}] ${speaker}: ${s.content}`);
  }
  return lines.join("\n\n");
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Plaud returns summary payloads in several shapes across its endpoints and
// across recordings of different ages. Known shapes:
//   - Raw markdown string
//   - JSON object / JSON-encoded string with one of:
//       { markdown: "..." }                    (top-level markdown)
//       { ai_content: "...", header, ... }    (S3 auto_sum_note blobs)
//       { content: "..." }                     (legacy string form)
//       { content: { markdown: "..." } }       (legacy nested form)
// Returns the markdown string, or null if nothing usable was found.
export function extractMarkdownFromSummaryPayload(input: unknown): string | null {
  let obj: unknown = input;
  if (typeof obj === "string") {
    const s = obj.trim();
    if (s.length === 0) return null;
    // Try to parse as JSON; if it fails the raw string IS the markdown.
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        obj = JSON.parse(s);
      } catch {
        return s;
      }
    } else {
      return s;
    }
  }

  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;

  const aiContent = rec.ai_content;
  if (typeof aiContent === "string" && aiContent.trim().length > 0) return aiContent;

  const topMd = rec.markdown;
  if (typeof topMd === "string" && topMd.trim().length > 0) return topMd;

  const content = rec.content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : null;
  }
  if (content && typeof content === "object") {
    const md = (content as Record<string, unknown>).markdown;
    if (typeof md === "string" && md.trim().length > 0) return md;
  }
  return null;
}

/** If `summary.md` is JSON-wrapped or outline-only, rewrite as markdown. Returns whether a write occurred. */
export function repairSummaryMarkdownFile(absPath: string): boolean {
  if (!existsSync(absPath)) return false;
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return false;
  }
  const fixed = extractMarkdownFromSummaryPayload(raw);
  if (fixed && fixed.trim().length > 0 && fixed !== raw) {
    writeFileSync(absPath, fixed);
    return true;
  }
  return false;
}
