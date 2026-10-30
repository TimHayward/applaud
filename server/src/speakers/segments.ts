/**
 * Plaud transcript segments, normalised for speaker analysis. `transcript.json`
 * is saved exactly as Plaud returned it, and recordings written by older API
 * versions may differ, so nothing here assumes a field is present.
 */
export interface SpeakerSegment {
  /** `segment_uid`, or `t<startMs>` for a segment without one. */
  key: string;
  /** Plaud's `original_speaker`: the diarisation label, unchanged by renames. `UU` when missing. */
  label: string;
  /** Plaud's `speaker`: reflects renames in the Plaud app (including the owner tag). */
  name: string;
  startMs: number;
  endMs: number;
  text: string;
}

/** Label given to segments with no speaker at all; generic, so never analysed. */
export const MISSING_SPEAKER_LABEL = "UU";

interface RawTimes {
  item: Record<string, unknown>;
  start: number;
  end: number;
}

/**
 * Normalise a parsed `transcript.json` (an array, or an object of segments):
 * timings in milliseconds, a stable key per segment, a label for every
 * segment. Segments whose end is not after their start are dropped.
 *
 * @param durationMs the recording's duration, used to tell seconds from
 *   milliseconds; without it, fractional timings are taken as seconds.
 */
export function normaliseSegments(raw: unknown, durationMs?: number | null): SpeakerSegment[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  const timed: RawTimes[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const start = Number(rec.start_time);
    const end = Number(rec.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) continue;
    timed.push({ item: rec, start, end });
  }

  const scale = timeScale(timed, durationMs);
  const seen = new Set<string>();
  const out: SpeakerSegment[] = [];
  for (const { item, start, end } of timed) {
    const startMs = Math.round(start * scale);
    const endMs = Math.round(end * scale);
    if (endMs <= startMs) continue;
    const uid = typeof item.segment_uid === "string" ? item.segment_uid.trim() : "";
    let key = uid || `t${startMs}`;
    // Keys must be unique within a recording; Plaud's are, but don't rely on it.
    for (let n = 2; seen.has(key); n++) key = `${uid || `t${startMs}`}#${n}`;
    seen.add(key);
    const original = str(item.original_speaker);
    const name = str(item.speaker);
    out.push({
      key,
      label: original || name || MISSING_SPEAKER_LABEL,
      name: name || original,
      startMs,
      endMs,
      text: str(item.content),
    });
  }
  return out;
}

/** 1 when timings are milliseconds, 1000 when they are seconds. */
function timeScale(timed: RawTimes[], durationMs?: number | null): number {
  let maxEnd = 0;
  let fractional = false;
  for (const t of timed) {
    if (t.end > maxEnd) maxEnd = t.end;
    if (!Number.isInteger(t.start) || !Number.isInteger(t.end)) fractional = true;
  }
  if (durationMs && durationMs > 0 && maxEnd > 0) {
    // The last segment ends near the recording's end: ~durationMs in
    // milliseconds, ~durationMs / 1000 in seconds. Pick the closer reading.
    const asMs = Math.abs(Math.log10(maxEnd / durationMs));
    const asSeconds = Math.abs(Math.log10((maxEnd * 1000) / durationMs));
    return asSeconds < asMs ? 1000 : 1;
  }
  return fractional ? 1000 : 1;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
