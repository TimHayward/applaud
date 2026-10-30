import type { SpeakerSegment } from "./segments.js";

/** A stretch of one label's speech to play in the labelling panel. */
export interface Clip {
  segmentKey: string;
  startMs: number;
  endMs: number;
  text: string;
}

/** Clips this long are easiest to recognise a voice from. */
const IDEAL_MS = 8_000;
const USEFUL_MIN_MS = 3_000;
const USEFUL_MAX_MS = 12_000;
/** Spread clips across the recording so they don't all come from one exchange. */
const MIN_GAP_MS = 20_000;
const MAX_WORDS = 30;

/** Higher is better. Long segments are judged by the 12 s that would be played. */
function rank(s: SpeakerSegment): number {
  const len = Math.min(s.endMs - s.startMs, USEFUL_MAX_MS);
  const closeness = Math.max(0, 1 - Math.abs(len - IDEAL_MS) / IDEAL_MS);
  const words = Math.min(MAX_WORDS, s.text.split(/\s+/).filter(Boolean).length) / MAX_WORDS;
  const useful = len >= USEFUL_MIN_MS ? 1 : 0;
  return useful * 10 + closeness * 0.7 + words * 0.3;
}

/**
 * Up to `max` clips for one label (section 10, Phase 3): segments ranked by
 * length (best around 8 s, useful from 3 to 12 s) and word count, at least
 * 20 s apart, then filled from the rest of the ranking when the label speaks
 * too little for that. Long segments are cut to 12 s. Best clip first.
 */
export function selectClips(segments: SpeakerSegment[], max = 5): Clip[] {
  const ranked = [...segments].sort((a, b) => rank(b) - rank(a) || a.startMs - b.startMs);
  const picked: SpeakerSegment[] = [];
  for (const s of ranked) {
    if (picked.length >= max) break;
    if (picked.every((p) => Math.abs(p.startMs - s.startMs) >= MIN_GAP_MS)) picked.push(s);
  }
  for (const s of ranked) {
    if (picked.length >= max) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.map((s) => ({
    segmentKey: s.key,
    startMs: s.startMs,
    endMs: Math.min(s.endMs, s.startMs + USEFUL_MAX_MS),
    text: s.text,
  }));
}
