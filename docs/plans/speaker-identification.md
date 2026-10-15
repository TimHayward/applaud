# Speaker identification, `-Applaud` outputs and Plaud write-back

Status: **Agreed scope, ready for Phase 0** (2026-10-14)

## 1. Context

Plaud has removed automatic speaker recognition. In a current transcript only the account owner is named; every other participant arrives as `Speaker N` (sample of 497 segments: `Tim Hayward` 294, `Speaker 1` 195, `Speaker 3` 8; `speaker === original_speaker` in every segment). Manual renaming in the Plaud web app still works.

Recordings are consumed through several routes: Ask Plaud, Obsidian (via n8n), and Copilot / Cowork. Speaker names therefore need to exist both in Applaud's outputs and, eventually, back in Plaud itself.

### Decisions

| #   | Decision                                                                                                                                                                                    | Basis                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| D1  | No second transcription. Plaud's transcript and segmentation are trusted.                                                                                                                   | User decision                          |
| D2  | Speaker identification uses **local voice embeddings**, never an LLM. LLMs cannot recognise voices.                                                                                         | Technical constraint                   |
| D3  | Voiceprints are stored **locally only** (SQLite). Recordings are private conversations.                                                                                                     | User constraint (privacy)              |
| D4  | Outputs live in the recording folder: `transcript-Applaud.json`, `transcript-Applaud.txt`, `summary-Applaud.md`.                                                                            | User accepted                          |
| D5  | The `-Applaud` summary is generated via OpenRouter **only after speakers are labelled**, plus a manual **Regenerate** button. Transcript text only is sent; audio never leaves the machine. | User decision                          |
| D6  | Only **confirmed** labels (or Plaud's own owner tag) enrol voiceprints. Auto-matches never feed the library.                                                                                | Prevents compounding errors            |
| D7  | Write-back to Plaud is **designed for now, built last** (Phase 5), behind explicit opt-in. The Plaud MCP is read-only, so write-back goes through Applaud, which n8n can trigger.           | User decision; MCP has no write tools  |
| D8  | Labels are keyed by Plaud `segment_uid` and Plaud speaker label, with provenance, so write-back needs no rework.                                                                            | Enables D7                             |
| D9  | Voice embedding runs in a **separate worker container on the Portainer host**, not on the NAS. The NAS has no AVX and is already under memory pressure (see Target environment).            | Evidenced: NAS measurements 2026-10-15 |

### Target environment

**Corrected 2026-10-15:** Applaud runs in Docker on a **Synology DS920+** (Intel Celeron J4125, 4 cores, 4 GB RAM shared with DSM; officially upgradeable to 8 GB). A separate Portainer Docker host is available if work needs to move off the NAS. Local installs (macOS / Linux / Windows) must keep working.

Measured on the NAS (2026-10-15):

- **No AVX** (`grep -c avx /proc/cpuinfo` returned `0`). ML runtimes built for AVX fail with "illegal instruction"; ONNX Runtime behaviour on this CPU is unverified.
- **Already under memory pressure.** 3.7 GB total, about 976 MB available, about 2 GB of swap in use. Containers account for only about 380 MB (Applaud 112 MB), so DSM and its packages hold most of it.

Consequence (D9): Applaud stays on the NAS and remains light. All audio decoding and embedding move to a stateless worker on the Portainer host. The NAS takes on no new CPU or memory load beyond small HTTP calls and SQLite rows.

Portainer host `bluedckr01` (measured 2026-10-15): AVX present, 6 cores, 16 GB RAM with about 6 GB available, swap essentially unused, always on, reaches the NAS on port 44471.

## 2. Architecture

```
transcript.json (Plaud) ──┐
audio.* ── /media ticket ──► WORKER (Portainer host): ffmpeg ──► 16 kHz PCM windows
                                              │
                     sherpa-onnx speaker embedder (worker; returns vectors only)
                                              │
          APPLAUD (NAS): per-label centroid + outlier segments
                                              │
                speaker library (SQLite) ──► matcher (cosine + one-to-one assignment)
                                              │
            recording_speakers: auto | suggested | unknown | confirmed
                     │                          │
         labelling UI (detail page)     transcript-Applaud.{json,txt}
                     │                          │
             confirm ⇒ enrol voiceprint   summary-Applaud.md (OpenRouter, on demand)
                                                │
                                   webhook: applaud_transcript_ready / applaud_summary_ready
                                                │
                                   (Phase 5) write-back to Plaud
```

### Key components

| Component         | Choice                                                                                                                                 | Notes                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embedding runtime | Worker container on the Portainer host running `sherpa-onnx-node` (Apache-2.0)                                                         | Same language and toolchain as Applaud (lives in the monorepo as `worker/`). A Python worker (SpeechBrain ECAPA) remains an alternative if accuracy needs it.     |
| Embedding model   | WeSpeaker VoxCeleb ResNet34 (English), ~26 MB ONNX                                                                                     | Downloaded on first enable into the config dir, pinned by SHA-256. Licence follows VoxCeleb (verify in Phase 0). Alternative: NeMo TitaNet-small.                 |
| Audio decode      | ffmpeg inside the worker                                                                                                               | The worker fetches audio from Applaud over the existing ticketed `/media` URL and cuts only the requested windows. No ffmpeg on the NAS.                          |
| Job execution     | Queue in Applaud (SQLite-backed), concurrency 1, separate from the poller                                                              | If the worker is offline, jobs stay queued and retry with back-off (same pattern as webhook re-drive). The UI shows "speaker analysis pending".                   |
| Summary           | OpenRouter chat completions, model configurable                                                                                        | Provider routing restricted to zero-data-retention / no data collection (exact parameters verified in Phase 0).                                                   |
| Worker API        | `POST /embed` with recording media URL plus a list of `{segment_uid, start_ms, end_ms}`; returns one vector per segment and `model_id` | Authenticated with a shared secret and HMAC (same scheme as webhook signing). Worker stores nothing; voiceprints stay in Applaud's SQLite. Bound to the LAN only. |

## 3. Data model (one new migration)

```sql
-- People Applaud knows about
CREATE TABLE speakers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Voiceprints; only from confirmed labels or Plaud's owner tag
CREATE TABLE speaker_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  speaker_id INTEGER NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL,
  plaud_label TEXT NOT NULL,
  model_id TEXT NOT NULL,          -- re-embed required if the model changes
  vector BLOB NOT NULL,            -- Float32Array
  speech_ms INTEGER NOT NULL,
  source TEXT NOT NULL,            -- 'confirmed' | 'plaud_owner' | 'backfill'
  created_at INTEGER NOT NULL
);

-- Per recording, per Plaud label: who we think it is
CREATE TABLE recording_speakers (
  recording_id TEXT NOT NULL,
  plaud_label TEXT NOT NULL,       -- e.g. 'Speaker 1'
  speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL,
  status TEXT NOT NULL,            -- 'auto' | 'suggested' | 'unknown' | 'confirmed' | 'ignored'
  confidence REAL,
  centroid BLOB,
  model_id TEXT,
  outlier_segment_uids TEXT,       -- JSON array, for the UI
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recording_id, plaud_label)
);

-- Per-segment corrections (move a line to another speaker)
CREATE TABLE segment_overrides (
  recording_id TEXT NOT NULL,
  segment_uid TEXT NOT NULL,
  speaker_id INTEGER REFERENCES speakers(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recording_id, segment_uid)
);

ALTER TABLE recordings ADD COLUMN speakers_processed_at INTEGER;
ALTER TABLE recordings ADD COLUMN speakers_error TEXT;
ALTER TABLE recordings ADD COLUMN applaud_summary_at INTEGER;
```

Labels live in SQLite, not in `transcript.json`, so a Plaud re-fetch or manual resync cannot destroy them. Because they are keyed by `segment_uid`, they reapply cleanly to a re-fetched transcript.

## 4. Matching rules

1. Per Plaud label, take segments of at least 1.5 s, up to about 60 s of speech in total, spread across the recording. Embed each window.
2. Centroid = mean of embeddings after removing outliers (cosine to provisional centroid below a cut-off). Outlier segments are surfaced in the UI as "may be someone else".
3. Score each label against each known person (centroid of their stored voiceprints, plus best single voiceprint).
4. One-to-one assignment within a recording: two labels cannot both be auto-assigned to the same person (that indicates a split speaker and is surfaced as a merge suggestion).
5. Bands, calibrated in Phase 0 against real recordings:
   - **auto**: score ≥ `autoThreshold` and margin over second-best ≥ `minMargin`
   - **suggested**: score ≥ `suggestThreshold`
   - **unknown**: otherwise
   - Labels with under ~5 s of usable speech are never auto-assigned.
6. Plaud's owner tag is accepted as `confirmed` with `source = 'plaud_owner'`, overridable by the user.
7. Thresholds are settings with calibrated defaults, not hard-coded.

## 5. Phases

Sizes are relative (S / M / L), professional judgement, not evidenced effort.

### Phase 0: Spike and calibration (S)

**Progress (2026-10-15):**

- `sherpa-onnx-node@1.12.28` installs from npm with a prebuilt linux-x64 binary (32 MB). WeSpeaker ResNet34 and ResNet34-LM models download and load (256-dim). On a sandbox CPU: about 0.04× real time single-threaded, about 200 MB RSS, opus round-trip decode fine.
- On public test clips (2 to 8 s, mostly Mandarin), **single-clip scores overlap**: different speakers up to 0.88, same speaker down to 0.80. Short-clip identification is unreliable; per-label centroids over more speech, and thresholds calibrated on the user's own English recordings, are required. Not yet evidenced on real data.
- Calibration tool: [`spikes/speaker-calibration/`](../../spikes/speaker-calibration/README.md). Runs on the Portainer host against Applaud, using the owner's Plaud tag as ground truth. Verified end to end against a mock Applaud; the Docker image itself has not been built in the sandbox (no daemon).

- Stand up a throwaway worker container on the Portainer host (confirm the host has AVX) that fetches one real recording from Applaud and embeds its segment windows. Record throughput and memory.
- Install `sherpa-onnx-node` and `ffmpeg-static` under pnpm. Build the Docker image. Smoke-test the worker image on linux-x64.
- Embed segments from 10 to 20 real recordings. Measure throughput and memory on the Portainer host.
- Calibrate thresholds using the owner's Plaud-tagged segments as ground truth (same-person vs different-person score distributions).
- Verify the VoxCeleb model licence and the OpenRouter zero-data-retention routing parameters.
- **Go / no-go:** sherpa-onnx worker in Node, or the Python worker alternative if Node bindings or accuracy disappoint.

### Phase 1: Foundation (M)

- Migration (section 3), with tests in the existing migration test style.
- Model manager: download on enable, SHA-256 check, `model_id` recorded.
- `worker/` package and Docker image (ffmpeg, sherpa-onnx, model download with SHA-256 pin), plus a compose example for Portainer.
- `Embedder` interface in Applaud with the HTTP worker client, and a fake for tests. Settings: worker URL and shared secret (redacted like other secrets), with a Test button.
- Speaker job queue, triggered after `transcript_ready` and from a "Re-analyse speakers" action.
- Owner enrolment from Plaud-tagged segments. Backfill job over existing recordings: owner, plus any non-`Speaker N` names found in older transcripts.
- Settings: enable speaker identification (default off), thresholds.

### Phase 2: Matching and `-Applaud` transcript (M)

- Matcher (section 4), with unit tests for scoring, banding, one-to-one assignment and the short-speech guard.
- `transcript-Applaud.json`: the Plaud segments plus `segment_uid`, `plaud_speaker`, `speaker`, `speaker_id`, `label_status`, `confidence`.
- `transcript-Applaud.txt`: same line format as `transcript.txt`, so existing parsers and n8n code work unchanged.
- Regenerated atomically (`writeFileAtomic`) whenever labels change.
- API: `GET /api/recordings/:id/speakers`, `PUT /api/recordings/:id/speakers/:label`, `PUT /api/recordings/:id/segments/:uid/speaker`, `POST /api/recordings/:id/speakers/reanalyse`.

### Phase 3: Labelling UI and people management (L)

- **Speakers panel** on the recording detail page, one card per Plaud label:
  - status chip (auto / suggested / unknown / confirmed) with confidence
  - two or three representative clips, played through the existing audio element with a stop-at-end range
  - a name picker (existing people, or create new), with Confirm, Not sure and Ignore
  - "Merge with…" for split speakers
- **Transcript view toggle**: Plaud or Applaud labels. Per-segment "Assign to…" for corrections, with outlier segments highlighted.
- **People page** (under Settings): list, rename, merge two people, delete a person together with their voiceprints, and show the number of voiceprints and recordings for each.
- Dashboard indicator for recordings with unknown or suggested speakers ("needs labelling").

### Phase 4: Summary and integration (M)

- Settings: OpenRouter API key (redacted like the other secrets), model, prompt template, enable summary (default off), auto-generate when all speakers are resolved (default off).
- **Generate / Regenerate summary** button, enabled only when no unknown or suggested labels remain. Writes `summary-Applaud.md`.
- New webhook events `applaud_transcript_ready` and `applaud_summary_ready`, with the same payload shape plus the new files. Existing `(id, event)` idempotency applies.
- Update the n8n file-organisation template to write `<Title> - Transcript-Applaud.md` and `<Title> - Summary-Applaud.md`.

### Phase 5: Plaud write-back (M, depends on capture)

- **Prerequisite:** capture the web app's speaker-rename request (DevTools > Network, rename one speaker, save as HAR).
- `server/src/plaud/speakers.ts`: the single mutating call, isolated and tested against the captured fixture.
- `POST /api/recordings/:id/speakers/push`, also callable from n8n:
  - only confirmed labels, plus auto labels above a separate, higher write-back threshold
  - a dry-run mode that returns the planned changes
  - every write logged (previous and new value) so it can be undone
  - off by default, with per-recording and bulk modes
- Re-sync reconciliation: once Plaud returns names that Applaud wrote, treat them as confirmed rather than re-matching.
- Find out whether a rename triggers Plaud to regenerate its own summary (unknown).

## 6. Risks

| Risk                                                       | Likelihood    | Impact         | Mitigation                                                                          |
| ---------------------------------------------------------- | ------------- | -------------- | ----------------------------------------------------------------------------------- |
| sherpa-onnx Node bindings unsuitable in the worker         | Medium        | High           | Phase 0 go / no-go; Python worker alternative                                       |
| Plaud diarisation merges two people into one label         | Medium        | Medium         | Outlier segments, per-segment reassign, D6                                          |
| Cold start: only the owner is known                        | Certain       | Medium         | Fast labelling UI; expect 1 to 3 confirmations per new person                       |
| Wrong auto-label propagates (and is written back to Plaud) | Low to medium | High           | Margin rule, D6, higher write-back threshold, dry run, undo log                     |
| Plaud changes the undocumented API (read or write)         | Medium        | Medium to high | Isolated client module, fixture tests, write-back off by default                    |
| Voiceprints are biometric data                             | Certain       | Medium         | Local only, per-person deletion, never in webhooks or exports                       |
| Embedding model changed later                              | Low           | Medium         | `model_id` on every vector; re-embed job                                            |
| Worker offline (Portainer host down)                       | Medium        | Low            | Jobs stay queued with back-off; Plaud transcript and UI unaffected; "pending" shown |

## 7. Open items

| Item                                                                    | Owner | Needed by        |
| ----------------------------------------------------------------------- | ----- | ---------------- |
| Run the named-speaker scan over existing recordings (see conversation)  | User  | Phase 1 backfill |
| Capture the Plaud speaker-rename request (HAR)                          | User  | Phase 5          |
| Confirm VoxCeleb model licence                                          | Dev   | Phase 0          |
| Confirm OpenRouter ZDR / data-collection routing parameters             | Dev   | Phase 4          |
| Decide whether the default summary model sits on a ZDR-capable provider | User  | Phase 4          |
