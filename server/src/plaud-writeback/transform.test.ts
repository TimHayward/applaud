import { describe, it, expect } from "vitest";
import { buildApplaudTranscript, type LabelAssignment } from "../speakers/outputs.js";
import { normaliseSegments } from "../speakers/segments.js";
import {
  desiredNames,
  pendingChanges,
  pendingCount,
  planRecording,
  rewriteSummary,
  rewriteTranscript,
  summaryRenames,
  type DesiredName,
} from "./transform.js";

// Synthetic documents shaped like Plaud's (Appendix A.8): never real transcripts.
const seg = (
  uid: string,
  label: string,
  speaker: string,
  start: number,
  content = `Line ${uid}.`,
) => ({
  segment_uid: uid,
  start_time: start,
  end_time: start + 1000,
  content,
  speaker,
  original_speaker: label,
});

const plaudTranscript = () => [
  seg("u1", "Speaker 1", "Speaker 1", 0),
  seg("u2", "Speaker 2", "Speaker 2", 1000),
  seg("u3", "Speaker 1", "Speaker 1", 2000),
  seg("u4", "Speaker 3", "Tim Hayward", 3000),
  seg("u5", "Speaker 2", "Speaker 2", 4000),
];

const NAMES = new Map([
  [1, "Ann Example"],
  [2, "Ben Example"],
  [3, "Tim Hayward"],
]);

function desiredFor(
  doc: ReturnType<typeof plaudTranscript>,
  labels: Record<string, LabelAssignment>,
  overrides: Record<string, number> = {},
): Map<string, DesiredName> {
  const segments = normaliseSegments(doc, 5000);
  const applaud = buildApplaudTranscript(
    segments,
    new Map(Object.entries(labels)),
    new Map(Object.entries(overrides)),
    NAMES,
  );
  return desiredNames(segments, applaud);
}

const confirmed = (speakerId: number): LabelAssignment => ({
  status: "confirmed",
  speakerId,
  confidence: null,
});

describe("desiredNames", () => {
  it("takes confirmed labels, the owner and per-segment corrections, not automatic matches", () => {
    const desired = desiredFor(
      plaudTranscript(),
      {
        "Speaker 1": { status: "auto", speakerId: 1, confidence: 0.9 },
        "Speaker 2": confirmed(2),
        "Speaker 3": confirmed(3),
      },
      { u3: 2 },
    );
    expect([...desired.keys()].sort()).toEqual(["u2", "u3", "u4", "u5"]);
    expect(desired.get("u3")).toMatchObject({
      label: "Speaker 1",
      expected: "Speaker 1",
      name: "Ben Example",
      override: true,
    });
    expect(pendingCount(desired)).toBe(3);
  });

  it("skips segments Plaud's documents can't address", () => {
    const doc = plaudTranscript().map((s) =>
      s.segment_uid === "u2" ? { ...s, segment_uid: undefined as unknown as string } : s,
    );
    const desired = desiredFor(doc, { "Speaker 2": confirmed(2) });
    expect([...desired.keys()]).toEqual(["u5"]);
  });
});

describe("pendingChanges", () => {
  it("groups whole-label renames and lists corrections one by one", () => {
    const desired = desiredFor(
      plaudTranscript(),
      { "Speaker 2": confirmed(2), "Speaker 3": confirmed(3) },
      { u1: 1 },
    );
    expect(pendingChanges(desired)).toEqual([
      { plaudLabel: "Speaker 2", from: "Speaker 2", to: "Ben Example", segments: 2, segment: null },
      {
        plaudLabel: "Speaker 1",
        from: "Speaker 1",
        to: "Ann Example",
        segments: 1,
        segment: { startMs: 0, text: "Line u1." },
      },
    ]);
  });
});

describe("rewriteTranscript", () => {
  const desired = () =>
    desiredFor(plaudTranscript(), { "Speaker 2": confirmed(2), "Speaker 3": confirmed(3) });

  it("changes only speaker, and keeps every other field and the order", () => {
    const out = rewriteTranscript(JSON.stringify(plaudTranscript()), desired());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.changed).toBe(2);
    const doc = JSON.parse(out.content!) as ReturnType<typeof plaudTranscript>;
    const expected = plaudTranscript().map((s) =>
      s.original_speaker === "Speaker 2" ? { ...s, speaker: "Ben Example" } : s,
    );
    expect(doc).toEqual(expected);
    expect(Object.keys(doc[0]!)).toEqual(Object.keys(plaudTranscript()[0]!));
  });

  it("returns no content when Plaud already has the names", () => {
    const named = plaudTranscript().map((s) =>
      s.original_speaker === "Speaker 2" ? { ...s, speaker: "Ben Example" } : s,
    );
    const out = rewriteTranscript(JSON.stringify(named), desired());
    expect(out).toMatchObject({ ok: true, content: null, changed: 0 });
  });

  it("refuses when Plaud renamed a segment since Applaud synced", () => {
    const edited = plaudTranscript().map((s) =>
      s.segment_uid === "u5" ? { ...s, speaker: "Someone Else" } : s,
    );
    expect(rewriteTranscript(JSON.stringify(edited), desired())).toMatchObject({ ok: false });
  });

  it("refuses when a segment's label changed", () => {
    const edited = plaudTranscript().map((s) =>
      s.segment_uid === "u2" ? { ...s, original_speaker: "Speaker 4" } : s,
    );
    expect(rewriteTranscript(JSON.stringify(edited), desired())).toMatchObject({ ok: false });
  });

  it("refuses when a named segment is missing", () => {
    const missing = plaudTranscript().filter((s) => s.segment_uid !== "u5");
    expect(rewriteTranscript(JSON.stringify(missing), desired())).toMatchObject({ ok: false });
  });

  it("refuses a document that isn't a list of segments", () => {
    expect(rewriteTranscript("{", desired())).toMatchObject({ ok: false });
    expect(rewriteTranscript(JSON.stringify({ a: 1 }), desired())).toMatchObject({ ok: false });
    expect(rewriteTranscript(JSON.stringify([{ segment_uid: "u2" }]), desired())).toMatchObject({
      ok: false,
    });
  });
});

