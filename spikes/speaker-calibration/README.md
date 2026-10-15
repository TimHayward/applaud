# Speaker calibration spike (Phase 0)

Throwaway tool for [docs/plans/speaker-identification.md](../../docs/plans/speaker-identification.md), Phase 0. It answers one question with your own recordings: **how well does a local speaker model tell the account owner apart from everyone else, and how much speech does it need?**

Plaud still tags the account owner by name, so the owner's segments are ground truth. The tool:

1. lists recordings from a running Applaud (`/api/recordings`);
2. reads each `transcript.json` and downloads the audio over `/media`;
3. embeds up to 60 s of speech per Plaud speaker label, in windows of 1.5 to 10 s;
4. compares owner-vs-owner (same person, across recordings) with owner-vs-others (different people).

It prints **numbers only**: no transcript text, no audio and no names other than the owner's. Audio is decoded to a temp directory and deleted per recording. Nothing is written back to Applaud.

## Run it on the Portainer host (not the NAS)

### Option A: Portainer stack from Git (recommended)

1. **Stacks → Add stack**. Name: `speaker-calibration`.
2. Build method: **Repository**.
   - Repository URL: `https://github.com/TimHayward/applaud`
   - Repository reference: `refs/heads/claude/nice-noether-fmry57`
   - Compose path: `spikes/speaker-calibration/docker-compose.yml`
   - Authentication: off (the repository is public). GitOps updates: off.
3. **Environment variables**: add `APPLAUD_URL` = `http://<nas-ip>:44471`. Use the NAS IP, not a hostname. Add `APPLAUD_TOKEN` only if Applaud has a LAN token; leave it out otherwise.
4. **Deploy the stack**. The first deploy builds the image (ffmpeg, the speaker library and a 26 MB model), which takes a few minutes.
5. Open **Containers → applaud-speaker-calibration → Logs**. The container runs once, prints a JSON block, then stops (status "exited" is expected). Typical run time is a few minutes for 20 recordings.
6. Copy the JSON from the logs and paste it back. Then delete the stack (and the `applaud-speaker-calibration:spike` image under **Images**).

To re-run with different settings, edit the stack's environment variables and select **Update the stack**, or start the stopped container again.

### Option B: command line on the host

```bash
git clone -b claude/nice-noether-fmry57 https://github.com/TimHayward/applaud.git
cd applaud/spikes/speaker-calibration
docker build -t applaud-speaker-calibration .
docker run --rm -e APPLAUD_URL=http://<nas-ip>:44471 applaud-speaker-calibration
```

Add `-e APPLAUD_TOKEN=<lan-token>` if Applaud has a LAN token (Settings → LAN Access).

Optional environment variables:

| Variable         | Default       | Purpose                                                          |
| ---------------- | ------------- | ---------------------------------------------------------------- |
| `MAX_RECORDINGS` | `30`          | Usable recordings to process (newest first)                      |
| `OWNER`          | auto-detected | The owner's name as Plaud tags it, if auto-detection picks wrong |
| `NUM_THREADS`    | `2`           | ONNX Runtime threads                                             |

A recording is used only if it has the owner and at least one `Speaker N` label, each with at least 10 s of usable speech.

## Reading the output (version 2)

Version 2 embeds the same audio with five models and reports each separately under `models`. All scores are cosine similarity (higher means more alike) except `eerAsNorm`, which is on a normalised scale. EER is the equal error rate: lower is better, and `0.05 at 0.62` means about 5 % errors either way using a threshold of 0.62.

| Field                                     | Meaning                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libraryProfile`                          | **The main result.** Your voiceprint built from every other recording, scored against each recording's labels, as the feature will work in practice. `eer10s` / `eer30s` use only the first 10 or 30 s of speech per label. `eerAsNorm` applies cohort score normalisation, which corrects for recording conditions. |
| `pairwise`                                | One recording against another. `differentWithinRecording` vs `differentCrossRecording` shows how much sharing a room and microphone inflates scores.                                                                                                                                                                 |
| `ownerSameSpeakerByCondition`             | Your voice across recordings on the same device or scene vs different ones. A large gap means conditions, not voices, are driving scores.                                                                                                                                                                            |
| `plaudLabelQuality`                       | `Speaker N` labels that score like you, and segments under your name that score like other people. High counts mean Plaud attributed speech to the wrong label, which contaminates ground truth.                                                                                                                     |
| `recordingsByDevice`, `recordingsByScene` | Anonymised device ids and Plaud scene codes in the sample.                                                                                                                                                                                                                                                           |
| `peakRssMB`, `embedSeconds`, `audioHours` | Resource use, for sizing the worker.                                                                                                                                                                                                                                                                                 |

`MODELS=titanet_large,campplus` limits the run to models whose file name contains those strings. `MAX_RECORDINGS` defaults to 30.

Paste the JSON back into the planning conversation.
