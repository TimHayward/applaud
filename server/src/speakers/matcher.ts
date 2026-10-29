import { cosine } from "./vectors.js";

/** The section 7 bands; editable in Settings. */
export interface MatchThresholds {
  /** Raw cosine for an automatic label. */
  autoThreshold: number;
  /** How far the best person must be ahead of the next-best for an automatic label. */
  autoMargin: number;
  /** Usable speech a label needs for an automatic label. */
  minSpeechMs: number;
  /** Raw cosine for a suggestion. */
  suggestThreshold: number;
}

export interface LabelToMatch {
  label: string;
  centroid: Float32Array;
  speechMs: number;
}

/** One person's voiceprints, from the active model. */
export interface LibraryPerson {
  speakerId: number;
  vectors: Float32Array[];
}

export interface Candidate {
  speakerId: number;
  score: number;
}

export interface MatchResult {
  label: string;
  status: "auto" | "suggested" | "unknown";
  /** The best person for `auto` and `suggested`; null for `unknown`. */
  speakerId: number | null;
  /** Best score, whatever the band. */
  confidence: number | null;
  /** Best score minus the next-best person's (the best score when only one person is known). */
  margin: number | null;
}

/** People ranked by a label's best score across each person's voiceprints (best of N, D11). */
export function rankCandidates(centroid: Float32Array, library: LibraryPerson[]): Candidate[] {
  const ranked: Candidate[] = [];
  for (const p of library) {
    let best = -Infinity;
    for (const v of p.vectors) best = Math.max(best, cosine(centroid, v));
    if (best > -Infinity) ranked.push({ speakerId: p.speakerId, score: best });
  }
  return ranked.sort((a, b) => b.score - a.score || a.speakerId - b.speakerId);
}

/**
 * Band each label against the library (section 7). People in `taken` already
 * have a confirmed label in this recording, and no two labels are given the
 * same person automatically (one-to-one): the weaker claims become suggestions,
 * so the user can merge or correct them.
 */
export function matchLabels(
  labels: LabelToMatch[],
  library: LibraryPerson[],
  t: MatchThresholds,
  taken: ReadonlySet<number> = new Set(),
): MatchResult[] {
  const results = labels.map((l): MatchResult => {
    const [best, next] = rankCandidates(l.centroid, library);
    if (!best) return { label: l.label, status: "unknown", speakerId: null, confidence: null, margin: null };
    const margin = best.score - (next?.score ?? 0);
    const auto = best.score >= t.autoThreshold && margin >= t.autoMargin && l.speechMs >= t.minSpeechMs;
    const status = auto ? "auto" : best.score >= t.suggestThreshold ? "suggested" : "unknown";
    return {
      label: l.label,
      status,
      speakerId: status === "unknown" ? null : best.speakerId,
      confidence: best.score,
      margin,
    };
  });

  const strongest = new Map<number, MatchResult>();
  for (const r of results) {
    if (r.status !== "auto" || r.speakerId === null) continue;
    const held = strongest.get(r.speakerId);
    if (!held || r.confidence! > held.confidence!) strongest.set(r.speakerId, r);
  }
  for (const r of results) {
    if (r.status !== "auto" || r.speakerId === null) continue;
    if (taken.has(r.speakerId) || strongest.get(r.speakerId) !== r) r.status = "suggested";
  }
  return results;
}
