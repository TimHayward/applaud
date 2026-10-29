import { isGenericSpeakerLabel } from "@applaud/shared";
import { getDb } from "../db.js";

export const PERSON_NAME_MAX = 100;

/** Who to assign: an existing person, or a name (an existing person's, or a new one). */
export type PersonRef = { speakerId: number } | { name: string };

export type ResolvedPerson = { ok: true; speakerId: number; created: boolean } | { ok: false; error: string };

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
  const name = ref.name.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "name is empty" };
  if (name.length > PERSON_NAME_MAX) return { ok: false, error: `name is longer than ${PERSON_NAME_MAX} characters` };
  if (isGenericSpeakerLabel(name)) return { ok: false, error: "a placeholder such as \"Speaker 2\" can't be a person's name" };
  const existing = d.prepare("SELECT id FROM speakers WHERE name = ? COLLATE NOCASE").get(name) as
    | { id: number }
    | undefined;
  if (existing) return { ok: true, speakerId: existing.id, created: false };
  const id = Number(
    d.prepare("INSERT INTO speakers (name, created_at, updated_at) VALUES (?, ?, ?)").run(name, now, now).lastInsertRowid,
  );
  return { ok: true, speakerId: id, created: true };
}

export interface PersonSummary {
  id: number;
  name: string;
  isOwner: boolean;
  voiceprints: number;
}

export function listPeople(): PersonSummary[] {
  return (
    getDb()
      .prepare(
        `SELECT s.id, s.name, s.is_owner, (SELECT COUNT(*) FROM speaker_embeddings e WHERE e.speaker_id = s.id) AS n
         FROM speakers s ORDER BY s.is_owner DESC, s.name COLLATE NOCASE`,
      )
      .all() as { id: number; name: string; is_owner: number; n: number }[]
  ).map((r) => ({ id: r.id, name: r.name, isOwner: r.is_owner === 1, voiceprints: r.n }));
}
