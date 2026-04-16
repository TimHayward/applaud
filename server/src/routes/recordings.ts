import { Router } from "express";
import { readFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  listRecordingRows,
  getRecordingById,
  deleteRecording,
  recordError,
} from "../sync/state.js";
import { loadConfig } from "../config.js";
import { poller } from "../sync/poller.js";
import type { RecordingDetail } from "@applaud/shared";

export const recordingsRouter = Router();

recordingsRouter.get("/", (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  const offset = Number(req.query.offset ?? 0);
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const result = listRecordingRows({ limit, offset, ...(search ? { search } : {}) });
  res.json(result);
});

recordingsRouter.get("/:id", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  const row = getRecordingById(id);
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const cfg = loadConfig();
  const base = cfg.recordingsDir ?? "";

  let transcriptText: string | null = null;
  let summaryMarkdown: string | null = null;
  let metadata: Record<string, unknown> | null = null;

  try {
    if (row.transcriptPath) {
      const txtPath = path.join(path.dirname(row.transcriptPath), "transcript.txt");
      if (existsSync(txtPath)) transcriptText = readFileSync(txtPath, "utf8");
    }
  } catch {
    /* ignore */
  }
  try {
    if (row.summaryPath && existsSync(row.summaryPath)) {
      summaryMarkdown = readFileSync(row.summaryPath, "utf8");
    }
  } catch {
    /* ignore */
  }
  try {
    if (row.metadataPath && existsSync(row.metadataPath)) {
      metadata = JSON.parse(readFileSync(row.metadataPath, "utf8")) as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }

  const attachments: { filename: string; url: string }[] = [];
  if (row.folder && base) {
    const folderAbs = path.join(base, row.folder);
    if (existsSync(folderAbs)) {
      for (const item of readdirSync(folderAbs)) {
        if (["audio.ogg", "transcript.json", "transcript.txt", "summary.md", "metadata.json"].includes(item)) continue;
        const abs = path.join(folderAbs, item);
        if (!existsSync(abs) || !statSync(abs).isFile()) continue;
        attachments.push({ filename: item, url: `/media/${encodeURIComponent(row.folder)}/${encodeURIComponent(item)}` });
      }
    }
  }

  const detail: RecordingDetail = {
    ...row,
    transcriptText,
    summaryMarkdown,
    metadata,
    attachments,
  };
  res.json({ recording: detail, mediaBase: `/media/${encodeURI(row.folder)}`, recordingsDir: base });
});

recordingsRouter.delete("/:id", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  const row = getRecordingById(id);
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const cfg = loadConfig();
  if (cfg.recordingsDir) {
    const folder = path.join(cfg.recordingsDir, row.folder);
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  deleteRecording(id);
  res.json({ ok: true });
});

recordingsRouter.post("/:id/resync", async (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  const row = getRecordingById(id);
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!row.audioDownloadedAt) {
    res.status(400).json({ error: "recording audio is not downloaded yet" });
    return;
  }
  try {
    await poller.refreshRecording(id);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordError(id, message);
    res.status(500).json({ error: message });
  }
});
