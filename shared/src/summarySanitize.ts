export interface SummarySanitizeOptions {
  /** Recording start (ms), used for `$[audio_start_time]` and similar. */
  startTimeMs?: number;
  /** Recording end (ms), used for `$[audio_end_time]`. */
  endTimeMs?: number;
}

function formatMeetingDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Normalizes Plaud AI summary markdown for display and storage.
 *
 * - Replaces Plaud template variables (`$[audio_start_time]`, …) with real dates or an em dash.
 * - Removes `[Insert …]` style placeholders Plaud sometimes leaves unfilled.
 * - Turns markdown images `![alt](url)` into **alt** (Plaud often ships a logo / note icon URL that
 *   cannot be loaded in the browser without Plaud cookies → broken `<img>`).
 * - Strips raw `<img …>` tags if present.
 */
export function sanitizePlaudSummaryMarkdown(md: string, opts: SummarySanitizeOptions = {}): string {
  let s = md;

  s = s.replace(/<img\b[^>]*>/gi, "");

  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt: string) => {
    const t = String(alt ?? "").trim();
    return t ? `**${t}**` : "";
  });

  if (opts.startTimeMs != null) {
    const formatted = formatMeetingDate(opts.startTimeMs);
    s = s.replace(/\$\[audio_start_time\]/gi, formatted);
  }
  if (opts.endTimeMs != null) {
    const formatted = formatMeetingDate(opts.endTimeMs);
    s = s.replace(/\$\[audio_end_time\]/gi, formatted);
  }

  s = s.replace(/\$\[([^\]]+)\]/g, "—");

  s = s.replace(/\[Insert[^\]]*\]/gi, "—");

  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trimEnd();
}
