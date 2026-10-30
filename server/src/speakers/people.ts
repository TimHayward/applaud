import { isGenericSpeakerLabel } from "@applaud/shared";
import { getDb } from "../db.js";
import { VOICEPRINT_CAP } from "./library.js";

export const PERSON_NAME_MAX = 100;

/** Who to assign: an existing person, or a name (an existing person's, or a new one). */
export type PersonRef = { speakerId: number } | { name: string };

export type ResolvedPerson = { ok: true; speakerId: number; created: boolean } | { ok: false; error: string };

/** A display name tidied, or why it can't be a person's name. */
function checkName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "name is empty" };
  if (name.length > PERSON_NAME_MAX) return { ok: false, error: `name is longer than ${PERSON_NAME_MAX} characters` };
  if (isGenericSpeakerLabel(name)) return { ok: false, error: "a placeholder such as \"Speaker 2\" can't be a person's name" };
  return { ok: true, name };
}

/**
 * The person `ref` names, creating them for a new name. Placeholders such as
 * "Speaker 2" are never people (section 7, rule 7). Names match case-insensitively.
 */
export function resolvePerson(ref: PersonRef, now = Date.now()): ResolvedPerson {
  const d = getDb();
  if ("speakerId" in ref) {
    const row = d.prepare("SELECT id FROM speakers WHERE id = ?").get(ref.speakerId) as { id: number } | undefined;
    return row ? { ok: true, speakerId: row.id, created: false } : { ok: false, error: "person not found" };
  }
  const checked = checkName(ref.name);
  if (!checked.ok) return checked;
  const existing = d.prepare("SELECT id FROM speakers WHERE name = ? COLLATE NOCASE").get(checked.name) as
    | { id: number }
    | undefined;
  if (existing) return { ok: true, speakerId: existing.id, created: false };
  const id = Number(
    d
      .prepare("INSERT INTO speakers (name, created_at, updated_at) VALUES (?, ?, ?)")
      .run(checked.name, now, now).lastInsertRowid,
  );
  return { ok: true, speakerId: id, created: true };
}

export interface PersonSummary {
  id: number;
  name: string;
  isOwner: boolean;
  voiceprints: number;
  /** Recordings where a label is confirmed or automatically named as this person. */
  recordings: number;
  /** Voiceprints flagged as not resembling the person's others (section 7.1). */
  lowResemblance: number;
}

export function listPeople(): PersonSummary[] {
  return (
    getDb()
      .prepare(
        `SELECT s.id, s.name, s.is_owner,
           (SELECT COUNT(*) FROM speaker_embeddings e WHERE e.speaker_id = s.id) AS voiceprints,
           (SELECT COUNT(*) FROM speaker_embeddings e WHERE e.speaker_id = s.id AND e.low_resemblance = 1) AS low,
           (SELECT COUNT(DISTINCT rs.recording_id) FROM recording_speakers rs
              WHERE rs.speaker_id = s.id AND rs.status IN ('confirmed', 'auto')) AS recordings
         FROM speakers s ORDER BY s.is_owner DESC, s.name COLLATE NOCASE`,
      )
      .all() as { id: number; name: string; is_owner: number; voiceprints: number; low: number; recordings: number }[]
  ).map((r) => ({
    id: r.id,
    name: r.name,
    isOwner: r.is_owner === 1,
    voiceprints: r.voiceprints,
    recordings: r.recordings,
    lowResemblance: r.low,
  }));
}

export type PersonChange = { ok: true } | { ok: false; code: 400 | 404 | 409; error: string };

function findPerson(id: number): { id: number; is_owner: number } | undefined {
  return getDb().prepare("SELECT id, is_owner FROM speakers WHERE id = ?").get(id) as
    | { id: number; is_owner: number }
    | undefined;
}

/** Rename a person. The owner's name follows the Settings choice, so it is changed there instead. */
export function renamePerson(id: number, rawName: string, now = Date.now()): PersonChange {
  const d = getDb();
  const person = findPerson(id);
  if (!person) return { ok: false, code: 404, error: "person not found" };
  if (person.is_owner) {
    return { ok: false, code: 409, error: "your name follows the choice in Settings → Speaker identification" };
  }
  const checked = checkName(rawName);
  if (!checked.ok) return { ok: false, code: 400, error: checked.error };
  const clash = d.prepare("SELECT id FROM speakers WHERE name = ? COLLATE NOCASE AND id != ?").get(checked.name, id);
  if (clash) return { ok: false, code: 409, error: "someone already has that name; merge them instead" };
  d.prepare("UPDATE speakers SET name = ?, updated_at = ? WHERE id = ?").run(checked.name, now, id);
  return { ok: true };
}

/**
 * Merge `fromId` into `intoId`: the same person under two names. Labels,
 * segment overrides and voiceprints move across (the target keeps its anchor
 * and the cap of 12 applies), then `fromId` is deleted. The owner can only be
 * merged into, so the Settings choice keeps pointing at them.
 */
