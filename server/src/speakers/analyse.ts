import { readFileSync } from "node:fs";
import { isGenericSpeakerLabel } from "@applaud/shared";
import { getDb } from "../db.js";
import { DEFAULT_AUDIO_FILENAME, recordingPaths } from "../sync/layout.js";
import type { Embedder, EmbedResult, EmbedWindow } from "./embedder.js";
import { addVoiceprint } from "./library.js";
import { MAX_TOTAL_WINDOW_MS, MAX_WINDOWS } from "./protocol.js";
import { MISSING_SPEAKER_LABEL, normaliseSegments, type SpeakerSegment } from "./segments.js";
import { centroid, fromBlob, toBlob } from "./vectors.js";
import { WINDOW_MAX_MS, selectWindows } from "./windows.js";

export interface AnalyseContext {
  embedder: Embedder;
  recordingsDir: string;
  now?: () => number;
}

export type AnalyseOutcome =
  | { done: true; labels: number; modelId: string | null }
  /** Nothing to analyse yet (no audio or transcript); not an error. */
  | { done: false; reason: string };

interface RecordingFiles {
  audioPath: string;
  segments: SpeakerSegment[];
}

function loadRecording(recordingsDir: string, recordingId: string): RecordingFiles | string {
  const row = getDb()
    .prepare(
      `SELECT folder, audio_filename, duration_ms, audio_downloaded_at, transcript_downloaded_at
       FROM recordings WHERE id = ?`,
    )
    .get(recordingId) as
    | {
        folder: string;
        audio_filename: string | null;
        duration_ms: number;
        audio_downloaded_at: number | null;
        transcript_downloaded_at: number | null;
      }
    | undefined;
  if (!row) return "recording not found";
  if (!row.audio_downloaded_at || !row.transcript_downloaded_at) return "audio or transcript not downloaded";
  const paths = recordingPaths(recordingsDir, row.folder, row.audio_filename ?? DEFAULT_AUDIO_FILENAME);
  const raw: unknown = JSON.parse(readFileSync(paths.transcriptJsonPath, "utf8"));
  return { audioPath: paths.audioPath, segments: normaliseSegments(raw, row.duration_ms) };
}

/** Embed windows in as many requests as the per-request bounds need. */
async function embedAll(embedder: Embedder, audioPath: string, windows: EmbedWindow[]): Promise<EmbedResult[]> {
  const results: EmbedResult[] = [];
  let batch: EmbedWindow[] = [];
  let batchMs = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    results.push(await embedder.embed({ audioPath, windows: batch }));
    batch = [];
    batchMs = 0;
  };
  for (const w of windows) {
    const len = w.endMs - w.startMs;
    if (batch.length >= MAX_WINDOWS || batchMs + len > MAX_TOTAL_WINDOW_MS) await flush();
    batch.push(w);
    batchMs += len;
  }
  await flush();
  const models = new Set(results.map((r) => r.modelId));
  // The process could be replaced mid-recording by a new image; never mix models.
  if (models.size > 1) throw new Error("the speaker model changed during analysis");
  return results;
}

/**
 * Analyse one recording: embed each Plaud label's chosen windows and store the
 * label's centroid, speech and source segments in `recording_speakers`. A
 * label's assignment (status, person) is left as it was; matching is separate.
 */
