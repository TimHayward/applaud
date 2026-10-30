#!/usr/bin/env node
/* global process, console, fetch, Buffer */
// Downloads the speaker model (docs/plans/speaker-identification.md, D10) and
// verifies its SHA-256. The Docker build runs this; for development run
// `node scripts/fetch-speaker-model.mjs` once to fill <repo>/models.
//
// Usage: node scripts/fetch-speaker-model.mjs [destination dir]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 3D-Speaker ERes2Net (English, VoxCeleb), Apache-2.0, as packaged by sherpa-onnx.
// The file name must match SPEAKER_MODEL_FILE in server/src/speakers/service.ts.
const MODEL = {
  file: "3dspeaker_eres2net_en_voxceleb_16k.onnx",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx",
  sha256: "c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5",
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.resolve(process.argv[2] ?? path.join(root, "models"));
const dest = path.join(dir, MODEL.file);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

if (existsSync(dest) && sha256(readFileSync(dest)) === MODEL.sha256) {
  console.log(`speaker model present: ${dest}`);
  process.exit(0);
}

console.log(`downloading speaker model to ${dest}`);
const res = await fetch(MODEL.url);
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const got = sha256(buf);
if (got !== MODEL.sha256) {
  console.error(`speaker model hash mismatch: expected ${MODEL.sha256}, got ${got}`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
writeFileSync(`${dest}.tmp`, buf);
renameSync(`${dest}.tmp`, dest);
console.log(`speaker model ready (${(buf.length / 1e6).toFixed(1)} MB, sha256 ${got.slice(0, 8)}…)`);
