export type ToastKind = "success" | "error" | "info";

/** Confirmations are read at a glance — the message is short and expected. */
const DEFAULT_MS = 5_000;
/** Floor for errors: unexpected text takes longer to find and start reading. */
const ERROR_BASE_MS = 8_000;
/** Rough reading speed, ~200 wpm at ~5 chars a word. */
const MS_PER_CHAR = 60;
const ERROR_MAX_MS = 20_000;
/**
 * Past this length an error is a paragraph — a server message, a stack-ish
 * string, something worth copying. Anything auto-dismissed is guaranteed to be
 * missed by someone, so these stay until dismissed.
 */
const STICKY_ERROR_CHARS = 160;

/**
 * How long a toast should stay up, or `null` for "until the user dismisses it".
 *
 * A fixed 5s applied to everything meant long error messages vanished
 * mid-sentence, with no way to get them back.
 */
export function toastDurationMs(kind: ToastKind, message: string): number | null {
  if (kind !== "error") return DEFAULT_MS;
  if (message.length > STICKY_ERROR_CHARS) return null;
  return Math.min(ERROR_MAX_MS, ERROR_BASE_MS + message.length * MS_PER_CHAR);
}
