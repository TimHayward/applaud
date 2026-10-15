# Speaker identification, `-Applaud` outputs and Plaud write-back

Status: **Agreed scope, ready for Phase 0** (2026-10-14)

## 1. Context

Plaud has removed automatic speaker recognition. In a current transcript only the account owner is named; every other participant arrives as `Speaker N` (sample of 497 segments: `Tim Hayward` 294, `Speaker 1` 195, `Speaker 3` 8; `speaker === original_speaker` in every segment). Manual renaming in the Plaud web app still works.

Recordings are consumed through several routes: Ask Plaud, Obsidian (via n8n), and Copilot / Cowork. Speaker names therefore need to exist both in Applaud's outputs and, eventually, back in Plaud itself.

### Decisions

| #   | Decision                                                                                                                                                                                    | Basis                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| D1  | No second transcription. Plaud's transcript and segmentation are trusted.                                                                                                                   | User decision                                                                   |
| D2  | Speaker identification uses **local voice embeddings**, never an LLM. LLMs cannot recognise voices.                                                                                         | Technical constraint                                                            |
| D3  | Voiceprints are stored **locally only** (SQLite). Recordings are private conversations.                                                                                                     | User constraint (privacy)                                                       |
| D4  | Outputs live in the recording folder: `transcript-Applaud.json`, `transcript-Applaud.txt`, `summary-Applaud.md`.                                                                            | User accepted                                                                   |
| D5  | The `-Applaud` summary is generated via OpenRouter **only after speakers are labelled**, plus a manual **Regenerate** button. Transcript text only is sent; audio never leaves the machine. | User decision                                                                   |
| D6  | Only **confirmed** labels (or Plaud's own owner tag) enrol voiceprints. Auto-matches never feed the library.                                                                                | Prevents compounding errors                                                     |
| D7  | Write-back to Plaud is **designed for now, built last** (Phase 5), behind explicit opt-in. The Plaud MCP is read-only, so write-back goes through Applaud, which n8n can trigger.           | User decision; MCP has no write tools                                           |
| D8  | Labels are keyed by Plaud `segment_uid` and Plaud speaker label, with provenance, so write-back needs no rework.                                                                            | Enables D7                                                                      |
| D9  | Voice embedding runs in a **separate worker container on the Portainer host**, not on the NAS. The NAS has no AVX and is already under memory pressure (see Target environment).            | Evidenced: NAS measurements 2026-10-15                                          |
| D10 | Embedding model: **3D-Speaker ERes2Net (English, VoxCeleb)**, 192-dim. TitaNet-large is the fallback.                                                                                       | Evidenced: Phase 0 run 2 (best library-profile and single-recording separation) |
| D11 | Each person keeps **several voiceprints** (at least one per Plaud scene type) and matching uses the best, not one averaged centroid.                                                        | Evidenced: owner scores drop across scene types                                 |

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

| Component         | Choice                                                                                                                                                                          | Notes                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embedding runtime | Worker container on the Portainer host running `sherpa-onnx-node` (Apache-2.0)                                                                                                  | Same language and toolchain as Applaud (lives in the monorepo as `worker/`). A Python worker (SpeechBrain ECAPA) remains an alternative if accuracy needs it.              |
| Embedding model   | 3D-Speaker ERes2Net, English VoxCeleb (`3dspeaker_speech_eres2net_sv_en_voxceleb_16k`), ~26 MB ONNX, SHA-256 `c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5` | Baked into the worker image. Selected in Phase 0 (D10). Licence: 3D-Speaker code is Apache-2.0; confirm the model card terms before release. Fallback: NeMo TitaNet-large. |
| Audio decode      | ffmpeg inside the worker                                                                                                                                                        | The worker fetches audio from Applaud over the existing ticketed `/media` URL and cuts only the requested windows. No ffmpeg on the NAS.                                   |
| Job execution     | Queue in Applaud (SQLite-backed), concurrency 1, separate from the poller                                                                                                       | If the worker is offline, jobs stay queued and retry with back-off (same pattern as webhook re-drive). The UI shows "speaker analysis pending".                            |
| Summary           | OpenRouter chat completions, model configurable                                                                                                                                 | Provider routing restricted to zero-data-retention / no data collection (exact parameters verified in Phase 0).                                                            |
| Worker API        | `POST /embed` with recording media URL plus a list of `{segment_uid, start_ms, end_ms}`; returns one vector per segment and `model_id`                                          | Authenticated with a shared secret and HMAC (same scheme as webhook signing). Worker stores nothing; voiceprints stay in Applaud's SQLite. Bound to the LAN only.          |

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
5. Bands, calibrated in Phase 0 (ERes2Net, raw cosine; defaults, editable in Settings):
   - **auto**: score ≥ 0.75, margin over the next-best person ≥ 0.10, and at least 20 s of usable speech
   - **suggested**: score ≥ 0.55
   - **unknown**: otherwise
   - Basis: owner vs own library profile min 0.806 / p05 0.839; other people p95 0.645 / max 0.823; single-recording enrolment same-speaker p05 0.705. New people therefore start as "suggested" and move to "auto" as confirmed voiceprints accumulate.
6. Plaud's owner tag is accepted as `confirmed` with `source = 'plaud_owner'`, overridable by the user.
7. Thresholds are settings with calibrated defaults, not hard-coded.

## 5. Phases

Sizes are relative (S / M / L), professional judgement, not evidenced effort.

### Phase 0: Spike and calibration (S) — complete

**Progress (2026-10-15):**

- `sherpa-onnx-node@1.12.28` installs from npm with a prebuilt linux-x64 binary (32 MB). WeSpeaker ResNet34 and ResNet34-LM models download and load (256-dim). On a sandbox CPU: about 0.04× real time single-threaded, about 200 MB RSS, opus round-trip decode fine.
- On public test clips (2 to 8 s, mostly Mandarin), **single-clip scores overlap**: different speakers up to 0.88, same speaker down to 0.80. Short-clip identification is unreliable; per-label centroids over more speech, and thresholds calibrated on the user's own English recordings, are required. Not yet evidenced on real data.
- Calibration tool: [`spikes/speaker-calibration/`](../../spikes/speaker-calibration/README.md). Runs on the Portainer host against Applaud, using the owner's Plaud tag as ground truth. Verified end to end against a mock Applaud; the Docker image itself has not been built in the sandbox (no daemon).
- **Run 1 on real data (2026-10-15, WeSpeaker ResNet34-LM, 20 recordings, 11.2 h audio, Portainer host):**
  - Resources are not a constraint: 69 s of embedding for 11.2 h of audio (2 threads), 247 MB peak RSS, 210 s end to end.
  - Separation is **not good enough for automatic labelling**: owner-vs-owner median 0.922 vs owner-vs-others median 0.815, but heavy overlap (others p95 0.949, max 0.977); EER 0.31 to 0.34 at every speech amount.
  - More speech did not help (EER 0.316 at 5 s, 0.341 at 60 s). That is the opposite of normal behaviour and points to noisy labels (Plaud attributing the owner's speech to `Speaker N`, or the reverse) and/or recording-condition effects, rather than the model alone. Inference, not yet evidenced.
  - 83 of 103 inspected recordings lacked both the owner and another speaker with 10 s or more.
- **Run 2 (2026-10-15, five models, 30 recordings, 15.2 h, 60 other-speaker labels):** library-profile EER (owner voiceprint from the other 29 recordings):

  | Model                 | EER       | EER 10 s | EER 30 s | EER AS-norm | Single-recording EER | Embed time | Owner segs like others |
  | --------------------- | --------- | -------- | -------- | ----------- | -------------------- | ---------- | ---------------------- |
  | **ERes2Net**          | **0.017** | 0.067    | 0.019    | 0.017       | **0.022**            | 124 s      | 1 / 295                |
  | TitaNet-large         | 0.033     | 0.067    | 0.019    | 0.017       | 0.035                | 116 s      | 3 / 295                |
  | TitaNet-small         | 0.033     | 0.067    | 0.019    | 0.033       | 0.051                | 42 s       | 5 / 295                |
  | CAM++                 | 0.067     | 0.200    | 0.103    | 0.050       | 0.182                | 42 s       | 25 / 295               |
  | WeSpeaker ResNet34-LM | 0.200     | 0.200    | 0.207    | 0.200       | 0.322                | 97 s       | 54 / 295               |
  - **Run 1's poor result was the model, not the data.** With ERes2Net and TitaNet, 0 of 60 `Speaker N` labels score like the owner, so Plaud's labels are clean enough to train from.
  - More speech helps (10 s → 30 s: EER 0.067 → 0.019), so auto-labelling requires at least 20 s.
  - Scene matters: owner same-scene median 0.836 vs cross-scene 0.773 (ERes2Net). Scene codes seen: `1` (7) and `102` (23); meaning not yet confirmed.
  - Plaud `serial_number` is **not a stable device id** (25 values across 30 recordings), so the device analysis is not meaningful.
  - Limits: 30 owner trials and 60 impostor labels, so 0.017 is one error; only the owner was tested as a target.
  - Resources: one model loaded is about 300 MB; ERes2Net embeds about 8 s per hour of audio on 2 threads.

- **Phase 0 outcome: GO** for automatic labelling with ERes2Net, the margin rule and user confirmation for the suggested band (D10, D11).