describe("summary", () => {
  it("replaces whole words only", () => {
    const out = rewriteSummary(
      "Speaker 2 met Speaker 20. Speaker 2's plan; xSpeaker 2.",
      new Map([["Speaker 2", "Ben Example"]]),
    );
    expect(out).toEqual({
      content: "Ben Example met Speaker 20. Ben Example's plan; xSpeaker 2.",
      replacements: 2,
    });
  });

  it("renames a label only when all its segments now carry one name", () => {
    const labels = new Map([
      [
        "Speaker 1",
        { before: new Set(["Speaker 1"]), after: new Set(["Ann Example", "Speaker 1"]) },
      ],
      ["Speaker 2", { before: new Set(["Speaker 2"]), after: new Set(["Ben Example"]) }],
      ["Speaker 3", { before: new Set(["Tim Hayward"]), after: new Set(["Tim Hayward"]) }],
    ]);
    expect([...summaryRenames(labels)]).toEqual([
      ["Speaker 2", "Ben Example"],
      ["Speaker 3", "Tim Hayward"],
    ]);
  });

  it("still renames a label written by an earlier run (roll forward)", () => {
    const labels = new Map([
      ["Speaker 2", { before: new Set(["Ben Example"]), after: new Set(["Ben Example"]) }],
    ]);
    expect([...summaryRenames(labels)]).toEqual([["Speaker 2", "Ben Example"]]);
  });
});

describe("planRecording", () => {
  const desired = () =>
    desiredFor(plaudTranscript(), { "Speaker 2": confirmed(2), "Speaker 3": confirmed(3) });
  const docs = (transcript = plaudTranscript()) => [
    { kind: "transcript" as const, content: JSON.stringify(transcript) },
    {
      kind: "polished" as const,
      content: JSON.stringify(transcript.map((s) => ({ ...s, content: s.content.toUpperCase() }))),
    },
    { kind: "summary" as const, content: "## Notes\nSpeaker 2 agreed. Speaker 1 asked." },
  ];

  it("rewrites all three documents", () => {
    const plan = planRecording(desired(), docs());
    expect(plan.status).toBe("ready");
    if (plan.status === "stale") return;
    expect([...plan.documents.keys()]).toEqual(["transcript", "polished", "summary"]);
    expect(plan.documents.get("summary")).toBe("## Notes\nBen Example agreed. Speaker 1 asked.");
    expect(plan.changedSegments).toBe(2);
    expect(plan.summaryReplacements).toBe(1);
  });

  it("completes a run that stopped after the transcript", () => {
    const written = plaudTranscript().map((s) =>
      s.original_speaker === "Speaker 2" ? { ...s, speaker: "Ben Example" } : s,
    );
    const [transcript] = docs(written);
    const plan = planRecording(desired(), [transcript!, ...docs().slice(1)]);
    if (plan.status === "stale") throw new Error(plan.reason);
    expect([...plan.documents.keys()]).toEqual(["polished", "summary"]);
  });

  it("is stale without a transcript, or when any document refuses", () => {
    expect(planRecording(desired(), docs().slice(1))).toMatchObject({ status: "stale" });
    const [t, , s] = docs();
    const badPolished = { kind: "polished" as const, content: "[]" };
    expect(planRecording(desired(), [t!, badPolished, s!])).toMatchObject({ status: "stale" });
  });

  it("works without a polished transcript or summary", () => {
    const plan = planRecording(desired(), docs().slice(0, 1));
    expect(plan).toMatchObject({ status: "ready", summaryReplacements: 0 });
  });

  it("has nothing to do when Plaud already has the names", () => {
    const written = plaudTranscript().map((s) =>
      s.original_speaker === "Speaker 2" ? { ...s, speaker: "Ben Example" } : s,
    );
    const plan = planRecording(desired(), [
      { kind: "transcript", content: JSON.stringify(written) },
    ]);
    expect(plan.status).toBe("nothing");
  });
});
