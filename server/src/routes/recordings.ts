import { Router } from "express";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { repairSummaryMarkdownFile } from "../plaud/transcript.js";
import {
  listRecordingRows,
  listSoftDeletedRows,
  listSyncIgnoreRows,
  getRecordingById,
  softDeleteRecording,
  restoreRecording,
  purgeSoftDeletedRecordingNow,
} from "../sync/state.js";
import { loadConfig } from "../config.js";
import type { RecordingDetail } from "@applaud/shared";
import { sanitizePlaudSummaryMarkdown } from "@applaud/shared";

export const recordingsRouter = Router();

recordingsRouter.get("/trash", (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  const offset = Number(req.query.offset ?? 0);
  const result = listSoftDeletedRows({ limit, offset });
  res.json(result);
});

recordingsRouter.get("/sync-blocklist", (_req, res) => {
  res.json({ items: listSyncIgnoreRows() });
});

recordingsRouter.get("/", (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  const offset = Number(req.query.offset ?? 0);
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const result = listRecordingRows({ limit, offset, ...(search ? { search } : {}) });
  res.json(result);
});

recordingsRouter.post("/:id/restore", (req, res) => {
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
  if (!row.userDeletedAt) {
    res.status(400).json({ error: "not in trash" });
    return;
  }
  restoreRecording(id);
  res.json({ ok: true });
});

recordingsRouter.post("/:id/purge", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  const result = purgeSoftDeletedRecordingNow(id);
  if (result === "not_found") {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (result === "not_in_trash") {
    res.status(400).json({ error: "not in trash" });
    return;
  }
  if (result === "disk_error") {
    res.status(500).json({ error: "could not remove recording folder from disk" });
    return;
  }
  res.json({ ok: true });
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
      repairSummaryMarkdownFile(row.summaryPath);
      const raw = readFileSync(row.summaryPath, "utf8");
      summaryMarkdown = sanitizePlaudSummaryMarkdown(raw, {
        startTimeMs: row.startTime,
        endTimeMs: row.endTime,
      });
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

  const detail: RecordingDetail = {
    ...row,
    transcriptText,
    summaryMarkdown,
    metadata,
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
  if (row.userDeletedAt) {
    res.status(400).json({ error: "already in trash" });
    return;
  }
  softDeleteRecording(id);
  res.json({ ok: true });
});
