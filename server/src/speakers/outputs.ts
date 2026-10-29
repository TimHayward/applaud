import { existsSync, readFileSync } from "node:fs";
import { getDb } from "../db.js";
import { writeFileAtomic } from "../fsAtomic.js";
import { flattenTranscript } from "../plaud/transcript.js";
import { DEFAULT_AUDIO_FILENAME, recordingPaths, type RecordingPaths } from "../sync/layout.js";
import { normaliseSegments, type SpeakerSegment } from "./segments.js";

/** A segment of `transcript-Applaud.json` (section 9). Timings are milliseconds. */
export interface ApplaudSegment {
  segment_key: string;
  start_time: number;
  end_time: number;
  content: string;
  /** Applaud's name for the speaker: the person when confirmed or automatic, else Plaud's name. */
  speaker: string;
  speaker_id: number | null;
  /** Plaud's name for the segment's speaker (`speaker` in `transcript.json`). */
  plaud_speaker: string;
  /** Plaud's diarisation label (`original_speaker`), which Applaud's labels are keyed by (D8). */
  original_speaker: string;
  label_status: "confirmed" | "auto" | "suggested" | "unknown" | "ignored";
  confidence: number | null;
  /** The person a suggestion points to; the transcript keeps Plaud's name until it is confirmed. */
  suggested_speaker?: string;
  /** Set when this segment was assigned on its own, overriding its label. */
  segment_override?: true;
}

export interface LabelAssignment {
  status: ApplaudSegment["label_status"];
  speakerId: number | null;
  confidence: number | null;
}

/** Plaud's segments with Applaud's names applied: per-segment overrides first, then the label's assignment. */
export function buildApplaudTranscript(
  segments: SpeakerSegment[],
  labels: ReadonlyMap<string, LabelAssignment>,
  overrides: ReadonlyMap<string, number>,
  names: ReadonlyMap<number, string>,
): ApplaudSegment[] {
  return segments.map((s): ApplaudSegment => {
    const base = {
      segment_key: s.key,
      start_time: s.startMs,
      end_time: s.endMs,
      content: s.text,
      plaud_speaker: s.name,
      original_speaker: s.label,
    };
    const override = overrides.get(s.key);
    const overrideName = override !== undefined ? names.get(override) : undefined;
    if (override !== undefined && overrideName) {
      return { ...base, speaker: overrideName, speaker_id: override, label_status: "confirmed", confidence: null, segment_override: true };
    }
    const a = labels.get(s.label);
    const status = a?.status ?? "unknown";
    const person = a?.speakerId != null ? names.get(a.speakerId) : undefined;
    const named = (status === "confirmed" || status === "auto") && person;
    return {
      ...base,
      speaker: named ? person : s.name,
      speaker_id: named ? a!.speakerId : null,
      label_status: status,
      confidence: a?.confidence ?? null,
      ...(status === "suggested" && person ? { suggested_speaker: person } : {}),
    };
  });
}

export type WriteOutcome = "written" | "unchanged" | "skipped";

/** A recording's normalised transcript segments, or null when it has no transcript yet. */
export function loadSegments(
  recordingsDir: string,
  recordingId: string,
): { paths: RecordingPaths; segments: SpeakerSegment[] } | null {
  const row = getDb()
    .prepare("SELECT folder, audio_filename, duration_ms, transcript_downloaded_at FROM recordings WHERE id = ?")
    .get(recordingId) as
    | { folder: string; audio_filename: string | null; duration_ms: number; transcript_downloaded_at: number | null }
    | undefined;
  if (!row?.transcript_downloaded_at) return null;
  const paths = recordingPaths(recordingsDir, row.folder, row.audio_filename ?? DEFAULT_AUDIO_FILENAME);
  if (!existsSync(paths.transcriptJsonPath)) return null;
  const raw: unknown = JSON.parse(readFileSync(paths.transcriptJsonPath, "utf8"));
  return { paths, segments: normaliseSegments(raw, row.duration_ms) };
}

/**
 * Write `transcript-Applaud.json` and `.txt` for an analysed recording, each
 * atomically and only when its content changed. Skipped when the recording
 * has no transcript or has not been analysed.
 */
export function writeApplaudTranscript(recordingsDir: string, recordingId: string): WriteOutcome {
  const d = getDb();
  const analysed = d.prepare("SELECT speakers_processed_at FROM recordings WHERE id = ?").get(recordingId) as
    | { speakers_processed_at: number | null }
    | undefined;
  if (!analysed?.speakers_processed_at) return "skipped";
  const loaded = loadSegments(recordingsDir, recordingId);
  if (!loaded) return "skipped";
  const { paths, segments } = loaded;

  const labels = new Map(
    (
      d
        .prepare("SELECT plaud_label, status, speaker_id, confidence FROM recording_speakers WHERE recording_id = ?")
        .all(recordingId) as { plaud_label: string; status: string; speaker_id: number | null; confidence: number | null }[]
    ).map((r) => [
      r.plaud_label,
      { status: r.status as LabelAssignment["status"], speakerId: r.speaker_id, confidence: r.confidence },
    ]),
  );
  const overrides = new Map(
    (
      d.prepare("SELECT segment_key, speaker_id FROM segment_overrides WHERE recording_id = ?").all(recordingId) as {
        segment_key: string;
        speaker_id: number;
      }[]
    ).map((r) => [r.segment_key, r.speaker_id]),
  );
  const names = new Map(
    (d.prepare("SELECT id, name FROM speakers").all() as { id: number; name: string }[]).map((r) => [r.id, r.name]),
  );

  const out = buildApplaudTranscript(segments, labels, overrides, names);
  const json = `${JSON.stringify(out, null, 2)}\n`;
  const text = flattenTranscript(
    out.map((s) => ({
      start_time: s.start_time,
      end_time: s.end_time,
      content: s.content,
      speaker: s.speaker,
      original_speaker: s.original_speaker,
    })),
  );
  const a = writeIfChanged(paths.applaudTranscriptJsonPath, json);
  const b = writeIfChanged(paths.applaudTranscriptTxtPath, text);
  return a || b ? "written" : "unchanged";
}

function writeIfChanged(file: string, content: string): boolean {
  try {
    if (readFileSync(file, "utf8") === content) return false;
  } catch {
    /* missing: write it */
  }
  writeFileAtomic(file, content);
  return true;
}

/** Analysed recordings, for writing every output once (first start after an upgrade). */
export function analysedRecordings(): string[] {
  return (
    getDb().prepare("SELECT id FROM recordings WHERE speakers_processed_at IS NOT NULL ORDER BY id").all() as {
      id: string;
    }[]
  ).map((r) => r.id);
}
