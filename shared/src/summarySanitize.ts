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
 *
 * ⚠️ This is a *display normalizer, not an HTML sanitizer.* The `<img …>` strip
 * is a naive regex that a crafted tag can slip past, and nothing else here
 * touches HTML. It's safe today only because the renderer treats raw HTML as
 * text: `react-markdown` is used without `rehype-raw`, and the webhook payload
 * ships markdown, not HTML. If anyone adds `rehype-raw` (or renders this
 * through `dangerouslySetInnerHTML`), route the output through a real
 * sanitizer such as DOMPurify or `rehype-sanitize` first — this function will
 * not stop XSS.
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
