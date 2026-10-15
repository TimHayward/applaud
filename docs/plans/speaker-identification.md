# Speaker identification, `-Applaud` outputs and Plaud write-back

|              |                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**   | Phase 0 complete (GO). Phase 1 ready to start.                                                                                                                                     |
| **Updated**  | 2026-10-15                                                                                                                                                                         |
| **Owner**    | Tim Hayward                                                                                                                                                                        |
| **Evidence** | Phase 0 calibration on 30 real recordings (Appendix A); tool in [`spikes/speaker-calibration/`](../../spikes/speaker-calibration/README.md) on branch `claude/nice-noether-fmry57` |

## 1. Summary

Plaud no longer recognises speakers other than the account owner. Applaud will take this over:

1. A separate **speaker worker** container turns each Plaud speaker's audio into a voiceprint using a local model (ERes2Net). Audio never leaves the local network.
2. **Applaud** keeps a library of named people and their voiceprints, matches each new recording's speakers against it, and labels them automatically when it is confident.
3. A **labelling panel** on the recording page lets the user confirm, correct or name speakers by listening to short clips.
4. Applaud writes a **`-Applaud` transcript** with the names applied and, once speakers are labelled, an alternative **`-Applaud` summary** via OpenRouter.
5. Later, confirmed names are **written back to Plaud** so they appear in Ask Plaud and the Plaud app.

The two containers can run on the same host or on different hosts. In this deployment Applaud stays on the Synology NAS and the worker runs on the Portainer host.

## 2. Scope

**In scope**

- Speaker identification across recordings, with automatic labels above a calibrated confidence and user confirmation below it.
- Labelling and correction UI on the recording page; people management.
- `transcript-Applaud.json`, `transcript-Applaud.txt`, `summary-Applaud.md` in each recording folder.
- Webhook events for the new outputs, and an updated n8n template.
- Guarded write-back of speaker names to Plaud (last phase).

**Out of scope**

- A second, independent transcription. Plaud's transcript and segmentation are trusted.
- Speaker identification by an LLM. Language models cannot recognise voices.
- Running speaker models on the NAS (see section 4).

## 3. Decisions

