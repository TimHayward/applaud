import { Router } from "express";
import { z } from "zod";
import { listWebhookLog } from "../webhook/log.js";
import { fireWebhookForRecording } from "../webhook/post.js";
import { getRecordingById, markWebhookFired } from "../sync/state.js";
import { loadConfig } from "../config.js";

export const webhooksRouter = Router();

const LogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

webhooksRouter.get("/log", (req, res) => {
  const parsed = LogQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(listWebhookLog(parsed.data));
});

const RedeliverSchema = z.object({
  recordingId: z.string().min(1),
  event: z.enum(["audio_ready", "transcript_ready"]),
});

/** Manually re-drive a webhook for a recording (e.g. after a delivery failed all retries). */
webhooksRouter.post("/redeliver", async (req, res) => {
  const parsed = RedeliverSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid body" });
    return;
  }
  const cfg = loadConfig();
  if (!cfg.webhook?.enabled || !cfg.webhook.url) {
    res.status(400).json({ ok: false, error: "no webhook configured" });
    return;
  }
  const { recordingId, event } = parsed.data;
  const row = getRecordingById(recordingId);
  if (!row) {
    res.status(404).json({ ok: false, error: "recording not found" });
    return;
  }
  const fired = await fireWebhookForRecording(event, row);
  if (!fired) {
    res.status(502).json({ ok: false, error: "delivery failed — see the webhook log for details" });
    return;
  }
  markWebhookFired(recordingId, event);
  res.json({ ok: true });
});
