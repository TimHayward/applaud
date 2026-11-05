/**
 * Summary cards: the image Plaud makes for a summary. Plaud's official API
 * names the card (`plaud://image?type=summaryCard&id=…`) but never provides
 * it, so the browser extension fetches it from the Plaud web app, which
 * returns a signed link to the PNG, and hands it to Applaud.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getDb } from "../db.js";
import { writeFileAtomic } from "../fsAtomic.js";
import { recordingPaths } from "../sync/layout.js";

export const SUMMARY_CARD_FILE = "summary_card.png";
export const SUMMARY_CARD_MAX_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Plaud makes the card some time after the summary: a recent "none" is checked again after this. */
export const CARD_RECHECK_MS = 6 * 60 * 60 * 1000;
/** …for recordings up to this old. */
export const CARD_RECHECK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The card's link, at the top of the summary. Empty alt text: Obsidian shows
 * the image, and Applaud's own display (which turns images into their alt
 * text) shows nothing.
 */
const CARD_LINK = `![](${SUMMARY_CARD_FILE})`;

export function withSummaryCard(folderAbs: string, markdown: string): string {
  if (!existsSync(path.join(folderAbs, SUMMARY_CARD_FILE))) return markdown;
  if (markdown.includes(`](${SUMMARY_CARD_FILE})`)) return markdown;
  return `${CARD_LINK}\n\n${markdown}`;
}

export interface CardNeeded {
  recordingId: string;
  title: string;
}

/** Recordings with a summary and no card yet that are worth asking Plaud about, newest first. */
export function cardsNeeded(limit = 25, now: number = Date.now()): CardNeeded[] {
  const rows = getDb()
    .prepare(
      `SELECT id, filename, display_name FROM recordings
       WHERE user_deleted_at IS NULL AND summary_downloaded_at IS NOT NULL AND summary_card_at IS NULL
         AND (
           summary_card_checked_at IS NULL
           OR summary_card_checked_at < summary_downloaded_at
           OR (start_time > @recent AND summary_card_checked_at < @recheck)
         )
       ORDER BY start_time DESC LIMIT @limit`,
    )
    .all({ recent: now - CARD_RECHECK_WINDOW_MS, recheck: now - CARD_RECHECK_MS, limit }) as {
    id: string;
    filename: string;
    display_name: string | null;
  }[];
  return rows.map((r) => ({ recordingId: r.id, title: r.display_name || r.filename }));
}

export type SaveCardOutcome = { ok: true } | { ok: false; code: number; error: string };

/** Store a card the extension fetched, and link it from the summary. */
export function saveCard(
  recordingsDir: string,
  recordingId: string,
  png: Buffer,
  now: number = Date.now(),
): SaveCardOutcome {
  if (png.length === 0 || png.length > SUMMARY_CARD_MAX_BYTES) {
    return { ok: false, code: 413, error: "the card must be a PNG of at most 10 MB" };
  }
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { ok: false, code: 400, error: "the card is not a PNG image" };
  }
  const row = getDb()
    .prepare(
      "SELECT folder, audio_filename FROM recordings WHERE id = ? AND user_deleted_at IS NULL",
    )
    .get(recordingId) as { folder: string; audio_filename: string | null } | undefined;
  if (!row) return { ok: false, code: 404, error: "recording not found" };
  const paths = recordingPaths(recordingsDir, row.folder, row.audio_filename ?? undefined);
  if (!existsSync(paths.folder))
    return { ok: false, code: 409, error: "the recording isn't downloaded" };

  writeFileAtomic(path.join(paths.folder, SUMMARY_CARD_FILE), png);
  if (existsSync(paths.summaryMdPath)) {
    const md = readFileSync(paths.summaryMdPath, "utf8");
    const linked = withSummaryCard(paths.folder, md);
    if (linked !== md) writeFileAtomic(paths.summaryMdPath, linked);
  }
  getDb().prepare("UPDATE recordings SET summary_card_at = ? WHERE id = ?").run(now, recordingId);
  return { ok: true };
}

/** The extension looked and Plaud has no card (yet). */
export function markNoCard(recordingId: string, now: number = Date.now()): boolean {
  return (
    getDb()
      .prepare(
        "UPDATE recordings SET summary_card_checked_at = ? WHERE id = ? AND user_deleted_at IS NULL",
      )
      .run(now, recordingId).changes > 0
  );
}
