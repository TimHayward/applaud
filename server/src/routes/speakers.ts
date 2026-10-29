import { Router, type Response } from "express";
import { z } from "zod";
import {
  speakerConfig,
  type RecordingSpeakerLabel,
  type RecordingSpeakersResponse,
  type SetSpeakerLabelResponse,
  type SpeakerStatusResponse,
} from "@applaud/shared";
import { loadConfig } from "../config.js";
import { getDb } from "../db.js";
import { logger } from "../logger.js";
import { getRecordingById } from "../sync/state.js";
import { observedPlaudNames } from "../speakers/analyse.js";
import { labelCandidates, setLabel, setSegmentSpeaker } from "../speakers/assign.js";
import { loadSegments } from "../speakers/outputs.js";
import { listPeople, PERSON_NAME_MAX } from "../speakers/people.js";
import { describeError } from "../speakers/runner.js";
import { speakerRunner } from "../speakers/service.js";

/** Mounted at /api: speaker identification status, the capability check, labels and re-analysis. */
export const speakersRouter = Router();

function statusBody(): SpeakerStatusResponse {
  const cfg = loadConfig();
  const s = speakerConfig(cfg);
  return {
    ...speakerRunner().status(),
    enabled: s.enabled,
    ownerName: s.ownerName,
    plaudNickname: cfg.plaudNickname,
    /** Names Plaud has tagged speakers with: candidates for the owner. */
    plaudNames: s.enabled ? observedPlaudNames() : [],
    thresholds: {
      autoThreshold: s.autoThreshold,
      autoMargin: s.autoMargin,
      minSpeechSec: s.minSpeechSec,
      suggestThreshold: s.suggestThreshold,
    },
  };
}

speakersRouter.get("/speakers/status", (_req, res) => {
  res.json(statusBody());
});

/** Re-run the capability check (Settings → Speakers → Retry). */
speakersRouter.post("/speakers/check", async (_req, res) => {
  await speakerRunner().check();
  res.json(statusBody());
});

speakersRouter.get("/speakers/people", (_req, res) => {
  res.json({ people: speakerConfig(loadConfig()).enabled ? listPeople() : [] });
});

/** 409 while the feature is off, 404 for an unknown recording; otherwise the recording id. */
function guard(id: string, res: Response): string | null {
  if (!speakerConfig(loadConfig()).enabled) {
    res.status(409).json({ error: "speaker identification is off" });
    return null;
  }
  const row = getRecordingById(id);
  if (!row) {
    res.status(404).json({ error: "recording not found" });
    return null;
  }
  return row.id;
}

function recordingSpeakers(recordingId: string): RecordingSpeakersResponse {
  const d = getDb();
  const activeModelId = speakerConfig(loadConfig()).activeModelId;
  const analysed = d.prepare("SELECT speakers_processed_at FROM recordings WHERE id = ?").get(recordingId) as
    | { speakers_processed_at: number | null }
    | undefined;
  const people = listPeople();
  const names = new Map(people.map((p) => [p.id, p.name]));
  const rows = d
    .prepare(
      `SELECT plaud_label, plaud_name, status, assigned_by, speaker_id, confidence, margin, speech_ms
       FROM recording_speakers WHERE recording_id = ? ORDER BY plaud_label`,
    )
    .all(recordingId) as {
    plaud_label: string;
    plaud_name: string | null;
    status: RecordingSpeakerLabel["status"];
    assigned_by: RecordingSpeakerLabel["assignedBy"];
    speaker_id: number | null;
    confidence: number | null;
    margin: number | null;
    speech_ms: number | null;
  }[];
  const overrides = d
    .prepare("SELECT segment_key, speaker_id FROM segment_overrides WHERE recording_id = ?")
    .all(recordingId) as { segment_key: string; speaker_id: number }[];
  return {
    enabled: true,
    analysed: !!analysed?.speakers_processed_at,
    labels: rows.map((r) => ({
      plaudLabel: r.plaud_label,
      plaudName: r.plaud_name,
      status: r.status,
      assignedBy: r.assigned_by,
      speakerId: r.speaker_id,
      speakerName: r.speaker_id !== null ? (names.get(r.speaker_id) ?? null) : null,
      confidence: r.confidence,
      margin: r.margin,
      speechMs: r.speech_ms,
      candidates: labelCandidates(recordingId, r.plaud_label, activeModelId).map((c) => ({
        speakerId: c.speakerId,
        name: names.get(c.speakerId) ?? "",
        score: c.score,
      })),
    })),
    overrides: Object.fromEntries(overrides.map((o) => [o.segment_key, o.speaker_id])),
    people,
  };
}

speakersRouter.get("/recordings/:id/speakers", (req, res) => {
  if (!speakerConfig(loadConfig()).enabled) {
    const off: RecordingSpeakersResponse = { enabled: false, analysed: false, labels: [], overrides: {}, people: [] };
    res.json(off);
    return;
  }
  const id = guard(req.params.id, res);
  if (id) res.json(recordingSpeakers(id));
});

const PersonRef = z.union([
  z.object({ speakerId: z.number().int().positive() }).strict(),
  z.object({ name: z.string().max(PERSON_NAME_MAX * 2) }).strict(),
]);

const LabelBody = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confirmed"), person: PersonRef }),
  z.object({ status: z.literal("ignored") }),
  z.object({ status: z.literal("unknown") }),
]);

speakersRouter.put("/recordings/:id/speakers/:label", async (req, res) => {
  const id = guard(req.params.id, res);
  if (!id) return;
  const parsed = LabelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const minSpeechMs = speakerConfig(loadConfig()).minSpeechSec * 1000;
  const out = setLabel(id, req.params.label, parsed.data, minSpeechMs);
  if (!out.ok) {
    res.status(out.code).json({ error: out.error });
    return;
  }
  await afterChange(id);
  const body: SetSpeakerLabelResponse = { ...recordingSpeakers(id), voiceprint: out.voiceprint };
  res.json(body);
});

const SegmentBody = z.object({ person: PersonRef.nullable() });

speakersRouter.put("/recordings/:id/segments/:segmentKey/speaker", async (req, res) => {
  const id = guard(req.params.id, res);
  if (!id) return;
  const parsed = SegmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const dir = loadConfig().recordingsDir;
  let known = false;
  try {
    known = !!dir && !!loadSegments(dir, id)?.segments.some((s) => s.key === req.params.segmentKey);
  } catch (err) {
    res.status(500).json({ error: describeError(err) });
    return;
  }
  if (!known) {
    res.status(404).json({ error: "segment not found" });
    return;
  }
  const out = setSegmentSpeaker(id, req.params.segmentKey, parsed.data.person);
  if (!out.ok) {
    res.status(out.code).json({ error: out.error });
    return;
  }
  await afterChange(id);
  res.json(recordingSpeakers(id));
});

speakersRouter.post("/recordings/:id/speakers/reanalyse", (req, res) => {
  const id = guard(req.params.id, res);
  if (!id) return;
  speakerRunner().enqueue("analyse", id);
  res.status(202).json({ ok: true });
});

/** Re-match and rewrite outputs; the change itself is already saved, so a failure here is only logged. */
async function afterChange(recordingId: string): Promise<void> {
  try {
    await speakerRunner().labelsChanged(recordingId);
  } catch (err) {
    logger.warn({ recordingId, err: describeError(err) }, "could not refresh speakers after a change");
  }
}