| #   | Decision                                                                                                                                                                         | Basis                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| D1  | No second transcription. Plaud's transcript and speaker segmentation are the source.                                                                                             | User decision                                                                 |
| D2  | Speaker identity comes from **local voice embeddings**, never an LLM.                                                                                                            | Technical constraint                                                          |
| D3  | Voiceprints are stored **only in Applaud's SQLite**. The worker is stateless. Recordings are private conversations.                                                              | User constraint (privacy)                                                     |
| D4  | Outputs live in the recording folder: `transcript-Applaud.json`, `transcript-Applaud.txt`, `summary-Applaud.md`.                                                                 | User decision                                                                 |
| D5  | The `-Applaud` summary is generated via OpenRouter **only after speakers are labelled**, plus a manual **Regenerate**. Transcript text only is sent, never audio.                | User decision                                                                 |
| D6  | Only **confirmed** labels (and Plaud's owner tag) create voiceprints. Automatic matches never feed the library.                                                                  | Prevents compounding errors                                                   |
| D7  | Write-back to Plaud is designed now and built last, off by default. It goes through Applaud (n8n can trigger it); the Plaud MCP is read-only.                                    | User decision; MCP has no write tools                                         |
| D8  | Labels are keyed by Plaud `segment_uid` and speaker label, with provenance, and stored outside `transcript.json`, so resyncs cannot destroy them and write-back needs no rework. | Design                                                                        |
| D9  | **Two containers**: Applaud and a separate speaker worker, deployable on the same host or on different hosts. Applaud owns all state; the worker only computes.                  | NAS has no AVX and little free memory; user requirement to separate workloads |
| D10 | Embedding model: **3D-Speaker ERes2Net (English, VoxCeleb)**, 192-dim. Fallback: NeMo TitaNet-large.                                                                             | Evidenced: Phase 0 (Appendix A)                                               |
| D11 | Each person keeps **several voiceprints**, at least one per Plaud scene type, and matching uses the best.                                                                        | Evidenced: owner scores drop across scene types                               |
| D12 | Plaud's speaker labels are treated as one person per label. Per-segment correction stays available, but is a secondary tool.                                                     | Evidenced: 0 of 60 `Speaker N` labels scored like the owner                   |

## 4. Deployment: two containers

### 4.1 Containers

| Container                | Image                                             | Role                                                                     | State                                                               | Resources                                                       |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `applaud`                | `ghcr.io/timhayward/applaud` (existing)           | Sync, UI, API, speaker library, matching, outputs, summary, write-back   | Config dir and SQLite (voiceprints included); recordings folder     | Unchanged: about 110 MB RAM, negligible CPU from this feature   |
| `applaud-speaker-worker` | `ghcr.io/timhayward/applaud-speaker-worker` (new) | Fetch audio, decode with ffmpeg, embed requested windows, return vectors | **None.** Temp audio in an ephemeral directory, deleted per request | About 300 to 400 MB RAM with ERes2Net; 2 CPU threads; needs AVX |

Both images are built from this repository and released with the same version tag. The worker lives in the monorepo as `worker/`.

### 4.2 Topologies

| Topology                          | When to use                                               | Worker URL in Applaud                                                                |
| --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Split hosts** (this deployment) | Applaud host is small or lacks AVX (e.g. Synology DS920+) | `http://<worker-host>:8091`                                                          |
| **Single host**                   | One capable Docker host runs everything                   | `http://applaud-speaker-worker:8091` on a private compose network, no published port |
| **Worker absent**                 | Speaker features not wanted                               | Not set. Applaud runs exactly as today; speaker features are hidden                  |

This deployment:

| Host                              | Container                | Measured                                                                               |
| --------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| Synology DS920+ (`192.168.0.117`) | `applaud`                | Celeron J4125, **no AVX**, 3.7 GB RAM with about 1 GB available and 2 GB swap in use   |
| Portainer host `bluedckr01`       | `applaud-speaker-worker` | AVX, 6 cores, 16 GB RAM with about 6 GB available; always on; reaches the NAS on 44471 |

### 4.3 Network flows

| From    | To      | Purpose                                              | Port            |
| ------- | ------- | ---------------------------------------------------- | --------------- |
| Applaud | Worker  | `POST /v1/embed`, `GET /health`                      | 8091 (worker)   |
| Worker  | Applaud | `GET /media/<folder>/<audio>` to fetch the recording | 44471 (Applaud) |

Both directions stay on the LAN. Nothing is exposed to the internet.

### 4.4 Security

- **Shared secret.** `WORKER_SECRET` (at least 32 characters) is set on both containers. Every Applaud → worker request is signed with HMAC-SHA256 over `<timestamp>.<body>` (the existing webhook signing scheme, `server/src/webhook/sign.ts`), sent as `X-Applaud-Timestamp` and `X-Applaud-Signature`. The worker rejects bad signatures and timestamps more than 5 minutes off.
- **Audio access.** When Applaud has a LAN token, it issues a short-lived, folder-scoped `/media` ticket (`issueTicket`, 15 minutes) for each request. The worker never holds the LAN token.
- **SSRF guard.** The worker only fetches audio from `APPLAUD_BASE_URL`, configured on the worker. Any other host is refused.
- **No retention.** The worker writes audio only to a temp directory, deletes it after each request, and never logs URLs, titles or transcript content.
- **Health.** `GET /health` is unauthenticated and returns only status, version and model id.

### 4.5 Configuration

**Worker** (environment):

| Variable           | Default  | Purpose                                                            |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `APPLAUD_BASE_URL` | required | Where audio may be fetched from, e.g. `http://192.168.0.117:44471` |
| `WORKER_SECRET`    | required | Shared HMAC secret                                                 |
| `PORT`             | `8091`   | Listen port                                                        |
| `NUM_THREADS`      | `2`      | ONNX Runtime threads                                               |
| `MAX_CONCURRENCY`  | `1`      | Parallel embed requests; extra requests get `429`                  |

**Applaud** (Settings → Speakers, stored in `settings.json`):

| Setting                                  | Default            | Notes                                                   |
| ---------------------------------------- | ------------------ | ------------------------------------------------------- |
| Enable speaker identification            | Off                |                                                         |
| Worker URL                               | empty              | **Test** button calls `/health` and a signed `/v1/ping` |
| Worker secret                            | empty              | Redacted in the config API like other secrets           |
| Auto threshold / margin / minimum speech | 0.75 / 0.10 / 20 s | Section 7                                               |
| Suggest threshold                        | 0.55               | Section 7                                               |

### 4.6 Compose files (Phase 1 deliverables)

- `docker-compose.yml`: Applaud only, unchanged.
- `deploy/worker.compose.yml`: the worker on its own, for the second host (Portainer stack).
- `deploy/single-host.compose.yml`: both containers with a private network.

## 5. Architecture

```
 NAS: applaud                                         Portainer host: applaud-speaker-worker
 ───────────────────────────────────────────          ─────────────────────────────────────
 Plaud sync → transcript.json + audio.*
        │
 speaker job queue (SQLite) ── POST /v1/embed ──────►  verify HMAC
        │      (audio URL + windows)                   GET /media/... (ticket) ◄── fetch audio
        │                                              ffmpeg → 16 kHz windows
        │                                              ERes2Net → vectors
        │  ◄────────────── vectors + model_id ──────── delete temp audio
        ▼
 per-label centroid → matcher (library, thresholds, one-to-one)
        │
 recording_speakers: auto | suggested | unknown | confirmed
        │                         │
 labelling panel (confirm ⇒ voiceprint)   transcript-Applaud.{json,txt}
                                          │
                       summary-Applaud.md (OpenRouter, after labelling)
                                          │
              webhooks: applaud_transcript_ready / applaud_summary_ready
                                          │
                          (Phase 5) write-back to Plaud
```

Jobs run one at a time, separate from the sync poller, so speaker analysis never delays sync. If the worker is unreachable, jobs wait and retry with back-off (the webhook re-drive pattern), and the recording page shows "speaker analysis pending".

## 6. Worker API (v1)

**`GET /health`** → `200 { "ok": true, "version": "…", "modelId": "3dspeaker_eres2net_en_voxceleb_16k@c5915837", "dim": 192, "busy": false }`

**`POST /v1/ping`** (signed) → `200 { "ok": true }`. Used by the Settings **Test** button to prove the secret matches.

**`POST /v1/embed`** (signed)

```json
{
  "requestId": "rec-7456…-1729000000",
  "audioUrl": "http://192.168.0.117:44471/media/<folder>/audio.ogg?ticket=…",
  "windows": [{ "id": "<segment_uid>", "startMs": 30, "endMs": 8270 }]
}
```

Response `200`:

```json
{
  "modelId": "3dspeaker_eres2net_en_voxceleb_16k@c5915837",
  "dim": 192,
  "audioSeconds": 3612.4,
  "elapsedMs": 9120,
  "vectors": [{ "id": "<segment_uid>", "vector": "<base64 float32 LE>" }],
  "skipped": [{ "id": "<segment_uid>", "reason": "too_short" }]
}
```

Errors: `400` invalid request, `401` bad signature or stale timestamp, `403` audio URL outside `APPLAUD_BASE_URL`, `422` audio fetch or decode failed (with a code), `429` busy (`Retry-After`), `500` unexpected.

Behaviour:

- The worker retries its own audio fetch up to 4 times with back-off. Applaud closes idle keep-alive connections after 5 s, which caused a failure in Phase 0.
- Applaud's client timeout is 10 minutes per request and it retries `429`, `5xx` and network errors with back-off.
- Applaud stores `modelId` with every vector. A different `modelId` from the worker means the library needs re-embedding; Applaud flags this rather than mixing vectors from different models.

## 7. Matching rules

1. **Windows.** Per Plaud label, take segments of at least 1.5 s, cut to at most 10 s each, up to about 60 s of speech, spread across the recording.
2. **Centroid.** Per label, the normalised mean of its window vectors.
3. **Profiles.** Each person has one profile per Plaud scene type (D11), built from confirmed voiceprints. A label's score for a person is the best score across that person's profiles.
4. **One-to-one.** Within a recording, two labels cannot both be auto-assigned to the same person; that pattern is surfaced as a merge suggestion.
5. **Bands** (ERes2Net, raw cosine; editable defaults):

   | Band          | Rule                                                                                          |
   | ------------- | --------------------------------------------------------------------------------------------- |
   | **auto**      | score ≥ 0.75, at least 0.10 ahead of the next-best person, and at least 20 s of usable speech |
   | **suggested** | score ≥ 0.55                                                                                  |
   | **unknown**   | otherwise                                                                                     |

   Basis (Appendix A): owner vs own profile min 0.806, p05 0.839; other people p95 0.645, max 0.823; single-recording enrolment same-speaker p05 0.705. New people therefore start as "suggested" and become "auto" as confirmed voiceprints accumulate.

6. **Owner.** Plaud's owner tag is accepted as confirmed (`source = 'plaud_owner'`), overridable by the user.

## 8. Data model (Applaud, one migration)

```sql
CREATE TABLE speakers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Voiceprints: only from confirmed labels or Plaud's owner tag (D6)
CREATE TABLE speaker_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  speaker_id INTEGER NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL,
  plaud_label TEXT NOT NULL,
  scene TEXT,                      -- Plaud scene code (D11)
  model_id TEXT NOT NULL,
  vector BLOB NOT NULL,            -- Float32Array
  speech_ms INTEGER NOT NULL,
  source TEXT NOT NULL,            -- 'confirmed' | 'plaud_owner' | 'backfill'
  created_at INTEGER NOT NULL
);

-- Per recording, per Plaud label: who it is
CREATE TABLE recording_speakers (
  recording_id TEXT NOT NULL,
  plaud_label TEXT NOT NULL,
  speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL,
  status TEXT NOT NULL,            -- 'auto' | 'suggested' | 'unknown' | 'confirmed' | 'ignored'
  confidence REAL,
  margin REAL,
  speech_ms INTEGER,
  centroid BLOB,
  model_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recording_id, plaud_label)
);

-- Per-segment corrections
CREATE TABLE segment_overrides (
  recording_id TEXT NOT NULL,
  segment_uid TEXT NOT NULL,
  speaker_id INTEGER REFERENCES speakers(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recording_id, segment_uid)
);

-- Work queue for the worker
CREATE TABLE speaker_jobs (
  recording_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,            -- 'queued' | 'running' | 'done' | 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE recordings ADD COLUMN speakers_processed_at INTEGER;
ALTER TABLE recordings ADD COLUMN applaud_summary_at INTEGER;
```

Voiceprints are never included in webhooks, exports or API responses. Deleting a person deletes their voiceprints.

## 9. Outputs and integration

| Output                             | Content                                                                                                   | When                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `transcript-Applaud.json`          | Plaud segments plus `segment_uid`, `plaud_speaker`, `speaker`, `speaker_id`, `label_status`, `confidence` | After analysis; rewritten atomically whenever labels change           |
| `transcript-Applaud.txt`           | Same line format as `transcript.txt`, with Applaud names                                                  | As above                                                              |
| `summary-Applaud.md`               | Alternative summary using speaker names, via OpenRouter                                                   | Only once no unknown or suggested labels remain, or on **Regenerate** |
| Webhook `applaud_transcript_ready` | Existing payload shape plus the new files                                                                 | When the `-Applaud` transcript is first written or changes            |
| Webhook `applaud_summary_ready`    | Existing payload shape plus the summary                                                                   | When the summary is written                                           |
| n8n template                       | Writes `<Title> - Transcript-Applaud.md` and `<Title> - Summary-Applaud.md`                               | Phase 4                                                               |

OpenRouter receives transcript text only, routed to providers with no data retention or collection. The summary is off by default.

## 10. Phases

Sizes are relative (S / M / L), professional judgement rather than evidenced effort.

### Phase 0: Spike and calibration (S) — complete

Model, worker host and thresholds selected on real recordings. See Appendix A.

### Phase 1: Two-container foundation (M)

- `worker/` package: HTTP server, HMAC verification, SSRF guard, audio fetch with retries, ffmpeg decode, ERes2Net embedding, `/health`, `/v1/ping`, `/v1/embed`.
- Worker Docker image with ERes2Net baked in and SHA-256 pinned; release workflow builds and publishes it alongside Applaud.
- Compose files (section 4.6) and a Portainer section in the README.
- Applaud: migration (section 8), `Embedder` interface with the HTTP worker client and a fake for tests, Speakers settings with **Test**.
- Job queue: triggered after `transcript_ready` and by "Re-analyse speakers"; back-off when the worker is down.
- Owner enrolment from Plaud-tagged segments, and a backfill over existing recordings.

**Done when:** both containers run in the split topology; a recording's labels are embedded and stored; stopping the worker leaves Applaud unaffected and the job resumes when it returns; worker and client have unit tests; the single-host compose also works.

### Phase 2: Matching and `-Applaud` transcript (M)

- Matcher (section 7) with unit tests for scoring, banding, margin, minimum speech, one-to-one and per-scene profiles.
- `transcript-Applaud.json` / `.txt` (section 9).
- API: `GET /api/recordings/:id/speakers`, `PUT /api/recordings/:id/speakers/:label`, `PUT /api/recordings/:id/segments/:uid/speaker`, `POST /api/recordings/:id/speakers/reanalyse`.

**Done when:** the owner is auto-labelled on new recordings; a confirmed person is suggested or auto-labelled in their next recording; outputs regenerate on every label change.

### Phase 3: Labelling UI and people management (L)

- Speakers panel on the recording page, one card per Plaud label: status and confidence, two or three clips played through the existing player, a name picker (existing or new), Confirm / Not sure / Ignore, and "Merge with…".
- Transcript view toggle (Plaud or Applaud names) with per-segment "Assign to…".
- People page under Settings: list, rename, merge, delete with voiceprints, counts per person.
- "Needs labelling" indicator on the dashboard.

**Done when:** an unknown speaker can be named from clips in under a minute, and the name is applied to the transcript and library.

### Phase 4: Summary and integration (M)

- OpenRouter settings (key redacted, model, prompt, off by default); Generate / Regenerate.
- Webhook events and n8n template (section 9).

**Done when:** the summary is produced only after labelling, uses names, and reaches the n8n flow.

### Phase 5: Plaud write-back (M, depends on capture)

- Prerequisite: capture the Plaud web app's speaker-rename request (browser DevTools, saved as HAR).
- `server/src/plaud/speakers.ts`: the single mutating call, isolated and tested against the captured fixture.
- `POST /api/recordings/:id/speakers/push`, callable from n8n: confirmed labels plus auto labels above a stricter threshold, dry-run mode, an undo log, off by default, per-recording and bulk.
- Reconcile on resync: names Applaud wrote are treated as confirmed.

**Done when:** a dry run shows the planned changes, a push renames speakers in Plaud, and the log can reverse it.

## 11. Risks

| Risk                                               | Likelihood    | Impact         | Mitigation                                                                                     |
| -------------------------------------------------- | ------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| Wrong auto-label (and later written back to Plaud) | Low to medium | High           | Margin and minimum-speech rules, D6, stricter write-back threshold, dry run, undo log          |
| Thresholds do not generalise beyond the owner      | Medium        | Medium         | Suggested band with confirmation; recalibrate with the spike once several people are confirmed |
| Worker host unavailable                            | Medium        | Low            | Jobs queue with back-off; Applaud unaffected; "pending" shown                                  |
| Shared secret leaked or mismatched                 | Low           | Medium         | HMAC with timestamp; SSRF guard; LAN only; Test button                                         |
| Plaud changes its undocumented API (read or write) | Medium        | Medium to high | Isolated client modules, fixture tests, write-back off by default                              |
| Plaud merges two people into one label             | Low to medium | Medium         | Per-segment reassign; merge suggestions                                                        |
| Embedding model changed later                      | Low           | Medium         | `modelId` on every vector; re-embed job                                                        |
| Voiceprints are biometric data                     | Certain       | Medium         | Applaud only, never exported, per-person deletion                                              |
| Cold start: only the owner known                   | Certain       | Low            | Fast labelling; new people move from suggested to auto after one to three confirmations        |

## 12. Open items

| Item                                                                                            | Owner      | Needed by        |
| ----------------------------------------------------------------------------------------------- | ---------- | ---------------- |
| Confirm ERes2Net model card licence terms                                                       | Dev        | Phase 1          |
| Confirm what Plaud scene codes `1` and `102` mean (call vs in-person?)                          | Dev / User | Phase 2          |
| Run the named-speaker scan over existing recordings, to seed people beyond the owner            | User       | Phase 1 backfill |
| Confirm OpenRouter zero-data-retention routing parameters, and choose the default summary model | Dev / User | Phase 4          |
| Capture the Plaud speaker-rename request (HAR)                                                  | User       | Phase 5          |

## Appendix A: Phase 0 evidence (2026-10-15)

**Environment.** The NAS has no AVX and about 1 GB of free memory with 2 GB of swap in use, so speaker models cannot run there (D9). `sherpa-onnx-node@1.12.28` runs on the Portainer host with prebuilt linux-x64 binaries.

**Method.** The calibration spike fetched recordings from Applaud over the LAN, embedded up to 60 s of speech per Plaud label, and used the owner's Plaud tag as ground truth. The main test, "library profile", builds the owner's voiceprint from the other 29 recordings and scores each recording's labels against it, as the feature will work. Output was numbers only.

**Run 1** (WeSpeaker ResNet34-LM, 20 recordings, 11.2 h): EER 0.31 to 0.34, not improving with more speech. Run 2 showed this was the model, not the data.

**Run 2** (five models, 30 recordings, 15.2 h, 60 other-speaker labels):

| Model                 | EER       | EER 10 s | EER 30 s | EER AS-norm | Single-recording EER | Embed time | Owner segments scoring like others |
| --------------------- | --------- | -------- | -------- | ----------- | -------------------- | ---------- | ---------------------------------- |
| **ERes2Net**          | **0.017** | 0.067    | 0.019    | 0.017       | **0.022**            | 124 s      | 1 / 295                            |
| TitaNet-large         | 0.033     | 0.067    | 0.019    | 0.017       | 0.035                | 116 s      | 3 / 295                            |
| TitaNet-small         | 0.033     | 0.067    | 0.019    | 0.033       | 0.051                | 42 s       | 5 / 295                            |
| CAM++                 | 0.067     | 0.200    | 0.103    | 0.050       | 0.182                | 42 s       | 25 / 295                           |
| WeSpeaker ResNet34-LM | 0.200     | 0.200    | 0.207    | 0.200       | 0.322                | 97 s       | 54 / 295                           |

**Findings**

- ERes2Net separates best: owner vs own profile min 0.806; other people p95 0.645, max 0.823.
- Plaud's labels are clean: with ERes2Net and TitaNet, 0 of 60 `Speaker N` labels scored like the owner (D12).
- More speech helps: EER 0.067 at 10 s, 0.019 at 30 s (minimum 20 s for auto).
- Scene matters: owner same-scene median 0.836, cross-scene 0.773 (D11). Codes seen: `1` (7 recordings) and `102` (23).
- Plaud `serial_number` is not a stable device id (25 values in 30 recordings).
- Resources: ERes2Net embeds about 8 s per hour of audio on 2 threads; about 300 MB with one model loaded.

**Limits.** 30 owner trials and 60 impostor labels, so 0.017 is a single error. Only the owner was tested as a target. The suggested band and user confirmation cover this uncertainty.
