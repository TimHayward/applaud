import { getDb } from "../db.js";
import { cosine, fromBlob, toBlob } from "./vectors.js";

/** Voiceprints kept per person (D11). */
export const VOICEPRINT_CAP = 12;
/** Skip a voiceprint this similar to one the person already has. */
export const NEAR_DUPLICATE = 0.95;
/** Flag a confirmed voiceprint below this against all of the person's others. */
export const LOW_RESEMBLANCE = 0.55;

export type VoiceprintSource = "confirmed" | "plaud_owner" | "backfill";

export interface NewVoiceprint {
  speakerId: number;
  recordingId: string;
  plaudLabel: string;
  segmentKeys: string[];
  vector: Float32Array;
  modelId: string;
  speechMs: number;
  source: VoiceprintSource;
  scene?: string | null;
}

export type AddOutcome = "added" | "replaced" | "duplicate" | "too_short";

/**
 * Add a voiceprint to a person, applying the library hygiene rules (section
 * 7.1): a minimum amount of speech, the first voiceprint as a never-evicted
 * anchor, a cap with oldest-first eviction, near-duplicate skip, and a
 * low-resemblance flag. Only voiceprints from the same model are compared.
 */
export function addVoiceprint(v: NewVoiceprint, minSpeechMs: number, now = Date.now()): AddOutcome {
  if (v.speechMs < minSpeechMs) return "too_short";
  const d = getDb();
  return d.transaction((): AddOutcome => {
    const same = d
      .prepare("SELECT id FROM speaker_embeddings WHERE speaker_id = ? AND recording_id = ? AND plaud_label = ?")
      .get(v.speakerId, v.recordingId, v.plaudLabel) as { id: number } | undefined;
    if (same) {
      d.prepare(
        "UPDATE speaker_embeddings SET vector = ?, model_id = ?, segment_keys = ?, speech_ms = ?, source = ? WHERE id = ?",
      ).run(toBlob(v.vector), v.modelId, JSON.stringify(v.segmentKeys), v.speechMs, v.source, same.id);
      return "replaced";
    }

    const existing = d
      .prepare("SELECT id, vector, is_anchor FROM speaker_embeddings WHERE speaker_id = ? AND model_id = ?")
      .all(v.speakerId, v.modelId) as { id: number; vector: Buffer; is_anchor: number }[];
    const scores = existing.map((e) => cosine(v.vector, fromBlob(e.vector)));
    if (scores.some((s) => s > NEAR_DUPLICATE)) return "duplicate";
    const lowResemblance = scores.length > 0 && scores.every((s) => s < LOW_RESEMBLANCE);
    const hasAnchor = (
      d.prepare("SELECT 1 FROM speaker_embeddings WHERE speaker_id = ? AND is_anchor = 1").get(v.speakerId) as
        | object
        | undefined
    ) !== undefined;

    d.prepare(
      `INSERT INTO speaker_embeddings
         (speaker_id, recording_id, plaud_label, segment_keys, scene, is_anchor, model_id, vector,
          speech_ms, source, low_resemblance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      v.speakerId,
      v.recordingId,
      v.plaudLabel,
      JSON.stringify(v.segmentKeys),
      v.scene ?? null,
      hasAnchor ? 0 : 1,
      v.modelId,
      toBlob(v.vector),
      v.speechMs,
      v.source,
      lowResemblance ? 1 : 0,
      now,
    );

    const over =
      (d.prepare("SELECT COUNT(*) AS n FROM speaker_embeddings WHERE speaker_id = ?").get(v.speakerId) as { n: number })
        .n - VOICEPRINT_CAP;
    if (over > 0) {
      d.prepare(
        `DELETE FROM speaker_embeddings WHERE id IN (
           SELECT id FROM speaker_embeddings WHERE speaker_id = ? AND is_anchor = 0
           ORDER BY created_at ASC, id ASC LIMIT ?)`,
      ).run(v.speakerId, over);
    }
    return "added";
  })();
}
