# Speaker calibration spike (Phase 0)

Throwaway tool for [docs/plans/speaker-identification.md](../../docs/plans/speaker-identification.md), Phase 0. It answers one question with your own recordings: **how well does a local speaker model tell the account owner apart from everyone else, and how much speech does it need?**

Plaud still tags the account owner by name, so the owner's segments are ground truth. The tool:

1. lists recordings from a running Applaud (`/api/recordings`);
2. reads each `transcript.json` and downloads the audio over `/media`;
3. embeds up to 60 s of speech per Plaud speaker label, in windows of 1.5 to 10 s;
4. compares owner-vs-owner (same person, across recordings) with owner-vs-others (different people).

It prints **numbers only**: no transcript text, no audio and no names other than the owner's. Audio is decoded to a temp directory and deleted per recording. Nothing is written back to Applaud.

## Run it on the Portainer host (not the NAS)

```bash
git clone -b claude/nice-noether-fmry57 https://github.com/TimHayward/applaud.git
cd applaud/spikes/speaker-calibration
docker build -t applaud-speaker-calibration .

docker run --rm \
  -e APPLAUD_URL=http://<nas-ip>:44471 \
  -e APPLAUD_TOKEN=<lan-token> \
  applaud-speaker-calibration
```

The LAN token is the one Applaud printed to its container log on first start (Settings → LAN Access).

Optional environment variables:

| Variable         | Default       | Purpose                                                          |
| ---------------- | ------------- | ---------------------------------------------------------------- |
| `MAX_RECORDINGS` | `20`          | Usable recordings to process (newest first)                      |
| `OWNER`          | auto-detected | The owner's name as Plaud tags it, if auto-detection picks wrong |
| `NUM_THREADS`    | `2`           | ONNX Runtime threads                                             |

A recording is used only if it has the owner and at least one `Speaker N` label, each with at least 10 s of usable speech.

## Reading the output

All scores are cosine similarity (higher means more alike).

| Field                                     | Meaning                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `A_ownerVsOwner_sameSpeaker`              | Owner's voice in one recording vs another. Should be high.                                   |
| `B_ownerVsOthers_differentSpeaker`        | Owner vs other people. Should be low.                                                        |
| `C_othersVsOthers_mixed`                  | Other people across recordings. A cluster of high values suggests recurring speakers.        |
| `centroidEER`                             | Equal error rate and the threshold that achieves it, using about 60 s per label.             |
| `speechNeededPerLabel`                    | The same comparison using only the first 5 / 10 / 20 / 30 / 60 s of speech per label.        |
| `singleSegment`                           | Individual segments vs the owner's voiceprint. Shows whether per-segment outlier flags work. |
| `peakRssMB`, `embedSeconds`, `audioHours` | Resource use, for sizing the worker.                                                         |

Paste the JSON back into the planning conversation. Thresholds for auto / suggested / unknown will be set from the A and B distributions.
