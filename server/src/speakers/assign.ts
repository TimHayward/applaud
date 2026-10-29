import { getDb } from "../db.js";
import { addVoiceprint, removeLabelVoiceprints, type AddOutcome } from "./library.js";
import { matchLabels, rankCandidates, type Candidate, type LibraryPerson, type MatchThresholds } from "./matcher.js";
import { resolvePerson, type PersonRef } from "./people.js";
import { fromBlob } from "./vectors.js";

/** Voiceprints from `modelId`, grouped by person. Only the active model's vectors are comparable. */
export function loadLibrary(modelId: string): LibraryPerson[] {
  const rows = getDb()
    .prepare("SELECT speaker_id, vector FROM speaker_embeddings WHERE model_id = ? ORDER BY speaker_id")
    .all(modelId) as { speaker_id: number; vector: Buffer }[];
  const byPerson = new Map<number, Float32Array[]>();
  for (const r of rows) {
    const list = byPerson.get(r.speaker_id) ?? [];
    list.push(fromBlob(r.vector));
    byPerson.set(r.speaker_id, list);
  }
  return [...byPerson].map(([speakerId, vectors]) => ({ speakerId, vectors }));
}

interface LabelRow {
  plaud_label: string;
  status: string;
  speaker_id: number | null;
  assigned_by: string | null;
  confidence: number | null;
  margin: number | null;
  speech_ms: number | null;
  centroid: Buffer | null;
  model_id: string | null;
}

/** Labels the matcher may (re)assign: not decided by the user or by Plaud's owner tag. */
const isMatchable = (r: LabelRow): boolean =>
  (r.assigned_by === null || r.assigned_by === "matcher") && ["unknown", "suggested", "auto"].includes(r.status);

function labelRows(recordingId: string): LabelRow[] {
  return getDb()
    .prepare(
      `SELECT plaud_label, status, speaker_id, assigned_by, confidence, margin, speech_ms, centroid, model_id
       FROM recording_speakers WHERE recording_id = ? ORDER BY plaud_label`,
    )
    .all(recordingId) as LabelRow[];
}

/**
 * Match one recording's undecided labels against the library and store the
 * result. Returns whether any label changed. Matching never adds voiceprints (D6).
 */
export function matchRecording(
  recordingId: string,
  library: LibraryPerson[],
  modelId: string | null,
  t: MatchThresholds,
  now = Date.now(),
): boolean {
  const rows = labelRows(recordingId);
  const taken = new Set(rows.filter((r) => r.status === "confirmed" && r.speaker_id !== null).map((r) => r.speaker_id!));
  const open = rows.filter(isMatchable);
  const comparable = open.filter((r) => r.centroid && modelId && r.model_id === modelId);
  const matched = new Map(
    matchLabels(
      comparable.map((r) => ({ label: r.plaud_label, centroid: fromBlob(r.centroid!), speechMs: r.speech_ms ?? 0 })),
      library,
      t,
      taken,
    ).map((m) => [m.label, m]),
  );

  const update = getDb().prepare(
    `UPDATE recording_speakers SET status = ?, speaker_id = ?, assigned_by = ?, confidence = ?, margin = ?, updated_at = ?
     WHERE recording_id = ? AND plaud_label = ?`,
  );
  let changed = false;
  for (const r of open) {
    const m = matched.get(r.plaud_label);
    const next = {
      status: m?.status ?? "unknown",
      speakerId: m?.speakerId ?? null,
      confidence: m?.confidence ?? null,
      margin: m?.margin ?? null,
    };
    const assignedBy = next.status === "unknown" ? null : "matcher";
    if (
      r.status === next.status &&
      r.speaker_id === next.speakerId &&
      r.assigned_by === assignedBy &&
      sameScore(r.confidence, next.confidence) &&
      sameScore(r.margin, next.margin)
    ) {
      continue;
    }
    update.run(next.status, next.speakerId, assignedBy, next.confidence, next.margin, now, recordingId, r.plaud_label);
    changed = true;
  }
  return changed;
}

const sameScore = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) < 1e-6;

/** Re-match every analysed recording (the library or the thresholds changed). Returns the recordings that changed. */
export function rematchAll(modelId: string | null, t: MatchThresholds, now = Date.now()): string[] {
  const d = getDb();
  const library = modelId ? loadLibrary(modelId) : [];
  const ids = (
    d.prepare("SELECT DISTINCT recording_id FROM recording_speakers ORDER BY recording_id").all() as {
      recording_id: string;
    }[]
  ).map((r) => r.recording_id);
  return d.transaction(() => ids.filter((id) => matchRecording(id, library, modelId, t, now)))();
}

