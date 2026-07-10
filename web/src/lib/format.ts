/** Shared display formatters. Keep all date/duration/size formatting here so pages stay consistent. */

/** "1:02:03" / "2:05" — clock-style, used in lists. */
export function formatDurationClock(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "1h 2m 3s" / "2m 5s" / "45s" — verbose, used on the detail page. */
export function formatDurationVerbose(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** "Apr 11, 2026, 12:00 PM" — compact locale date+time for list rows. */
export function formatDateShort(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Full locale date+time (seconds included) for detail metadata. */
export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** "just now" / "45s ago" / "12m ago" / "3h ago" / "never". */
export function formatRelative(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 10_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

/** "512 B" / "1.5 KB" / "23.1 MB" / "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Whole days from now until a unix-seconds epoch, floored at 0. */
export function daysUntil(epochSec: number): number {
  return Math.max(0, Math.ceil((epochSec * 1000 - Date.now()) / (1000 * 60 * 60 * 24)));
}
