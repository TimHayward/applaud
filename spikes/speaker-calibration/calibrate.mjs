// Phase 0 calibration spike for speaker identification.
//
// Pulls recordings from a running Applaud, embeds each Plaud speaker's
// segments with a local speaker model, and reports how well the account
// owner (whom Plaud still tags by name) separates from everyone else.
// Prints numbers only: no transcript text, no audio, no names other than
// the owner's. Temporary audio is deleted as it goes.

import { execFileSync } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sherpa from "sherpa-onnx-node";

const APPLAUD_URL = (process.env.APPLAUD_URL ?? "").replace(/\/+$/, "");
const APPLAUD_TOKEN = process.env.APPLAUD_TOKEN ?? "";
const MODEL = process.env.MODEL ?? "/app/model.onnx";
const MAX_RECORDINGS = Number(process.env.MAX_RECORDINGS ?? 20);
const NUM_THREADS = Number(process.env.NUM_THREADS ?? 2);
let OWNER = process.env.OWNER ?? "";

process.on("uncaughtException", (err) => {
  // Node's fetch hides the real network error (ECONNREFUSED, ENOTFOUND...) in `cause`.
  const cause = err?.cause
    ? ` (${err.cause.code ?? ""} ${err.cause.message ?? ""})`.replace("( ", "(")
    : "";
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}${cause}`);
  process.exit(1);
});

const NETWORK_HINTS = {
  ECONNREFUSED:
    "Nothing is listening at that address and port. Is Applaud running there, and is it bound to 0.0.0.0 rather than 127.0.0.1 (a non-Docker install binds 127.0.0.1 by default)?",
  ENOTFOUND: "The hostname did not resolve inside the container. Use the NAS IP address instead.",
  EAI_AGAIN: "The hostname did not resolve inside the container. Use the NAS IP address instead.",
  ETIMEDOUT:
    "No response. Check the IP, the NAS firewall, and that the Docker network can route to the NAS subnet.",
  UND_ERR_CONNECT_TIMEOUT:
    "No response. Check the IP, the NAS firewall, and that the Docker network can route to the NAS subnet.",
  EHOSTUNREACH:
    "No route to the NAS from inside the container. A Docker network subnet may overlap your LAN.",
  ENETUNREACH:
    "No route to the NAS from inside the container. A Docker network subnet may overlap your LAN.",
  ECONNRESET: "The connection was reset. If APPLAUD_URL starts with https://, try http:// instead.",
};

const SAMPLE_RATE = 16000;
const MIN_SEGMENT_S = 1.5;
const MAX_WINDOW_S = 10;
const MAX_SPEECH_PER_LABEL_S = 60;
const MIN_SPEECH_PER_LABEL_S = 10;
const GENERIC_LABEL = /^speaker\s*\d+$/i;

if (!APPLAUD_URL) {
  console.error(
    "Set APPLAUD_URL, e.g. http://192.168.0.10:44471 (and APPLAUD_TOKEN if a LAN token is set).",
  );
  process.exit(2);
}

const headers = APPLAUD_TOKEN ? { Authorization: `Bearer ${APPLAUD_TOKEN}` } : {};
const mediaUrl = (folder, name) =>
  `${APPLAUD_URL}/media/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Error text without the URL, which contains the recording title.
const errText = (err) =>
  (err?.cause?.code ?? err?.message ?? String(err)).toString().replace(/ for https?:\/\/\S+/, "");

/**
 * Run `fn` with retries on network errors and 5xx. Applaud closes idle keep-alive
 * connections after 5 s and embedding takes longer, so an occasional reused-socket
 * failure ("other side closed") is expected and harmless on retry.
 */
async function withRetry(fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err?.noRetry || i >= attempts) throw err;
      await sleep(1000 * 2 ** (i - 1));
    }
  }
}

