import type { EmbedWindow } from "./embedder.js";
import type { SpeakerSegment } from "./segments.js";

/** Segments shorter than this are not used. */
export const WINDOW_MIN_MS = 1_500;
/** Longer segments are cut to this. */
export const WINDOW_MAX_MS = 10_000;
/** About this much speech is embedded per label. */
export const LABEL_BUDGET_MS = 60_000;
/** Time slices the budget is spread across, so one stretch of a recording doesn't dominate. */
const SPREAD_BUCKETS = 6;

/**
 * Pick the windows to embed for one label (section 7, rule 1): segments of at
 * least 1.5 s, cut to at most 10 s, up to about 60 s of speech, spread across
 * the recording and preferring longer segments. Window ids are segment keys.
 */
export function selectWindows(segments: SpeakerSegment[]): EmbedWindow[] {
  const eligible = segments
    .filter((s) => s.endMs - s.startMs >= WINDOW_MIN_MS)
    .map((s) => ({ id: s.key, startMs: s.startMs, endMs: Math.min(s.endMs, s.startMs + WINDOW_MAX_MS) }));
  const total = eligible.reduce((n, w) => n + (w.endMs - w.startMs), 0);
  if (total <= LABEL_BUDGET_MS) return eligible.sort(byStart);

  const first = Math.min(...eligible.map((w) => w.startMs));
  const last = Math.max(...eligible.map((w) => w.startMs));
  const span = Math.max(1, last - first + 1);
  const buckets: EmbedWindow[][] = Array.from({ length: SPREAD_BUCKETS }, () => []);
  for (const w of eligible) {
    buckets[Math.min(SPREAD_BUCKETS - 1, Math.floor(((w.startMs - first) / span) * SPREAD_BUCKETS))]!.push(w);
  }
  for (const b of buckets) b.sort((x, y) => y.endMs - y.startMs - (x.endMs - x.startMs) || x.startMs - y.startMs);

  const picked: EmbedWindow[] = [];
  let used = 0;
  while (used < LABEL_BUDGET_MS) {
    let took = false;
    for (const b of buckets) {
      const w = b.shift();
      if (!w) continue;
      picked.push(w);
      used += w.endMs - w.startMs;
      took = true;
      if (used >= LABEL_BUDGET_MS) break;
    }
    if (!took) break;
  }
  return picked.sort(byStart);
}

function byStart(a: EmbedWindow, b: EmbedWindow): number {
  return a.startMs - b.startMs;
}