/** The best people for a label, for the labelling UI. */
export function labelCandidates(recordingId: string, plaudLabel: string, modelId: string | null, limit = 3): Candidate[] {
  if (!modelId) return [];
  const row = getDb()
    .prepare("SELECT centroid, model_id FROM recording_speakers WHERE recording_id = ? AND plaud_label = ?")
    .get(recordingId, plaudLabel) as { centroid: Buffer | null; model_id: string | null } | undefined;
  if (!row?.centroid || row.model_id !== modelId) return [];
  return rankCandidates(fromBlob(row.centroid), loadLibrary(modelId)).slice(0, limit);
}

export type LabelAction = { status: "confirmed"; person: PersonRef } | { status: "ignored" } | { status: "unknown" };

export type LabelChange =
  | { ok: true; speakerId: number | null; voiceprint: AddOutcome | "none" }
  | { ok: false; code: 404 | 400; error: string };

/**
 * The user decides a label: confirm it as a person (their voiceprint is added,
 * D6), ignore it, or hand it back to the matcher (`unknown`). Voiceprints made
 * from this label for anyone else are removed.
 */
export function setLabel(
  recordingId: string,
  plaudLabel: string,
  action: LabelAction,
  minSpeechMs: number,
  now = Date.now(),
): LabelChange {
  const d = getDb();
  return d.transaction((): LabelChange => {
    const row = d
      .prepare(
        "SELECT speech_ms, segment_keys, centroid, model_id FROM recording_speakers WHERE recording_id = ? AND plaud_label = ?",
      )
      .get(recordingId, plaudLabel) as
      | { speech_ms: number | null; segment_keys: string | null; centroid: Buffer | null; model_id: string | null }
      | undefined;
    if (!row) return { ok: false, code: 404, error: "speaker label not found" };
    const update = d.prepare(
      `UPDATE recording_speakers SET status = ?, speaker_id = ?, assigned_by = ?, updated_at = ?
       WHERE recording_id = ? AND plaud_label = ?`,
    );

    if (action.status !== "confirmed") {
      removeLabelVoiceprints(recordingId, plaudLabel);
      if (action.status === "ignored") update.run("ignored", null, "user", now, recordingId, plaudLabel);
      else update.run("unknown", null, null, now, recordingId, plaudLabel);
      return { ok: true, speakerId: null, voiceprint: "none" };
    }

    const person = resolvePerson(action.person, now);
    if (!person.ok) return { ok: false, code: "speakerId" in action.person ? 404 : 400, error: person.error };
    removeLabelVoiceprints(recordingId, plaudLabel, person.speakerId);
    update.run("confirmed", person.speakerId, "user", now, recordingId, plaudLabel);
    const voiceprint =
      row.centroid && row.model_id
        ? addVoiceprint(
            {
              speakerId: person.speakerId,
              recordingId,
              plaudLabel,
              segmentKeys: JSON.parse(row.segment_keys ?? "[]") as string[],
              vector: fromBlob(row.centroid),
              modelId: row.model_id,
              speechMs: row.speech_ms ?? 0,
              source: "confirmed",
            },
            minSpeechMs,
            now,
          )
        : "none";
    return { ok: true, speakerId: person.speakerId, voiceprint };
  })();
}

export type SegmentChange = { ok: true; speakerId: number | null } | { ok: false; code: 404 | 400; error: string };

/**
 * Assign one segment to a person, overriding its label (a secondary tool for
 * when Plaud merged two people, D12), or clear the override with `null`.
 * Overrides never create voiceprints.
 */
export function setSegmentSpeaker(
  recordingId: string,
  segmentKey: string,
  person: PersonRef | null,
  now = Date.now(),
): SegmentChange {
  const d = getDb();
  return d.transaction((): SegmentChange => {
    if (person === null) {
      d.prepare("DELETE FROM segment_overrides WHERE recording_id = ? AND segment_key = ?").run(recordingId, segmentKey);
      return { ok: true, speakerId: null };
    }
    const resolved = resolvePerson(person, now);
    if (!resolved.ok) return { ok: false, code: "speakerId" in person ? 404 : 400, error: resolved.error };
    d.prepare(
      `INSERT INTO segment_overrides (recording_id, segment_key, speaker_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (recording_id, segment_key) DO UPDATE SET speaker_id = excluded.speaker_id, updated_at = excluded.updated_at`,
    ).run(recordingId, segmentKey, resolved.speakerId, now);
    return { ok: true, speakerId: resolved.speakerId };
  })();
}
