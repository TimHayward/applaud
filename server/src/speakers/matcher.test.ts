import { describe, it, expect } from "vitest";
import { matchLabels, rankCandidates, type LibraryPerson, type MatchThresholds } from "./matcher.js";

const T: MatchThresholds = { autoThreshold: 0.75, autoMargin: 0.1, minSpeechMs: 20_000, suggestThreshold: 0.55 };

/** A unit vector at `score` cosine from the x axis, in the x/y plane (plus a z tilt to separate people). */
function at(score: number, z = 0): Float32Array {
  const y = Math.sqrt(Math.max(0, 1 - score * score - z * z));
  return new Float32Array([score, y, z]);
}

const X = new Float32Array([1, 0, 0]);
const label = (
  name: string,
  speechMs = 30_000,
  centroid: Float32Array = X,
): { label: string; centroid: Float32Array; speechMs: number } => ({
  label: name,
  centroid,
  speechMs,
});

describe("rankCandidates", () => {
  it("scores each person by their best voiceprint (best of N)", () => {
    const library: LibraryPerson[] = [
      { speakerId: 1, vectors: [at(0.3), at(0.9)] },
      { speakerId: 2, vectors: [at(0.6)] },
      { speakerId: 3, vectors: [] },
    ];
    const ranked = rankCandidates(X, library);
    expect(ranked.map((c) => c.speakerId)).toEqual([1, 2]);
    expect(ranked[0]!.score).toBeCloseTo(0.9);
  });
});

describe("matchLabels", () => {
  it("bands by score, margin and speech", () => {
    const library: LibraryPerson[] = [
      { speakerId: 1, vectors: [at(0.8)] },
      { speakerId: 2, vectors: [at(0.2, 0.5)] },
    ];
    const [r] = matchLabels([label("S1")], library, T);
    expect(r).toMatchObject({ status: "auto", speakerId: 1 });
    expect(r!.confidence).toBeCloseTo(0.8);
    expect(r!.margin).toBeCloseTo(0.6);

    expect(matchLabels([label("S1", 10_000)], library, T)[0]).toMatchObject({ status: "suggested", speakerId: 1 });
  });

  it("needs a margin over the next-best person for an automatic label", () => {
    const library: LibraryPerson[] = [
      { speakerId: 1, vectors: [at(0.8)] },
      { speakerId: 2, vectors: [at(0.75, 0.3)] },
    ];
    expect(matchLabels([label("S1")], library, T)[0]).toMatchObject({ status: "suggested", speakerId: 1 });
  });

  it("measures the margin against zero when only one person is known", () => {
    const [r] = matchLabels([label("S1")], [{ speakerId: 1, vectors: [at(0.76)] }], T);
    expect(r).toMatchObject({ status: "auto" });
    expect(r!.margin).toBeCloseTo(0.76);
  });

  it("suggests between the thresholds and leaves the rest unknown", () => {
    expect(matchLabels([label("S1")], [{ speakerId: 1, vectors: [at(0.6)] }], T)[0]).toMatchObject({
      status: "suggested",
      speakerId: 1,
    });
    const [r] = matchLabels([label("S1")], [{ speakerId: 1, vectors: [at(0.5)] }], T);
    expect(r).toMatchObject({ status: "unknown", speakerId: null });
    expect(r!.confidence).toBeCloseTo(0.5);
  });

  it("is unknown with an empty library", () => {
    expect(matchLabels([label("S1")], [], T)).toEqual([
      { label: "S1", status: "unknown", speakerId: null, confidence: null, margin: null },
    ]);
  });

  it("gives a person to one label only; the weaker claim becomes a suggestion", () => {
    const library: LibraryPerson[] = [{ speakerId: 1, vectors: [X] }];
    const out = matchLabels([label("S1", 30_000, at(0.8)), label("S2", 30_000, at(0.9, 0.1))], library, T);
    expect(out.map((r) => [r.label, r.status, r.speakerId])).toEqual([
      ["S1", "suggested", 1],
      ["S2", "auto", 1],
    ]);
  });

  it("never gives automatically a person already confirmed in the recording", () => {
    const library: LibraryPerson[] = [{ speakerId: 1, vectors: [at(0.9)] }];
    expect(matchLabels([label("S1")], library, T, new Set([1]))[0]).toMatchObject({ status: "suggested", speakerId: 1 });
  });
});
