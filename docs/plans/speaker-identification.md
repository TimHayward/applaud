# Speaker identification and `-Applaud` transcripts

|               |                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**    | Phase 0 complete (GO). Phase 1 verified on the Portainer host (PR #3). Phase 2 built on `speakers/phase-2`; awaiting verification on the host (section 10).                                                                                   |
| **Updated**   | 2026-10-29                                                                                                                                                                                                                               |
| **Owner**     | Tim Hayward                                                                                                                                                                                                                              |
| **Evidence**  | Phase 0 calibration on 30 real recordings (Appendix A). The calibration tool lived on branch `claude/nice-noether-fmry57`, which no longer exists; see section 13.                                                                       |
| **Prior art** | [`mcowger/olive2`](https://github.com/mcowger/olive2) reviewed 2026-10-19 (Appendix B)                                                                                                                                                   |
| **Revisions** | 2026-10-19: two-container design. 2026-10-29: single container (D9 replaced, D15, D16 added), segment fields checked on the deployment (section 6.3), owner from the Plaud nickname (D17), summary and write-back deferred (section 11). |

## 1. Summary

Plaud no longer recognises speakers other than the account owner. Applaud will take this over, inside its own container:

1. A **speaker process** in the Applaud container turns each Plaud speaker's audio into a voiceprint using a local model (ERes2Net). Audio never leaves the container.
2. **Applaud** keeps a library of named people and their voiceprints, matches each new recording's speakers against it, and labels them automatically when it is confident.
3. A **labelling panel** on the recording page lets the user confirm, correct or name speakers by listening to short clips.
4. Applaud writes a **`-Applaud` transcript** with the names applied.

The feature is optional. On a host that cannot run the model (no AVX, too little memory, an unsupported architecture), Applaud detects this, hides the feature and runs exactly as it does today.

## 2. Scope

**In scope**

- Speaker identification across recordings, with automatic labels above a calibrated confidence and user confirmation below it.
- Labelling and correction UI on the recording page; people management.
- `transcript-Applaud.json` and `transcript-Applaud.txt` in each recording folder.

**Deferred** (designed, not scheduled; section 11)

- An alternative `-Applaud` summary via OpenRouter, new webhook events and the n8n template.
- Write-back of speaker names to Plaud.

**Out of scope**

- A second, independent transcription. Plaud's transcript and segmentation are trusted.
- Speaker identification by an LLM. Language models cannot recognise voices.
- A separate worker container (section 4.4).

## 3. Decisions

| #   | Decision                                                                                                                                                                                                                                                       | Basis                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D1  | No second transcription. Plaud's transcript and speaker segmentation are the source.                                                                                                                                                                           | User decision                                                                          |
| D2  | Speaker identity comes from **local voice embeddings**, never an LLM.                                                                                                                                                                                          | Technical constraint                                                                   |
| D3  | Voiceprints are stored **only in Applaud's SQLite**. Audio and voiceprints never leave the container. Recordings are private conversations.                                                                                                                    | User constraint (privacy)                                                              |
| D4  | Outputs live in the recording folder: `transcript-Applaud.json`, `transcript-Applaud.txt`.                                                                                                                                                                     | User decision                                                                          |
| D5  | _Deferred:_ the `-Applaud` summary via OpenRouter (section 11).                                                                                                                                                                                                | User decision 2026-10-29                                                               |
| D6  | Only **confirmed** labels (and Plaud's owner tag) create voiceprints. Automatic matches never feed the library.                                                                                                                                                | Prevents compounding errors                                                            |
| D7  | _Deferred:_ write-back to Plaud (section 11).                                                                                                                                                                                                                  | User decision 2026-10-29                                                               |
| D8  | A recording's speaker is keyed by Plaud's **`original_speaker`** (the diarisation label, unchanged by renames in the Plaud app). A segment is keyed by its **`segment_uid`**, falling back to `t<start_time>` for a segment without one. Labels are stored outside `transcript.json`, so resyncs cannot destroy them. | Evidenced on the deployment (section 6.3)                                              |
| D9  | **One container.** Applaud and the speaker model ship in the same image and run on the same host. There is no worker container, no worker API and no shared secret.                                                                                          | User decision 2026-10-29; the hosting moved from the NAS to a capable Portainer host   |
| D10 | Embedding model: **3D-Speaker ERes2Net (English, VoxCeleb)**, 192-dim, run by `sherpa-onnx-node`. **Baked into the image**, pinned by SHA-256. Fallback: NeMo TitaNet-large.                                                                                   | Evidenced: Phase 0 (Appendix A); user decision on delivery                             |
| D11 | Each person keeps **up to 12 voiceprints**, one per confirmed recording (that label's centroid). A label's score for a person is the **best match** across them. The Plaud scene code is stored as metadata only.                                              | Evidenced: single-recording EER 0.022 (Appendix A); same pattern in Olive (Appendix B) |
| D12 | Plaud's speaker labels are treated as one person per label. Per-segment correction stays available, but is a secondary tool.                                                                                                                                   | Evidenced: 0 of 60 `Speaker N` labels scored like the owner                            |
| D13 | **Library hygiene**: one anchor voiceprint per person that is never evicted, a cap with eviction, near-duplicate skip, a minimum speech length, and a warning when a confirmed voiceprint does not resemble the person's existing ones (section 7.1).          | Adopted from Olive, made stricter by D6                                                |
| D14 | Voiceprints store **source references** (recording, Plaud label, segment keys), never audio copies. A model change re-embeds every voiceprint from the original audio.                                                                                  | Privacy (D3); Olive keeps WAV clips instead, which we reject                           |
| D15 | The model runs in a **child process** of Applaud, started on demand and stopped when idle, never in Applaud's main process. A crash, an illegal instruction or an out-of-memory kill in native code takes down only the child.                                 | Crash isolation, responsiveness and memory (section 4.1)                               |
| D16 | **Any host, feature optional.** One image for every host. A capability check decides whether speaker identification is available; where it is not, the feature is hidden and Applaud is unaffected.                                                          | User decision 2026-10-29                                                               |
| D17 | The **owner** is the label whose `speaker` equals the Plaud account's `nickname`, overridable in Settings → Speakers by choosing from the non-generic `speaker` values seen. `original_speaker` never names the owner.                                         | Evidenced: all 87 `original_speaker` values are generic (section 6.3)                  |

## 4. Deployment: one container

### 4.1 Processes

| Process                    | Started by                                                | Role                                                                                       | State                                               | Resources                                                          |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------ |
| Applaud (`node server/dist/index.js`) | `tini`, as today                                 | Sync, UI, API, speaker library, matching, outputs, job queue, supervisor of the child     | Config dir and SQLite (voiceprints included); recordings folder | Unchanged: about 110 MB RAM                               |
| Speaker process            | Applaud, with `child_process.fork`, when a job is waiting | Decode audio with ffmpeg, embed requested windows, return vectors over IPC                  | **None.** ffmpeg decodes into memory and only the requested windows are kept; nothing is written to disk | About 200 MB measured on Windows with the model loaded (up to 400 MB allowed for); `APPLAUD_SPEAKER_THREADS` CPU threads (default 2) |

Why a child process rather than Applaud's own process or a `worker_thread`:

- **Crash isolation.** ONNX Runtime is native code. On a CPU without AVX it can die with `SIGILL`, and under a container memory limit the kernel kills the largest process. In a thread either would take Applaud down; in a child only the child dies.
- **Responsiveness.** Embedding is synchronous CPU work (about 8 s per hour of audio, Appendix A). It never blocks Applaud's request handling or sync.
- **Memory.** The model's memory is returned to the host when the child exits after an idle period, so the container sits near today's footprint between jobs.

### 4.2 Image

Changes to the existing `Dockerfile` (still `node:22-slim`, Debian with glibc, which `sherpa-onnx-node`'s prebuilt binaries need):

- Install `ffmpeg` with `--no-install-recommends` in the runtime stage.
- Add `sherpa-onnx-node` as a server dependency. Its native package is per platform; the build must succeed on `linux/arm64` even if the feature turns out to be unavailable there at runtime (section 4.3).
- Download the ERes2Net `.onnx` file in the build stage, verify its SHA-256, and copy it to `/app/models/`. A hash mismatch fails the build.
- Record the size increase in the Phase 1 PR. It has not been measured; expect tens of MB for the model plus ffmpeg's dependencies.

The release workflow keeps building `linux/amd64` and `linux/arm64` from the same Dockerfile. There is no second image.

### 4.3 Capability check

When speaker identification is switched on, and on each start while it is on, Applaud starts the speaker process and asks it to embed one second of silence.

| Result                                          | Status shown in Settings → Speakers         | Effect                                            |
| ----------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Vector returned with the expected `modelId` and `dim` | **Available**, with model id and timing | Jobs run                                          |
| Child exits with a signal (`SIGILL`, `SIGKILL`) | **Not supported on this host**, with the reason (CPU instruction set, memory) | Jobs stay queued; nothing else changes |
| Native module fails to load                     | **Not supported on this host** (platform)   | As above                                          |
| Timeout                                         | **Unavailable**, with a Retry button        | As above                                          |

The check result is cached in memory for the process lifetime and re-run on **Retry** or a restart. Its outcome is never fatal to Applaud.

### 4.4 Why not a separate worker container

The two-container design (revision of 2026-10-19) existed because the NAS had no AVX and about 1 GB of free memory. Applaud now runs on a Portainer host with AVX and enough memory, so the separation bought complexity (an HTTP API, HMAC secret, SSRF guard, `/media` tickets, a second image and three compose files) without a need. The `Embedder` interface (section 6.1) keeps a remote implementation possible if a constrained host ever needs one again.

### 4.5 Configuration

**Environment** (optional):

| Variable                   | Default | Purpose                                                    |
| -------------------------- | ------- | ---------------------------------------------------------- |
| `APPLAUD_SPEAKER_THREADS`  | `2`     | ONNX Runtime threads in the speaker process                |
| `APPLAUD_SPEAKER_IDLE_SEC` | `300`   | Stop the speaker process after this long with no work      |

**Applaud** (Settings → Speakers, stored in `settings.json`):

| Setting                                  | Default            | Notes                                       |
| ---------------------------------------- | ------------------ | ------------------------------------------- |
| Enable speaker identification            | Off                | Runs the capability check (section 4.3)     |
| Status                                   | read only          | Available / not supported / unavailable, model id, last job |
| Auto threshold / margin / minimum speech | 0.75 / 0.10 / 20 s | Section 7                                   |
| Suggest threshold                        | 0.55               | Section 7                                   |

`docs/portainer.md` gains a "Speaker identification" section: memory headroom (about 400 MB more while jobs run), an optional `mem_limit` for the stack and what happens when it is too low, and the AVX requirement on x86.

## 5. Architecture

```
 Applaud container
 ──────────────────────────────────────────────────────────────────────────────
 Plaud sync → transcript.json + audio.*
        │
 speaker job queue (SQLite)
        │
 supervisor ── fork on demand ──► speaker process
        │      IPC: { audioPath, windows }      ffmpeg → 16 kHz PCM (temp dir)
        │                                       ERes2Net → vectors
        │  ◄── IPC: { modelId, dim, vectors } ── delete temp audio; exit when idle
        ▼
 per-label centroid → matcher (library, thresholds, one-to-one)
        │
 recording_speakers: auto | suggested | unknown | confirmed
        │                         │
 labelling panel (confirm ⇒ voiceprint)   transcript-Applaud.{json,txt}
```

Jobs run one at a time, separate from the sync poller, so speaker analysis never delays sync. If the speaker process crashes, the job is retried with back-off (the webhook re-drive pattern); after three crashes in a row the capability check is re-run, and the recording page shows "speaker analysis pending".

## 6. Speaker process

### 6.1 `Embedder` interface

```ts
interface Embedder {
  health(): Promise<{ ok: boolean; modelId: string; dim: number; reason?: string }>;
  embed(req: {
    audioPath: string;                                   // absolute, inside the recordings dir
    windows: { id: string; startMs: number; endMs: number }[];
  }): Promise<{
    modelId: string;
    dim: number;
    audioSeconds: number;
    elapsedMs: number;
    vectors: { id: string; vector: Float32Array }[];
    skipped: { id: string; reason: "too_short" | "out_of_range" }[];
  }>;
}
```

Implementations: `LocalEmbedder` (the supervisor and child process below) and `FakeEmbedder` (deterministic vectors, for tests). Window ids are segment keys (D8).

### 6.2 Supervisor and IPC

- **Start.** `child_process.fork("server/dist/speakers/embedder-process.js")` with `serialization: "advanced"` so `Float32Array` crosses IPC without base64. Environment is limited to what the child needs.
- **Requests.** One in flight at a time, each with a request id. Timeout 10 minutes per request; on timeout the child is killed and the job retried.
- **Path guard.** The supervisor resolves `audioPath` and refuses anything outside the configured recordings directory. The child only reads the file it is given.
- **Idle stop.** The child exits after `APPLAUD_SPEAKER_IDLE_SEC` with no request, and on Applaud shutdown (`SIGTERM` forwarded).
- **Crash handling.** An exit during a request fails that request with the exit code or signal; the job is retried with back-off. A `SIGILL` or a failed native load marks the feature as not supported (section 4.3).
- **No retention.** The child streams ffmpeg's decoded audio through memory, keeps only the requested windows, writes nothing to disk, and never logs paths, titles or transcript content. Job errors stored or logged by Applaud carry no file paths either (recording folder names contain titles).

### 6.3 Plaud segment fields

Checked on 2026-10-29 with a read-only, counts-only scan of every `transcript.json` on the Portainer deployment (25 recordings, 6,297 segments):

| Finding                                                                                     | Consequence                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Every segment has `segment_uid`, `start_time`, `end_time`, `content`, `speaker`, `original_speaker` | `segment_uid` is the segment key (D8). The test fixture in `server/src/sync/poller.test.ts` omits it and is updated in Phase 1 |
| `start_time` is a number and unique within every recording (0 duplicates)                   | `t<start_time>` is a safe fallback key                 |
| Latest segment end per recording ranges from 31,950 to 6,044,400                            | Timings are milliseconds (32 s to 101 min)             |
| All 87 distinct `original_speaker` values are generic (`Speaker N`); none are names         | `original_speaker` is the stable label (D8)            |
| `speaker` differs from `original_speaker` in 1,828 segments                                 | Renames (the owner tag and any manual renames in Plaud) show only in `speaker`; the owner comes from it (D17) |

The scan cannot tell which files were written through the official API and which through the legacy API before Plaud 4.0, so normalisation keeps the fallback key rather than assuming `segment_uid` is always present.

### 6.4 Model change

Applaud stores `modelId` with every vector and records the active model. When the speaker process reports a different `modelId` (a new image with a new model), Applaud queues a re-embed job for every voiceprint from its source references (D14) and pauses matching until it finishes, so vectors from different models are never compared.

## 7. Matching rules

1. **Windows.** Per Plaud label, take segments of at least 1.5 s, cut to at most 10 s each, up to about 60 s of speech, spread across the recording.
2. **Centroid.** Per label, the normalised mean of its window vectors.
3. **Best of N.** A label's score for a person is its best cosine score across that person's voiceprints (D11). The margin rule compares the best person with the next-best person.
4. **One-to-one.** Within a recording, two labels cannot both be auto-assigned to the same person; that pattern is surfaced as a merge suggestion.
5. **Bands** (ERes2Net, raw cosine; editable defaults):

   | Band          | Rule                                                                                          |
   | ------------- | --------------------------------------------------------------------------------------------- |
   | **auto**      | score ≥ 0.75, at least 0.10 ahead of the next-best person, and at least 20 s of usable speech |
   | **suggested** | score ≥ 0.55                                                                                  |
   | **unknown**   | otherwise                                                                                     |

   Basis (Appendix A): owner vs own profile min 0.806, p05 0.839; other people p95 0.645, max 0.823; single-recording enrolment same-speaker p05 0.705. New people therefore start as "suggested" and become "auto" as confirmed voiceprints accumulate.

6. **Owner.** The owner's label (D17) is accepted as confirmed (`source = 'plaud_owner'`), overridable by the user.
7. **Placeholders are not people.** A single shared helper decides whether a label is generic (`Speaker 1`, `SPEAKER_00`, `S1`, `Unknown`, `UU`, empty). Generic labels are never stored as people or offered as match targets.

### 7.1 Library hygiene (D6, D13)

| Rule                        | Value                                                                                                                                                                                              | Why                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Who can create a voiceprint | Confirmed labels and Plaud's owner tag only (D6)                                                                                                                                                   | Automatic matches never feed the library                         |
| Minimum speech              | 20 s of usable speech in the label                                                                                                                                                                 | Below this, EER rises (0.067 at 10 s)                            |
| Anchor                      | The first confirmed voiceprint per person; never evicted                                                                                                                                           | Keeps a stable reference if later voiceprints drift              |
| Cap                         | 12 per person; when full, evict the oldest non-anchor                                                                                                                                              | Bounds matching cost; keeps the library current                  |
| Near-duplicate              | Skip if it scores above 0.95 against an existing voiceprint of that person                                                                                                                         | Adds nothing; keeps room for varied conditions                   |
| Low resemblance             | If a confirmed voiceprint scores below 0.55 against all of that person's voiceprints, accept it (the user confirmed it) but flag it on the People page as "doesn't sound like previous recordings" | Catches mistaken confirmations without discarding real variation |

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
  plaud_label TEXT NOT NULL,       -- Plaud original_speaker (D8)
  segment_keys TEXT NOT NULL,      -- JSON array of segment keys (D8): source references for re-embedding (D14)
  scene TEXT,                      -- Plaud scene code, metadata only
  is_anchor INTEGER NOT NULL DEFAULT 0,
  model_id TEXT NOT NULL,
  vector BLOB NOT NULL,            -- Float32Array
  speech_ms INTEGER NOT NULL,
  source TEXT NOT NULL,            -- 'confirmed' | 'plaud_owner' | 'backfill'
  low_resemblance INTEGER NOT NULL DEFAULT 0,  -- section 7.1
  created_at INTEGER NOT NULL,
  UNIQUE (speaker_id, recording_id, plaud_label)
);

-- Per recording, per Plaud label: who it is. The centroid and its source
-- segments are kept so a later confirmation needs no re-embedding.
CREATE TABLE recording_speakers (
  recording_id TEXT NOT NULL,
  plaud_label TEXT NOT NULL,       -- Plaud original_speaker (D8)
  plaud_name TEXT,                 -- Plaud speaker for most of the label's segments (D17)
  speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL,
  status TEXT NOT NULL,            -- 'auto' | 'suggested' | 'unknown' | 'confirmed' | 'ignored'
  assigned_by TEXT,                -- provenance: 'plaud_owner' | 'user' | 'matcher'
  confidence REAL,
  margin REAL,
  speech_ms INTEGER,
  segment_keys TEXT,               -- JSON array: the windows the centroid was built from
  centroid BLOB,
  model_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recording_id, plaud_label)
);

-- Per-segment corrections
CREATE TABLE segment_overrides (
  recording_id TEXT NOT NULL,
  segment_key TEXT NOT NULL,       -- segment_uid, or t<start_time> (D8)
  speaker_id INTEGER REFERENCES speakers(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recording_id, segment_key)
);

-- Work queue for the speaker process; (kind, recording_id) is the de-duplication key
CREATE TABLE speaker_jobs (
  kind TEXT NOT NULL,              -- 'analyse' | 'reembed'
  recording_id TEXT NOT NULL,
  status TEXT NOT NULL,            -- 'queued' | 'running' | 'done' | 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, recording_id)
);

ALTER TABLE recordings ADD COLUMN speakers_processed_at INTEGER;
```

The active embedding model id is stored with the speaker settings and compared with the speaker process's `modelId` (section 6.4). Voiceprints are never included in webhooks, exports or API responses. Deleting a person deletes their voiceprints.

## 9. Outputs

| Output                    | Content                                                                                                       | When                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `transcript-Applaud.json` | An array of segments: `segment_key`, `start_time` and `end_time` (milliseconds), `content`, `speaker` (Applaud's name), `speaker_id`, `plaud_speaker` (Plaud's `speaker`), `original_speaker`, `label_status`, `confidence`; plus `suggested_speaker` on suggestions and `segment_override` on segments assigned on their own | After analysis; rewritten atomically whenever labels, names or thresholds change, and only when the content differs |
| `transcript-Applaud.txt`  | Same line format as `transcript.txt`, with Applaud names                                                      | As above                                                    |

`speaker` is the person's name for confirmed and automatic labels and for segment overrides; otherwise it is Plaud's name, so a suggestion never reads as fact. Both files are served by `/media` like the other recording files and appear under the recording's attachments, so existing webhook consumers can fetch them by path. New webhook events are deferred with the summary (section 11).

## 10. Phases

Sizes are relative (S / M / L), professional judgement rather than evidenced effort.

### Phase 0: Spike and calibration (S) — complete

Model and thresholds selected on real recordings. See Appendix A. The host findings that led to two containers no longer apply (D9).

### Phase 1: Single-container foundation (M)

- **First:** confirm the ERes2Net model card licence (section 13); it can change the model choice. (Segment fields: done, section 6.3.)
- Add `segment_uid` to `TranscriptSegment` and the poller test fixture.
- Owner detection from the Plaud `nickname`, with the Settings override (D17).
- Image changes (section 4.2): ffmpeg, `sherpa-onnx-node`, the model baked in and SHA-256 pinned; both release architectures still build. Record the image size before and after.
- `server/src/speakers/embedder-process.ts`: IPC handler, ffmpeg decode to a temp dir, ERes2Net embedding, temp cleanup.
- Supervisor and `LocalEmbedder` (section 6.2), `FakeEmbedder`, path guard, idle stop, crash handling.
- Capability check and Settings → Speakers status (section 4.3, 4.5).
- Migration (section 8).
- Job queue: triggered after `transcript_ready` and by "Re-analyse speakers"; de-duplication on `(kind, recording_id)`; back-off on crashes; a failed job keeps Plaud's labels untouched. Matching is skipped while the library holds only the owner, but label centroids are still stored so later matching needs no re-embedding.
- Owner enrolment from Plaud-tagged segments, and a backfill over existing recordings that have audio on disk. Recordings shown as _details only_ are skipped until their audio is downloaded.
- Shared `isGenericSpeakerLabel` helper in `shared/` (section 7, rule 7), with tests for every placeholder form.
- Plaud transcript normalisation before embedding, with tests: detect seconds vs milliseconds timings, map a missing speaker to `UU` (skipped), drop segments whose end is not after their start.
- Model-change detection and the `reembed` job (section 6.4).
- Move the calibration tool from the spike branch to `tools/speaker-calibration/`, reading audio from a local recordings directory, so it can be rerun (Phase 3 exit check, future model changes).
- `docs/portainer.md`: "Speaker identification" section (section 4.5).

**Phase 1 record (2026-10-29).** Built and tested locally, then run in the container on the Portainer host.

| Item | State |
| --- | --- |
| Segment fields; model licence (Apache-2.0, per ModelScope); `linux-arm64` build of `sherpa-onnx-node` (published) | Done |
| Speaker process, supervisor, capability check, migration v5, job queue, owner enrolment, backfill, model-change re-embedding, generic-label helper, transcript normalisation | Done, with unit tests (552 tests pass) |
| Image: ffmpeg, `sherpa-onnx-node` 1.12.28 with its native packages pinned to the same version, model baked in and SHA-256 checked | Done; built by Portainer from the branch (linux-x64). `docker-compose.yml` gained `pull_policy: build`, because Portainer's re-pull asked Docker Hub for `applaud:local` and failed the redeploy |
| Settings card: on/off, status, Check again, owner name | Done |
| End-to-end on the built server (Windows) with the real model: enable, analyse, owner enrolment, force-killing the speaker process and recovering | Done |
| In the container on the Portainer host: capability check, backfill, owner enrolment | Done. Status Available with model `…@c5915837`. 28 of 28 analyse jobs done, none failed or retried. 99 labels: 26 confirmed as the owner from the Plaud account name, 73 unknown (Phase 2's input). 12 owner voiceprints (one anchor and the cap of 12 reached), each from 60 to 69 s of speech, none flagged low resemblance |
| Image size before and after | Not measured |
| Move the calibration tool to `tools/` | Not done: the spike branch was deleted (section 13) |

Differences from the plan above:

- **No temp files.** ffmpeg decodes straight into memory and only the windows are kept (section 6.2).
- **Library hygiene moved forward from Phase 2.** Owner enrolment creates voiceprints in Phase 1, so the anchor, cap, near-duplicate and low-resemblance rules (section 7.1) were needed now.
- **Owner choice in Settings.** It is not known whether Plaud tags the owner with the account nickname or with the name on their Plaud voice profile, so Settings lists the names Plaud has used, with recording counts, and the owner picks theirs (D17). Changing it relabels from stored centroids and undoes labels made from the previous name, without re-running the model.
- **Threshold settings** are stored with their defaults but not yet editable in the UI; they first matter in Phase 2.
- **Re-analysis** is triggered when a transcript is written, by a backfill after every sync (for audio that arrives after its transcript), and by `POST /api/recordings/:id/speakers/reanalyse`. The button for it is part of the Phase 3 panel.

**Done when:** in one container on the Portainer host, a recording's labels are embedded and stored; killing the speaker process mid-job leaves Applaud serving requests and the job completes on retry; the idle child exits and its memory is released; a simulated model change re-embeds the library from source references; the capability check reports "not supported" when the native module cannot load (tested by pointing it at a missing module); the supervisor, process protocol and queue have unit tests.

### Phase 2: Matching and `-Applaud` transcript (M)

- Matcher (section 7) with unit tests for best-of-N scoring, banding, margin, minimum speech and one-to-one assignment.
- `transcript-Applaud.json` / `.txt` (section 9).
- API: `GET /api/recordings/:id/speakers`, `PUT /api/recordings/:id/speakers/:label`, `PUT /api/recordings/:id/segments/:segmentKey/speaker`, `POST /api/recordings/:id/speakers/reanalyse`.

**Done when:** the owner is auto-labelled on new recordings; a confirmed person is suggested or auto-labelled in their next recording; outputs regenerate on every label change.

**Phase 2 record (2026-10-29).** Built on branch `speakers/phase-2`, stacked on Phase 1; 582 tests pass. Not yet run on the Portainer host.

| Item | State |
| --- | --- |
| Matcher: best of N, bands, margin (against zero when only one person is known), minimum speech, one-to-one, and no automatic label for a person already confirmed in the recording | Done, with unit tests |
| Re-matching from stored centroids, with no model run, after each analysis, label change, owner change, threshold change and model activation; only labels the user or Plaud's owner tag have not decided are touched | Done |
| `transcript-Applaud.json` / `.txt`, written for every analysed recording on start (covering those analysed in Phase 1) | Done |
| API: `GET /api/recordings/:id/speakers` (labels with their top three candidates, overrides, people; never vectors), `PUT …/speakers/:label` (`confirmed` with a person id or name, `ignored`, `unknown` to hand back to matching), `PUT …/segments/:segmentKey/speaker`, `GET /api/speakers/people` | Done, with route tests |
| Thresholds editable in Settings, validated (each in range, suggestion not above automatic), with Restore defaults | Done |

Differences from the plan above:

- **Library hygiene** was built in Phase 1 (see its record). Phase 2 adds anchor promotion: when a person's anchor voiceprint is removed (its label relabelled, ignored or reset), their oldest remaining voiceprint becomes the anchor.
- **Re-matching is global and synchronous.** Every analysed recording is re-matched when the library changes. This is fast at personal scale (stored 192-dimension centroids, at most 12 voiceprints per person). If it ever shows up in response times, it can move onto the job queue.
- **Resetting a label Plaud tagged as the owner** hands it back to the owner tag, not to the matcher. Ignoring it keeps it out of both.
- **Per-segment overrides** never create voiceprints (D6, D12).

### Phase 3: Labelling UI and people management (L)

- Speakers panel on the recording page, one card per Plaud label: status and confidence, two or three clips played through the existing player, a name picker (existing or new), Confirm / Not sure / Ignore, and "Merge with…".
- Transcript view toggle (Plaud or Applaud names) with per-segment "Assign to…".
- People page under Settings: list, rename, merge, delete with voiceprints, counts per person.
- "Needs labelling" indicator on the dashboard.
- Clip selection for each card: rank the label's segments by length (best around 8 s, useful between 3 and 12 s) and word count, pick up to five at least 20 s apart, and fill from the remaining ranked segments in short recordings.
- **Generalisation recalibration.** Extend the calibration tool to read confirmed labels from Applaud and treat every confirmed person, not just the owner, as a target. Run it once at least 10 people beyond the owner have two or more confirmed recordings each. Confirm or adjust the thresholds in section 7 and record the result in Appendix A.

**Done when:** an unknown speaker can be named from clips in under a minute, and the name is applied to the transcript and library; the generalisation recalibration has run and its thresholds are applied.

## 11. Deferred

Kept here so the design is not lost. Neither is scheduled; each would be re-planned against the code as it stands when picked up.

**`-Applaud` summary and integration** (previously Phase 4). A summary that uses speaker names, generated via OpenRouter only once no unknown or suggested labels remain, plus a manual Regenerate. Transcript text only, never audio, routed to providers with no data retention. Off by default; key redacted in the config API. New webhook events `applaud_transcript_ready` and `applaud_summary_ready`, and an n8n template writing `<Title> - Transcript-Applaud.md` and `<Title> - Summary-Applaud.md`. Would add `recordings.applaud_summary_at`.

**Write-back to Plaud** (previously Phase 5). Confirmed names pushed to Plaud so they appear in Ask Plaud and the Plaud app. Prerequisite: find whether Plaud's official developer API can rename speakers; failing that, capture the web app's rename request. Design: one isolated mutating call, dry run, undo log, off by default, and precondition guards (`expectedPlaudLabel`, `expectedName`) checked against a fresh read immediately before writing, so a label changed in Plaud is skipped rather than overwritten.

## 12. Risks

| Risk                                                     | Likelihood    | Impact | Mitigation                                                                                                     |
| -------------------------------------------------------- | ------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| Wrong auto-label                                         | Low to medium | Medium | Margin and minimum-speech rules, D6, confirmation UI                                                           |
| Thresholds do not generalise beyond the owner            | Medium        | Medium | Suggested band with confirmation; generalisation recalibration is a Phase 3 exit check                        |
| Native code crashes or is killed for memory              | Low           | Low    | Child process (D15); retry with back-off; capability re-check; Applaud unaffected                             |
| Container memory limit too low for the model             | Low to medium | Low    | Child is the one killed; status shows the reason; `docs/portainer.md` gives the headroom                      |
| `sherpa-onnx-node` has no working build for an architecture | Medium (arm64) | Low | Capability check hides the feature (D16); the build must not fail on that platform                           |
| Image grows for users who never enable the feature       | Certain       | Low    | Size measured and stated in the Phase 1 PR; accepted for offline, reproducible model delivery (D10)          |
| Plaud segment fields change                              | Low to medium | Medium | Checked on the deployment (section 6.3); normalisation layer with tests; `t<start_time>` fallback key         |
| Owner's Plaud nickname differs from the name Plaud tags them with | Low   | Low    | Settings override (D17)                                                                                        |
| User confirms the wrong name                             | Low to medium | Medium | Low-resemblance flag (section 7.1); per-person voiceprint list with delete                                     |
| Plaud merges two people into one label                   | Low to medium | Medium | Per-segment reassign; merge suggestions                                                                        |
| Embedding model changed later                            | Low           | Medium | `modelId` on every vector; automatic re-embed from source references (D14)                                    |
| Voiceprints are biometric data                           | Certain       | Medium | Applaud's SQLite only, never exported, per-person deletion                                                     |
| Cold start: only the owner known                         | Certain       | Low    | Fast labelling; new people move from suggested to auto after one to three confirmations                        |

## 13. Open items

| Item                                                                                                       | Owner | Needed by          |
| ---------------------------------------------------------------------------------------------------------- | ----- | ------------------ |
| Record the image size on the Portainer host (Phase 1's other container checks passed, section 10)           | User  | Phase 1 PR        |
| Recreate the calibration tool in `tools/speaker-calibration/` (the spike branch holding it was deleted), reading audio and labels from a local recordings folder | Dev   | Phase 3 recalibration |
| Run the named-speaker scan over existing recordings, to seed people beyond the owner                       | User  | Phase 3            |

## Appendix A: Phase 0 evidence (2026-10-15)

**Environment at the time.** The NAS had no AVX and about 1 GB of free memory with 2 GB of swap in use, so speaker models could not run there; this drove the earlier two-container design. Applaud now runs on the Portainer host, which has AVX (D9). `sherpa-onnx-node@1.12.28` runs on that host with prebuilt linux-x64 binaries.

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
- Scene matters: owner same-scene median 0.836, cross-scene 0.773. Codes seen: `1` (7 recordings) and `102` (23). D11 handles this by keeping several voiceprints per person rather than modelling scenes explicitly.
- Plaud `serial_number` is not a stable device id (25 values in 30 recordings).
- Resources: ERes2Net embeds about 8 s per hour of audio on 2 threads; about 300 MB with one model loaded.

**Limits.** 30 owner trials and 60 impostor labels, so 0.017 is a single error. Only the owner was tested as a target. The suggested band and user confirmation cover this uncertainty. Phase 0 ran against the legacy Plaud API, before the move to the official API; the audio is the same, so the model results stand. Segment fields were re-checked on 2026-10-29 (section 6.3).

## Appendix B: Prior art, `mcowger/olive2` (reviewed 2026-10-19)

[Olive](https://github.com/mcowger/olive2) (MIT, commit `35980b2`) is a self-hosted meeting archive that also ingests Plaud recordings and names speakers with local voiceprints. It independently uses the same core approach as this plan: trust Plaud's speaker turns, embed each label's longest turns, and match with a threshold, a margin and one-to-one assignment.

**Adopted**

| Practice in Olive                                                                              | Where it lands here                                 |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Several trusted voiceprints per person, best score wins                                        | D11                                                 |
| Anchor, cap with eviction, near-duplicate skip, clip length limits                             | D13, section 7.1                                    |
| Model tag stored; library rebuilt when the model changes                                       | D14, section 6.4                                    |
| Durable job with a per-recording de-duplication key; keep Plaud labels on failure              | Phase 1                                             |
| Shared generic-label classifier: "an unidentified cluster is not a person"                     | Section 7 rule 7, Phase 1                           |
| Plaud segment normalisation (seconds vs milliseconds, missing speaker, bad timings) with tests | Phase 1                                             |
| Ranked, spread-out clip selection for enrolment                                                | Phase 3                                             |
| A committed evaluation harness whose results lock the defaults                                 | Phase 3 recalibration; `tools/speaker-calibration/` |
| Use of Plaud's official developer API                                                          | Done in Plaud 4.0; segment keys follow it (D8)      |
| Single container                                                                               | D9 (since 2026-10-29), with the model in a child process (D15) and a much smaller model |
| Write tools off by default, dry run, `expected…` precondition guards                           | Deferred write-back design (section 11)             |

**Not adopted**

| Practice in Olive                                    | Reason                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Thresholds 0.45 / margin 0.06                        | Specific to WeSpeaker ResNet293, set on 36 AMI headset utterances from 4 speakers; ours come from 30 Plaud recordings (Appendix A) |
| Automatic voiceprint adoption with outlier rejection | D6 is stricter: only confirmed labels enrol                                                                                        |
| Storing enrolment clips as WAV files                 | Keeps third-party audio in a second place; D14 re-embeds from the original audio instead                                          |
| About 4.5 GB of models in the image                  | ERes2Net meets the bar at a small fraction of the size (D10)                                                                       |
| WeSpeaker ResNet293                                  | Not needed while ERes2Net meets the bar; first alternative if accuracy for people other than the owner disappoints                 |
| Speaker library export and import                    | Conflicts with D3 (voiceprints never exported)                                                                                     |