async function fetchOk(url) {
  const res = await fetch(url, { headers });
  if (res.status === 401) {
    const err = new Error(
      `401 Unauthorized for ${url}. Applaud has a LAN token set; pass it as APPLAUD_TOKEN.`,
    );
    err.noRetry = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} for ${url}`);
    err.noRetry = res.status < 500;
    throw err;
  }
  return res;
}

const getJson = (url) => withRetry(async () => (await fetchOk(url)).json());

/** Stream a file to disk rather than buffering it, so long recordings don't spike memory. */
const download = (url, dest) =>
  withRetry(async () => {
    const res = await fetchOk(url);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  });

/** Decode any audio file to raw 16 kHz mono float32 on disk; returns the path. */
function decodeToPcm(src, dest) {
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    src,
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-f",
    "f32le",
    dest,
  ]);
  return dest;
}

/** Read [startS, endS) from a raw float32 PCM file without loading the whole file. */
function readWindow(fd, totalSamples, startS, endS) {
  const from = Math.max(0, Math.floor(startS * SAMPLE_RATE));
  const to = Math.min(totalSamples, Math.floor(endS * SAMPLE_RATE));
  if (to <= from) return null;
  const buf = Buffer.alloc((to - from) * 4);
  readSync(fd, buf, 0, buf.length, from * 4);
  return new Float32Array(buf.buffer, buf.byteOffset, to - from);
}

const segmentsOf = (t) => (Array.isArray(t) ? t : (t?.data_result ?? []));

/** Usable windows for one label: long-enough segments, capped, spread evenly across the recording. */
function pickWindows(segs) {
  const windows = segs
    .map((s) => ({ start: s.start_time / 1000, end: s.end_time / 1000 }))
    .filter((w) => w.end - w.start >= MIN_SEGMENT_S)
    .map((w) => ({ start: w.start, end: Math.min(w.end, w.start + MAX_WINDOW_S) }));
  const total = windows.reduce((a, w) => a + (w.end - w.start), 0);
  if (total <= MAX_SPEECH_PER_LABEL_S) return windows;
  const picked = [];
  let acc = 0;
  const step = total / MAX_SPEECH_PER_LABEL_S;
  for (
    let i = 0;
    i < windows.length && acc < MAX_SPEECH_PER_LABEL_S;
    i += Math.max(1, Math.floor(step))
  ) {
    picked.push(windows[i]);
    acc += windows[i].end - windows[i].start;
  }
  return picked;
}

const extractor = new sherpa.SpeakerEmbeddingExtractor({
  model: MODEL,
  numThreads: NUM_THREADS,
  debug: false,
});

function embed(samples) {
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.inputFinished();
  return Float32Array.from(extractor.compute(stream));
}

function normalise(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function centroid(vectors) {
  const c = new Float32Array(vectors[0].length);
  for (const v of vectors) {
    const nv = normalise(v);
    for (let i = 0; i < c.length; i++) c[i] += nv[i];
  }
  return normalise(c);
}

function cos(a, b) {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / Math.sqrt(na * nb);
}

/** Centroid from the first `seconds` of speech in a window list (for the speech-amount analysis). */
function centroidUpTo(items, seconds) {
  const out = [];
  let acc = 0;
  for (const it of items) {
    if (acc >= seconds) break;
    out.push(it.v);
    acc += it.dur;
  }
  return acc >= seconds * 0.8 && out.length ? centroid(out) : null;
}

/** Compact distribution summary, one line per series so the output is easy to paste back. */
function stats(a) {
  if (!a.length) return "n=0";
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))].toFixed(3);
  return `n=${s.length} min=${q(0)} p05=${q(0.05)} median=${q(0.5)} p95=${q(0.95)} max=${q(1)}`;
}

/** Threshold with the lowest equal error rate between same-speaker and different-speaker scores. */
function eer(same, diff) {
  let best = { threshold: null, eer: 1 };
  for (let t = 0; t <= 1; t += 0.005) {
    const frr = same.filter((x) => x < t).length / same.length;
    const far = diff.filter((x) => x >= t).length / diff.length;
    const e = Math.max(frr, far);
    if (e < best.eer) best = { threshold: +t.toFixed(3), eer: +e.toFixed(3) };
  }
  return best;
}

// ---- main ----

const t0 = Date.now();
// Preflight: /api/health needs no auth, so this isolates network problems from token problems.
console.log(`Checking ${APPLAUD_URL}/api/health ...`);
try {
  const res = await fetch(`${APPLAUD_URL}/api/health`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  const code = err?.cause?.code ?? (err?.name === "TimeoutError" ? "ETIMEDOUT" : undefined);
  console.error(`Cannot reach Applaud at ${APPLAUD_URL}: ${code ?? err?.message ?? err}`);
  if (NETWORK_HINTS[code]) console.error(NETWORK_HINTS[code]);
  else if (String(code).startsWith("ERR_SSL"))
    console.error("Applaud serves plain HTTP. Use http:// in APPLAUD_URL.");
  else if (String(err?.message).startsWith("HTTP"))
    console.error(
      "Something answered, but not Applaud's health endpoint. Check the port and that the URL has no path.",
    );
  process.exit(1);
}

const list = await getJson(`${APPLAUD_URL}/api/recordings?limit=200&sort=date_desc`);
const candidates = list.items.filter(
  (r) => r.transcriptDownloadedAt && r.audioDownloadedAt && !r.isTrash,
);
console.log(
  `Applaud reachable: ${list.total} recordings, ${candidates.length} with audio and transcript.`,
);

const tmp = mkdtempSync(path.join(tmpdir(), "applaud-cal-"));
const recs = [];
let audioSeconds = 0;
let embedMs = 0;
let peakRss = 0;
let skipped = 0;
let failed = 0;
let consecutiveFailures = 0;

try {
  for (const r of candidates) {
    if (recs.length >= MAX_RECORDINGS) break;
    try {
      const segs = segmentsOf(await getJson(mediaUrl(r.folder, "transcript.json")));
      const byLabel = new Map();
      for (const s of segs) {
        const label = s.speaker || s.original_speaker;
        if (!label) continue;
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label).push(s);
      }
      if (!OWNER) {
        const named = [...byLabel.keys()].filter((l) => !GENERIC_LABEL.test(l));
        if (named.length === 1) {
          OWNER = named[0];
          console.log(`Owner detected from Plaud tags: "${OWNER}" (override with OWNER=...)`);
        }
      }
      const labels = [...byLabel.entries()]
        .map(([label, s]) => ({ label, windows: pickWindows(s) }))
        .filter(
          (l) => l.windows.reduce((a, w) => a + w.end - w.start, 0) >= MIN_SPEECH_PER_LABEL_S,
        );
      const hasOwner = labels.some((l) => l.label === OWNER);
      const others = labels.filter((l) => l.label !== OWNER && GENERIC_LABEL.test(l.label));
      if (!OWNER || !hasOwner || others.length === 0) {
        skipped++;
        continue;
      }

      const audioPath = path.join(tmp, "audio");
      const pcmPath = path.join(tmp, "audio.f32");
      await download(mediaUrl(r.folder, r.audioFilename), audioPath);
      decodeToPcm(audioPath, pcmPath);
      rmSync(audioPath);
      const totalSamples = statSync(pcmPath).size / 4;
      audioSeconds += totalSamples / SAMPLE_RATE;
      const fd = openSync(pcmPath, "r");

      const rec = { owner: null, ownerItems: [], others: [] };
      try {
        for (const l of [labels.find((x) => x.label === OWNER), ...others]) {
          const items = [];
          for (const w of l.windows) {
            const samples = readWindow(fd, totalSamples, w.start, w.end);
            if (!samples) continue;
            const t = Date.now();
            items.push({ v: embed(samples), dur: w.end - w.start });
            embedMs += Date.now() - t;
          }
          if (!items.length) continue;
          const c = centroid(items.map((i) => i.v));
          if (l.label === OWNER) {
            rec.owner = c;
            rec.ownerItems = items;
          } else {
            rec.others.push({ c, items });
          }
        }
      } finally {
        closeSync(fd);
        rmSync(pcmPath);
      }
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      if (rec.owner && rec.others.length) {
        recs.push(rec);
        process.stdout.write(`  embedded recording ${recs.length}/${MAX_RECORDINGS}\r`);
      }
      consecutiveFailures = 0;
    } catch (err) {
      if (err?.noRetry && String(err.message).startsWith("401")) throw err;
      failed++;
      consecutiveFailures++;
      console.log(`\n  recording skipped after repeated errors: ${errText(err)}`);
      if (consecutiveFailures >= 5)
        throw new Error("5 recordings in a row failed; stopping.", { cause: err.cause });
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("");

if (recs.length < 3) {
  console.error(
    `Only ${recs.length} usable recordings (need 3+). Skipped ${skipped} without both the owner and another speaker.`,
  );
  process.exit(1);
}

// A: owner vs owner across recordings (same speaker).
// B: owner vs non-owner labels, all recordings (different speaker).
// C: non-owner vs non-owner across recordings (mixed: recurring people and strangers).
const A = [];
const B = [];
const C = [];
for (let i = 0; i < recs.length; i++) {
  for (const o of recs[i].others) B.push(cos(recs[i].owner, o.c));
  for (let j = i + 1; j < recs.length; j++) {
    A.push(cos(recs[i].owner, recs[j].owner));
    for (const o of recs[j].others) B.push(cos(recs[i].owner, o.c));
    for (const o of recs[i].others) B.push(cos(recs[j].owner, o.c));
    for (const a of recs[i].others) for (const b of recs[j].others) C.push(cos(a.c, b.c));
  }
}

// D: how much speech the probe needs. Probe = first N seconds of owner (or other) speech in
// recording i, reference = owner centroid in every other recording.
const amounts = [5, 10, 20, 30, 60];
const byAmount = {};
for (const secs of amounts) {
  const same = [];
  const diff = [];
  for (let i = 0; i < recs.length; i++) {
    const probeOwner = centroidUpTo(recs[i].ownerItems, secs);
    const probeOthers = recs[i].others.map((o) => centroidUpTo(o.items, secs)).filter(Boolean);
    for (let j = 0; j < recs.length; j++) {
      if (i === j) continue;
      if (probeOwner) same.push(cos(probeOwner, recs[j].owner));
      for (const p of probeOthers) diff.push(cos(p, recs[j].owner));
    }
  }
  const e = same.length && diff.length ? eer(same, diff) : null;
  byAmount[`${secs}s`] = {
    same: stats(same),
    different: stats(diff),
    eer: e && `${e.eer} at ${e.threshold}`,
  };
}

// E: single segments vs the owner centroid of other recordings (outlier-detection viability).
const segSame = [];
const segDiff = [];
for (let i = 0; i < recs.length; i++) {
  const ref = recs[(i + 1) % recs.length].owner;
  for (const it of recs[i].ownerItems) segSame.push(cos(it.v, ref));
  for (const o of recs[i].others) for (const it of o.items) segDiff.push(cos(it.v, ref));
}

const result = {
  model: path.basename(MODEL),
  dim: extractor.dim,
  numThreads: NUM_THREADS,
  recordingsUsed: recs.length,
  recordingsSkipped: skipped,
  recordingsFailed: failed,
  audioHours: +(audioSeconds / 3600).toFixed(2),
  embedSeconds: +(embedMs / 1000).toFixed(1),
  totalSeconds: +((Date.now() - t0) / 1000).toFixed(1),
  peakRssMB: Math.round(peakRss / 1e6),
  A_ownerVsOwner_sameSpeaker: stats(A),
  B_ownerVsOthers_differentSpeaker: stats(B),
  C_othersVsOthers_mixed: stats(C),
  centroidEER: (({ eer: e, threshold }) => `${e} at ${threshold}`)(eer(A, B)),
  speechNeededPerLabel: byAmount,
  singleSegment: {
    same: stats(segSame),
    different: stats(segDiff),
    eer: (({ eer: e, threshold }) => `${e} at ${threshold}`)(eer(segSame, segDiff)),
  },
};

console.log(JSON.stringify(result, null, 2));
