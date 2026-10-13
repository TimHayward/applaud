import { Router } from "express";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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
  setRecordingDisplayName,
} from "../sync/state.js";
import { loadConfig } from "../config.js";
import { poller } from "../sync/poller.js";
import { RECORDINGS_LIST_MAX_LIMIT } from "../constants.js";
import type { RecordingDetail } from "@applaud/shared";
import { sanitizePlaudSummaryMarkdown } from "@applaud/shared";
import { recordingPaths } from "../sync/layout.js";

export const recordingsRouter = Router();

const CORE_FILENAMES = new Set(["transcript.json", "transcript.txt", "summary.md", "metadata.json"]);

/**
 * Non-core files under the recording folder, as folder-relative POSIX paths.
 * `audioFilename` is excluded too (it varies per recording, e.g. audio.mp3).
 */
function listAttachmentFilenames(folderAbs: string, audioFilename: string): string[] {
  const filenames: string[] = [];
  const walk = (dirAbs: string, relDir = ""): void => {
    for (const item of readdirSync(dirAbs)) {
      const abs = path.join(dirAbs, item);
      const relPath = relDir ? path.posix.join(relDir, item) : item;
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        walk(abs, relPath);
        continue;
      }
      if (!stat.isFile()) continue;
      if (CORE_FILENAMES.has(relPath) || relPath === audioFilename) continue;
      filenames.push(relPath);
    }
  };
  if (existsSync(folderAbs)) walk(folderAbs);
  filenames.sort((a, b) => a.localeCompare(b));
  return filenames;
}

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RECORDINGS_LIST_MAX_LIMIT).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  search: z.string().optional(),
});

const RecordingsListQuerySchema = ListQuerySchema.extend({
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  sort: z
    .enum(["date_desc", "date_asc", "duration_desc", "duration_asc", "size_desc", "size_asc"])
    .optional(),
  starred: z
    .enum(["1", "true", "0", "false"])
    .transform((v) => v === "1" || v === "true")
    .optional(),
});

recordingsRouter.get("/trash", (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { limit, offset } = parsed.data;
  const result = listSoftDeletedRows({ limit, offset });
  res.json(result);
});

recordingsRouter.get("/sync-blocklist", (_req, res) => {
  res.json({ items: listSyncIgnoreRows() });
});

recordingsRouter.get("/", (req, res) => {
  const parsed = RecordingsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { limit, offset, search, from, to, sort, starred } = parsed.data;
  const result = listRecordingRows({
    limit,
    offset,
    ...(search ? { search } : {}),
    ...(from != null ? { from } : {}),
    ...(to != null ? { to } : {}),
    ...(sort ? { sort } : {}),
    ...(starred ? { starred } : {}),
  });
  res.json(result);
});

const RenameSchema = z.object({ displayName: z.string().max(300).nullable() });

/** Set (or clear) a local title override. Cleared automatically on the recording's next resync. */
recordingsRouter.post("/:id/rename", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  const parsed = RenameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const row = getRecordingById(id);
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const updated = setRecordingDisplayName(id, parsed.data.displayName);
  res.json({ recording: updated });
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

  let transcriptText: string | null = null;
  let summaryMarkdown: string | null = null;
  let metadata: Record<string, unknown> | null = null;
  const attachments: { filename: string; url: string }[] = [];

  // Files are resolved against the *current* recordings dir, so a moved
  // library (or a different Docker mount) keeps working.
  const paths = cfg.recordingsDir ? recordingPaths(cfg.recordingsDir, row.folder, row.audioFilename) : null;
  if (paths) {
    try {
      if (existsSync(paths.transcriptTxtPath)) transcriptText = readFileSync(paths.transcriptTxtPath, "utf8");
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(paths.summaryMdPath)) {
        repairSummaryMarkdownFile(paths.summaryMdPath);
        const raw = readFileSync(paths.summaryMdPath, "utf8");
        summaryMarkdown = sanitizePlaudSummaryMarkdown(raw, {
          startTimeMs: row.startTime,
          endTimeMs: row.endTime,
        });
      }
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(paths.metadataPath)) {
        metadata = JSON.parse(readFileSync(paths.metadataPath, "utf8")) as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
    attachments.push(
      ...listAttachmentFilenames(paths.folder, row.audioFilename).map((filename) => ({
        filename,
        url: `/media/${encodeURI(`${row.folder}/${filename}`)}`,
      })),
    );
  }

  const detail: RecordingDetail = {
    ...row,
    transcriptText,
    summaryMarkdown,
    metadata,
    attachments,
  };
  res.json({ recording: detail, mediaBase: `/media/${encodeURI(row.folder)}` });
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
    // resyncRecording → processRecording already fires audio_ready /
    // transcript_ready internally (and marks them) as each asset lands, so the
    // route must NOT fire again — doing so delivered a duplicate webhook and
    // turned a receiver-side failure into a misleading 502 even though the
    // resync itself succeeded.
    await poller.resyncRecording(id);
    const fresh = getRecordingById(id);
    if (!fresh) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const event = fresh.transcriptDownloadedAt ? "transcript_ready" : "audio_ready";
    res.json({ ok: true, event });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