export async function analyseRecording(ctx: AnalyseContext, recordingId: string): Promise<AnalyseOutcome> {
  const loaded = loadRecording(ctx.recordingsDir, recordingId);
  if (typeof loaded === "string") return { done: false, reason: loaded };
  const now = ctx.now?.() ?? Date.now();

  const byLabel = new Map<string, SpeakerSegment[]>();
  for (const s of loaded.segments) {
    if (s.label === MISSING_SPEAKER_LABEL) continue;
    const list = byLabel.get(s.label) ?? [];
    list.push(s);
    byLabel.set(s.label, list);
  }
  const windowsByLabel = new Map([...byLabel].map(([label, segs]) => [label, selectWindows(segs)]));
  const allWindows = [...windowsByLabel.values()].flat();

  const vectors = new Map<string, Float32Array>();
  let modelId: string | null = null;
  if (allWindows.length > 0) {
    for (const r of await embedAll(ctx.embedder, loaded.audioPath, allWindows)) {
      modelId = r.modelId;
      for (const v of r.vectors) vectors.set(v.id, v.vector);
    }
  }

  const d = getDb();
  const upsert = d.prepare(
    `INSERT INTO recording_speakers
       (recording_id, plaud_label, plaud_name, status, speech_ms, segment_keys, centroid, model_id, updated_at)
     VALUES (?, ?, ?, 'unknown', ?, ?, ?, ?, ?)
     ON CONFLICT (recording_id, plaud_label) DO UPDATE SET
       plaud_name = excluded.plaud_name, speech_ms = excluded.speech_ms, segment_keys = excluded.segment_keys,
       centroid = excluded.centroid, model_id = excluded.model_id, updated_at = excluded.updated_at`,
  );
  d.transaction(() => {
    for (const [label, segs] of byLabel) {
      const used = (windowsByLabel.get(label) ?? []).filter((w) => vectors.has(w.id));
      const c = centroid(used.map((w) => vectors.get(w.id)!));
      upsert.run(
        recordingId,
        label,
        mostCommonName(segs),
        used.reduce((n, w) => n + w.endMs - w.startMs, 0),
        JSON.stringify(used.map((w) => w.id)),
        c ? toBlob(c) : null,
        c ? modelId : null,
        now,
      );
    }
    // Labels gone since the last analysis (a resync re-diarised the
    // recording). Confirmed ones stay: they record a user decision.
    const labels = [...byLabel.keys()];
    d.prepare(
      `DELETE FROM recording_speakers WHERE recording_id = ? AND status != 'confirmed'
         AND plaud_label NOT IN (SELECT value FROM json_each(?))`,
    ).run(recordingId, JSON.stringify(labels));
    d.prepare("UPDATE recordings SET speakers_processed_at = ? WHERE id = ?").run(now, recordingId);
  })();
  return { done: true, labels: byLabel.size, modelId };
}

/** Plaud's `speaker` for most of a label's segments: the owner's name, or a rename made in Plaud. */
function mostCommonName(segs: SpeakerSegment[]): string | null {
  const counts = new Map<string, number>();
  for (const s of segs) if (s.name) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [name, c] of counts) {
    if (c > n) [best, n] = [name, c];
  }
  return best;
}

/**
 * Re-embed every voiceprint of a recording from its source segments (D14),
 * after the model changed. A voiceprint whose source can't be read keeps its
 * old vector; matching only compares vectors from the active model.
 */
export async function reembedRecording(ctx: AnalyseContext, recordingId: string): Promise<AnalyseOutcome> {
  const prints = getDb()
    .prepare("SELECT id, segment_keys FROM speaker_embeddings WHERE recording_id = ?")
    .all(recordingId) as { id: number; segment_keys: string }[];
  if (prints.length === 0) return { done: true, labels: 0, modelId: null };
  const loaded = loadRecording(ctx.recordingsDir, recordingId);
  if (typeof loaded === "string") return { done: false, reason: loaded };

  const byKey = new Map(loaded.segments.map((s) => [s.key, s]));
  const windowsByPrint = new Map<number, EmbedWindow[]>();
  for (const p of prints) {
    const keys = JSON.parse(p.segment_keys) as string[];
    const windows = keys
      .map((k) => byKey.get(k))
      .filter((s): s is SpeakerSegment => !!s)
      .map((s) => ({ id: s.key, startMs: s.startMs, endMs: Math.min(s.endMs, s.startMs + WINDOW_MAX_MS) }));
    windowsByPrint.set(p.id, windows);
  }
  const unique = new Map([...windowsByPrint.values()].flat().map((w) => [w.id, w]));
  if (unique.size === 0) return { done: true, labels: 0, modelId: null };

  const vectors = new Map<string, Float32Array>();
  let modelId: string | null = null;
  for (const r of await embedAll(ctx.embedder, loaded.audioPath, [...unique.values()])) {
    modelId = r.modelId;
    for (const v of r.vectors) vectors.set(v.id, v.vector);
  }
  const update = getDb().prepare("UPDATE speaker_embeddings SET vector = ?, model_id = ? WHERE id = ?");
  let updated = 0;
  for (const [id, windows] of windowsByPrint) {
    const c = centroid(windows.filter((w) => vectors.has(w.id)).map((w) => vectors.get(w.id)!));
    if (!c || !modelId) continue;
    update.run(toBlob(c), modelId, id);
    updated++;
  }
  return { done: true, labels: updated, modelId };
}

/** Voiceprints not yet from `modelId`, grouped by recording. */
export function recordingsWithStaleVoiceprints(modelId: string): string[] {
  return (
    getDb()
      .prepare("SELECT DISTINCT recording_id FROM speaker_embeddings WHERE model_id != ?")
      .all(modelId) as { recording_id: string }[]
  ).map((r) => r.recording_id);
}

