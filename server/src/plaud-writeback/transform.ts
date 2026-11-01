/**
 * Pure logic for sending confirmed speaker names to Plaud
 * (docs/plans/plaud-write-back-extension.md, decisions W2 to W5).
 *
 * Applaud decides; the extension only carries the documents built here to
 * Plaud. Nothing in this module does I/O.
 */
import {
  isGenericSpeakerLabel,
  type PlaudDocumentKind,
  type PlaudWritebackChange,
} from "@applaud/shared";
import type { ApplaudSegment } from "../speakers/outputs.js";
import type { SpeakerSegment } from "../speakers/segments.js";

/** The name Applaud wants on one Plaud segment, and what it expects Plaud to hold now. */
export interface DesiredName {
  /** Plaud's `original_speaker`, which must still match. */
  label: string;
  /** Plaud's `speaker` when Applaud last synced; a different value means Plaud changed since. */
  expected: string;
  name: string;
  startMs: number;
  text: string;
  override: boolean;
}

/**
 * Names to send, by `segment_uid` (W2, W3): segments whose name is confirmed
 * (a confirmed label, a per-segment correction, or the Plaud owner) and that
 * Plaud's documents can address. `applaud` is `buildApplaudTranscript(segments, …)`,
 * index for index.
 */
export function desiredNames(
  segments: SpeakerSegment[],
  applaud: ApplaudSegment[],
): Map<string, DesiredName> {
  const out = new Map<string, DesiredName>();
  segments.forEach((s, i) => {
    const a = applaud[i];
    if (!s.uid || !a || a.segment_key !== s.key) return;
    if (a.label_status !== "confirmed" || a.speaker_id === null) return;
    out.set(s.uid, {
      label: s.label,
      expected: s.name,
      name: a.speaker,
      startMs: s.startMs,
      text: s.text,
      override: a.segment_override === true,
    });
  });
  return out;
}

const SNIPPET_MAX = 80;

/**
 * What a manual rename in Plaud would need (P3): one entry per label and name
 * for whole-label changes, and one per segment for per-segment corrections.
 * Only segments whose Plaud name differs from the name to send are counted.
 */
export function pendingChanges(desired: ReadonlyMap<string, DesiredName>): PlaudWritebackChange[] {
  const grouped = new Map<string, PlaudWritebackChange>();
  const single: PlaudWritebackChange[] = [];
  for (const d of desired.values()) {
    if (d.expected === d.name) continue;
    if (d.override) {
      single.push({
        plaudLabel: d.label,
        from: d.expected,
        to: d.name,
        segments: 1,
        segment: { startMs: d.startMs, text: snippet(d.text) },
      });
      continue;
    }
    const key = JSON.stringify([d.label, d.expected, d.name]);
    const g = grouped.get(key);
    if (g) g.segments += 1;
    else
      grouped.set(key, {
        plaudLabel: d.label,
        from: d.expected,
        to: d.name,
        segments: 1,
        segment: null,
      });
  }
  const byLabel = (a: PlaudWritebackChange, b: PlaudWritebackChange): number =>
    a.plaudLabel.localeCompare(b.plaudLabel, undefined, { numeric: true }) ||
    a.to.localeCompare(b.to);
  return [
    ...[...grouped.values()].sort(byLabel),
    ...single.sort((a, b) => (a.segment?.startMs ?? 0) - (b.segment?.startMs ?? 0)),
  ];
}

/** Segments Plaud still names differently from Applaud's confirmed name. */
export function pendingCount(desired: ReadonlyMap<string, DesiredName>): number {
  let n = 0;
  for (const d of desired.values()) if (d.expected !== d.name) n += 1;
  return n;
}

