import { Router } from "express";
import { speakerConfig, type SpeakerStatusResponse } from "@applaud/shared";
import { loadConfig } from "../config.js";
import { getRecordingById } from "../sync/state.js";
import { observedPlaudNames } from "../speakers/analyse.js";
import { speakerRunner } from "../speakers/service.js";

/** Mounted at /api: speaker identification status, the capability check, re-analysis. */
export const speakersRouter = Router();

function statusBody(): SpeakerStatusResponse {
  const cfg = loadConfig();
  const s = speakerConfig(cfg);
  return {
    ...speakerRunner().status(),
    enabled: s.enabled,
    ownerName: s.ownerName,
    plaudNickname: cfg.plaudNickname,
    /** Names Plaud has tagged speakers with: candidates for the owner. */
    plaudNames: s.enabled ? observedPlaudNames() : [],
  };
}

speakersRouter.get("/speakers/status", (_req, res) => {
  res.json(statusBody());
});

/** Re-run the capability check (Settings → Speakers → Retry). */
speakersRouter.post("/speakers/check", async (_req, res) => {
  await speakerRunner().check();
  res.json(statusBody());
});

speakersRouter.post("/recordings/:id/speakers/reanalyse", (req, res) => {
  if (!speakerConfig(loadConfig()).enabled) {
    res.status(409).json({ error: "speaker identification is off" });
    return;
  }
  const row = getRecordingById(req.params.id);
  if (!row) {
    res.status(404).json({ error: "recording not found" });
    return;
  }
  speakerRunner().enqueue("analyse", row.id);
  res.status(202).json({ ok: true });
});
