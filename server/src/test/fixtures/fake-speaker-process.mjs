/* global process, setInterval */
// Stand-in for speakers/embedder-process.ts in LocalEmbedder tests: speaks the
// same IPC protocol without a model. FAKE_MODE picks the behaviour.
const mode = process.env.FAKE_MODE ?? "ok";

if (mode === "load_fail") {
  process.send({ type: "fatal", message: "libonnxruntime.so: cannot open shared object file" });
  process.exit(3);
}
if (mode === "never_ready") {
  setInterval(() => {}, 1000);
} else {
  process.send({ type: "ready", modelId: "fake@00000000", dim: 4 });
}

process.on("message", (msg) => {
  if (msg.type === "probe") {
    process.send({ type: "probe", id: msg.id, dim: mode === "bad_probe" ? 3 : 4 });
    return;
  }
  if (mode === "crash_on_embed") process.exit(1);
  if (mode === "hang") return;
  if (mode === "decode_error") {
    process.send({ type: "error", id: msg.id, code: "decode_failed", message: "ffmpeg failed (exit code 1)" });
    return;
  }
  process.send({
    type: "result",
    id: msg.id,
    result: {
      audioSeconds: 60,
      elapsedMs: 1,
      vectors: msg.windows.map((w) => ({ id: w.id, vector: new Float32Array([1, 0, 0, 0]) })),
      skipped: [],
    },
  });
});
process.on("disconnect", () => process.exit(0));