/** The owner's person record, created or renamed to `name` as needed. */
function ensureOwner(name: string, now: number): number {
  const d = getDb();
  const owner = d.prepare("SELECT id, name FROM speakers WHERE is_owner = 1").get() as
    | { id: number; name: string }
    | undefined;
  const named = d.prepare("SELECT id FROM speakers WHERE name = ?").get(name) as { id: number } | undefined;
  if (owner && owner.name === name) return owner.id;
  if (owner && !named) {
    d.prepare("UPDATE speakers SET name = ?, updated_at = ? WHERE id = ?").run(name, now, owner.id);
    return owner.id;
  }
  if (owner) d.prepare("UPDATE speakers SET is_owner = 0, updated_at = ? WHERE id = ?").run(now, owner.id);
  if (named) {
    d.prepare("UPDATE speakers SET is_owner = 1, updated_at = ? WHERE id = ?").run(now, named.id);
    return named.id;
  }
  return Number(
    d
      .prepare("INSERT INTO speakers (name, is_owner, created_at, updated_at) VALUES (?, 1, ?, ?)")
      .run(name, now, now).lastInsertRowid,
  );
}

/**
 * Label the owner in every analysed recording where Plaud tagged them (D17)
 * and enrol their voiceprints. Uses stored centroids only, so it is cheap
 * enough to run after every analysis and whenever the owner name changes.
 * Owner labels made from a previous owner name are undone first; labels the
 * user assigned are left alone. Returns the number of voiceprints added.
 */
export function enrolOwner(ownerName: string | null, minSpeechMs: number, now = Date.now()): number {
  const name = ownerName?.trim() || null;
  const d = getDb();
  return d.transaction(() => {
    revertOwnerLabels(name, now);
    if (!name || isGenericSpeakerLabel(name)) return 0;
    const ownerId = ensureOwner(name, now);
    const rows = d
      .prepare(
        `SELECT recording_id, plaud_label, speech_ms, segment_keys, centroid, model_id FROM recording_speakers
         WHERE plaud_name = ? COLLATE NOCASE
           AND (status IN ('unknown', 'suggested', 'auto') OR (status = 'confirmed' AND assigned_by = 'plaud_owner'))`,
      )
      .all(name) as {
      recording_id: string;
      plaud_label: string;
      speech_ms: number | null;
      segment_keys: string | null;
      centroid: Buffer | null;
      model_id: string | null;
    }[];
    const confirm = d.prepare(
      `UPDATE recording_speakers SET status = 'confirmed', speaker_id = ?, assigned_by = 'plaud_owner',
         confidence = NULL, margin = NULL, updated_at = ?
       WHERE recording_id = ? AND plaud_label = ?`,
    );
    let added = 0;
    for (const r of rows) {
      confirm.run(ownerId, now, r.recording_id, r.plaud_label);
      if (!r.centroid || !r.model_id) continue;
      const outcome = addVoiceprint(
        {
          speakerId: ownerId,
          recordingId: r.recording_id,
          plaudLabel: r.plaud_label,
          segmentKeys: JSON.parse(r.segment_keys ?? "[]") as string[],
          vector: fromBlob(r.centroid),
          modelId: r.model_id,
          speechMs: r.speech_ms ?? 0,
          source: "plaud_owner",
        },
        minSpeechMs,
        now,
      );
      if (outcome === "added") added++;
    }
    return added;
  })();
}

/**
 * Undo owner labels, and their voiceprints, whose Plaud name is no longer the
 * owner name (all of them when `name` is null): the owner name was changed.
 */
function revertOwnerLabels(name: string | null, now: number): void {
  const d = getDb();
  d.prepare(
    `DELETE FROM speaker_embeddings WHERE source = 'plaud_owner' AND NOT EXISTS (
       SELECT 1 FROM recording_speakers rs
       WHERE rs.recording_id = speaker_embeddings.recording_id AND rs.plaud_label = speaker_embeddings.plaud_label
         AND rs.plaud_name = ? COLLATE NOCASE)`,
  ).run(name);
  d.prepare(
    `UPDATE recording_speakers SET status = 'unknown', speaker_id = NULL, assigned_by = NULL, updated_at = ?
     WHERE assigned_by = 'plaud_owner' AND (? IS NULL OR plaud_name IS NULL OR plaud_name != ? COLLATE NOCASE)`,
  ).run(now, name, name);
}

/** Non-generic names Plaud has tagged speakers with, by the number of recordings. */
export function observedPlaudNames(): { name: string; recordings: number }[] {
  const rows = getDb()
    .prepare(
      `SELECT plaud_name AS name, COUNT(DISTINCT recording_id) AS recordings FROM recording_speakers
       WHERE plaud_name IS NOT NULL GROUP BY plaud_name COLLATE NOCASE ORDER BY recordings DESC, name`,
    )
    .all() as { name: string; recordings: number }[];
  return rows.filter((r) => !isGenericSpeakerLabel(r.name));
}