export function mergePeople(fromId: number, intoId: number, now = Date.now()): PersonChange {
  if (fromId === intoId) return { ok: false, code: 400, error: "can't merge a person into themselves" };
  const d = getDb();
  const from = findPerson(fromId);
  const into = findPerson(intoId);
  if (!from || !into) return { ok: false, code: 404, error: "person not found" };
  if (from.is_owner) return { ok: false, code: 409, error: "merge the other person into you instead" };
  d.transaction(() => {
    // One voiceprint per (person, recording, label): the target's wins.
    d.prepare(
      `DELETE FROM speaker_embeddings WHERE speaker_id = ? AND EXISTS (
         SELECT 1 FROM speaker_embeddings t WHERE t.speaker_id = ?
           AND t.recording_id = speaker_embeddings.recording_id AND t.plaud_label = speaker_embeddings.plaud_label)`,
    ).run(fromId, intoId);
    d.prepare("UPDATE speaker_embeddings SET speaker_id = ?, is_anchor = 0 WHERE speaker_id = ?").run(intoId, fromId);
    d.prepare(
      `UPDATE speaker_embeddings SET is_anchor = 1 WHERE id = (
         SELECT id FROM speaker_embeddings WHERE speaker_id = ? ORDER BY created_at ASC, id ASC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM speaker_embeddings WHERE speaker_id = ? AND is_anchor = 1)`,
    ).run(intoId, intoId);
    const over =
      (d.prepare("SELECT COUNT(*) AS n FROM speaker_embeddings WHERE speaker_id = ?").get(intoId) as { n: number }).n -
      VOICEPRINT_CAP;
    if (over > 0) {
      d.prepare(
        `DELETE FROM speaker_embeddings WHERE id IN (
           SELECT id FROM speaker_embeddings WHERE speaker_id = ? AND is_anchor = 0
           ORDER BY created_at ASC, id ASC LIMIT ?)`,
      ).run(intoId, over);
    }
    d.prepare("UPDATE recording_speakers SET speaker_id = ?, updated_at = ? WHERE speaker_id = ?").run(intoId, now, fromId);
    d.prepare("UPDATE segment_overrides SET speaker_id = ?, updated_at = ? WHERE speaker_id = ?").run(intoId, now, fromId);
    d.prepare("DELETE FROM speakers WHERE id = ?").run(fromId);
    d.prepare("UPDATE speakers SET updated_at = ? WHERE id = ?").run(now, intoId);
  })();
  return { ok: true };
}

/** Delete a person and their voiceprints; their labels go back to unknown. Not the owner. */
export function deletePerson(id: number, now = Date.now()): PersonChange {
  const d = getDb();
  const person = findPerson(id);
  if (!person) return { ok: false, code: 404, error: "person not found" };
  if (person.is_owner) {
    return { ok: false, code: 409, error: "you can't be deleted; turn speaker identification off instead" };
  }
  d.transaction(() => {
    d.prepare(
      `UPDATE recording_speakers SET status = 'unknown', speaker_id = NULL, assigned_by = NULL,
         confidence = NULL, margin = NULL, updated_at = ?
       WHERE speaker_id = ?`,
    ).run(now, id);
    // Voiceprints and segment overrides go with the person (ON DELETE CASCADE).
    d.prepare("DELETE FROM speakers WHERE id = ?").run(id);
  })();
  return { ok: true };
}

export interface VoiceprintSummary {
  id: number;
  recordingId: string;
  recordingTitle: string | null;
  recordingStart: number | null;
  plaudLabel: string;
  source: string;
  isAnchor: boolean;
  lowResemblance: boolean;
  speechMs: number;
  createdAt: number;
}

/** A person's voiceprints, described (never the vectors). */
export function listVoiceprints(speakerId: number): VoiceprintSummary[] {
  return (
    getDb()
      .prepare(
        `SELECT e.id, e.recording_id, COALESCE(r.display_name, r.filename) AS title, r.start_time, e.plaud_label,
           e.source, e.is_anchor, e.low_resemblance, e.speech_ms, e.created_at
         FROM speaker_embeddings e LEFT JOIN recordings r ON r.id = e.recording_id
         WHERE e.speaker_id = ? ORDER BY e.is_anchor DESC, r.start_time DESC, e.id`,
      )
      .all(speakerId) as {
      id: number;
      recording_id: string;
      title: string | null;
      start_time: number | null;
      plaud_label: string;
      source: string;
      is_anchor: number;
      low_resemblance: number;
      speech_ms: number;
      created_at: number;
    }[]
  ).map((r) => ({
    id: r.id,
    recordingId: r.recording_id,
    recordingTitle: r.title,
    recordingStart: r.start_time,
    plaudLabel: r.plaud_label,
    source: r.source,
    isAnchor: r.is_anchor === 1,
    lowResemblance: r.low_resemblance === 1,
    speechMs: r.speech_ms,
    createdAt: r.created_at,
  }));
}

/** Labels still to be named or confirmed, per recording (not in Trash). */
export function labelsToReview(): Record<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT rs.recording_id AS id, COUNT(*) AS n FROM recording_speakers rs
       JOIN recordings r ON r.id = rs.recording_id
       WHERE rs.status IN ('unknown', 'suggested') AND r.user_deleted_at IS NULL
       GROUP BY rs.recording_id`,
    )
    .all() as { id: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}