function snippet(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX - 1)}…` : t;
}

export type TranscriptRewrite =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** The document to write, or null when nothing in it changes. */
      content: string | null;
      changed: number;
      /** Each Plaud label's names before and after, for the summary (W4). */
      labels: Map<string, { before: Set<string>; after: Set<string> }>;
    };

/**
 * Apply the names to one of Plaud's transcript documents (the transcript or
 * the polished transcript), changing only `speaker`. Refuses, rather than
 * guessing, when the document is not in the expected shape or Plaud has
 * changed since Applaud last synced (P5, P6): a segment Applaud names that is
 * missing, has another label, or carries a name Applaud has not seen.
 */
export function rewriteTranscript(
  content: string,
  desired: ReadonlyMap<string, DesiredName>,
): TranscriptRewrite {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return { ok: false, reason: "the document is not JSON" };
  }
  if (!Array.isArray(doc)) return { ok: false, reason: "the document is not a list of segments" };

  const seen = new Set<string>();
  const labels = new Map<string, { before: Set<string>; after: Set<string> }>();
  let changed = 0;
  for (const item of doc as unknown[]) {
    if (!item || typeof item !== "object")
      return { ok: false, reason: "a segment is not an object" };
    const seg = item as Record<string, unknown>;
    if (typeof seg.speaker !== "string" || typeof seg.original_speaker !== "string") {
      return { ok: false, reason: "a segment has no speaker or original_speaker" };
    }
    const uid = typeof seg.segment_uid === "string" ? seg.segment_uid : null;
    const label = seg.original_speaker;
    const before = seg.speaker;
    let after = before;
    const d = uid !== null ? desired.get(uid) : undefined;
    if (uid !== null && d) {
      if (seen.has(uid)) return { ok: false, reason: `segment ${uid} appears twice` };
      seen.add(uid);
      if (label !== d.label) {
        return { ok: false, reason: `segment ${uid} now has label ${label}, not ${d.label}` };
      }
      if (before !== d.name) {
        if (before !== d.expected) {
          return {
            ok: false,
            reason: `segment ${uid} was renamed in Plaud since Applaud last synced`,
          };
        }
        seg.speaker = d.name;
        after = d.name;
        changed += 1;
      }
    }
    const l = labels.get(label) ?? { before: new Set<string>(), after: new Set<string>() };
    l.before.add(before);
    l.after.add(after);
    labels.set(label, l);
  }
  if (seen.size !== desired.size) {
    return {
      ok: false,
      reason: `${desired.size - seen.size} segment(s) Applaud names are missing from the document`,
    };
  }
  return { ok: true, content: changed > 0 ? JSON.stringify(doc) : null, changed, labels };
}

/**
 * Placeholders to replace in the summary (W4): for a label whose segments all
 * now carry one name, the label itself (`Speaker 2`) and any generic name its
 * segments had before. Basing this on the label as well as the change keeps a
 * re-run working after an earlier run wrote the transcript but not the summary
 * (W5). A placeholder that still names segments anywhere is left alone.
 */
export function summaryRenames(
  labels: ReadonlyMap<string, { before: Set<string>; after: Set<string> }>,
): Map<string, string> {
  const out = new Map<string, string>();
  const stillUsed = new Set<string>();
  for (const { after } of labels.values()) for (const n of after) stillUsed.add(n);
  for (const [label, { before, after }] of labels) {
    if (after.size !== 1) continue;
    const to = [...after][0]!;
    if (isGenericSpeakerLabel(to)) continue;
    for (const from of new Set([label, ...before])) {
      if (from === to || !isGenericSpeakerLabel(from) || stillUsed.has(from)) continue;
      out.set(from, to);
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word replacement, so `Speaker 2` never matches inside `Speaker 20` (W4). */
export function rewriteSummary(
  content: string,
  renames: ReadonlyMap<string, string>,
): { content: string; replacements: number } {
  let out = content;
  let replacements = 0;
  for (const [from, to] of renames) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(from)}(?![\\p{L}\\p{N}_])`, "gu");
    out = out.replace(re, () => {
      replacements += 1;
      return to;
    });
  }
  return { content: out, replacements };
}

export interface PlaudDocumentIn {
  kind: PlaudDocumentKind;
  content: string;
}

export type RecordingPlan =
  | { status: "stale"; reason: string }
  | {
      status: "ready" | "nothing";
      /** New content by kind, only for documents that change. */
      documents: Map<PlaudDocumentKind, string>;
      changedSegments: number;
      summaryReplacements: number;
    };

/**
 * Build the documents to write for one recording from Plaud's current ones
 * (W1). The transcript is required; the polished transcript and the summary
 * are rewritten when present. Any refusal makes the whole recording stale:
 * nothing is written until Applaud has synced again.
 */
export function planRecording(
  desired: ReadonlyMap<string, DesiredName>,
  docs: PlaudDocumentIn[],
): RecordingPlan {
  const transcript = docs.find((d) => d.kind === "transcript");
  if (!transcript) return { status: "stale", reason: "Plaud returned no transcript" };
  const main = rewriteTranscript(transcript.content, desired);
  if (!main.ok) return { status: "stale", reason: `transcript: ${main.reason}` };

  const documents = new Map<PlaudDocumentKind, string>();
  if (main.content !== null) documents.set("transcript", main.content);

  const polished = docs.find((d) => d.kind === "polished");
  if (polished) {
    const p = rewriteTranscript(polished.content, desired);
    if (!p.ok) return { status: "stale", reason: `polished transcript: ${p.reason}` };
    if (p.content !== null) documents.set("polished", p.content);
  }

  let summaryReplacements = 0;
  const summary = docs.find((d) => d.kind === "summary");
  if (summary) {
    const r = rewriteSummary(summary.content, summaryRenames(main.labels));
    summaryReplacements = r.replacements;
    if (r.replacements > 0) documents.set("summary", r.content);
  }

  return {
    status: documents.size > 0 ? "ready" : "nothing",
    documents,
    changedSegments: main.changed,
    summaryReplacements,
  };
}
