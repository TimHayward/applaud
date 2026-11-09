import type { PlaudWritebackPendingResponse, SpeakerReviewResponse } from "@applaud/shared";

/**
 * Where a recording's speakers stand, most urgent first: speakers still to
 * name, automatic names still to confirm, confirmed names Plaud doesn't have
 * yet, or everything confirmed and in Plaud.
 */
export type SpeakerStatusKind = "label" | "confirm" | "sync" | "synced";

export interface SpeakerStatus {
  kind: SpeakerStatusKind;
  /** Speakers in this state; 0 for `synced`. */
  count: number;
}

/**
 * The status for one recording, or null when there is nothing to show
 * (speaker identification is off, or the recording has no named speakers).
 * `pending` counts only while sending names to Plaud is on.
 */
export function speakerStatus(
  id: string,
  review: SpeakerReviewResponse | undefined,
  pending: PlaudWritebackPendingResponse | undefined,
): SpeakerStatus | null {
  if (!review?.enabled) return null;
  const toLabel = review.recordings[id] ?? 0;
  if (toLabel > 0) return { kind: "label", count: toLabel };
  const toConfirm = review.toConfirm?.[id] ?? 0;
  if (toConfirm > 0) return { kind: "confirm", count: toConfirm };
  if (pending?.enabled) {
    const item = pending.recordings.find((r) => r.recordingId === id);
    if (item && item.state !== "in_plaud") {
      const labels = new Set(item.changes.map((c) => c.plaudLabel)).size;
      return { kind: "sync", count: Math.max(labels, 1) };
    }
  }
  if ((review.confirmed?.[id] ?? 0) > 0) return { kind: "synced", count: 0 };
  return null;
}

export function speakerStatusText(s: SpeakerStatus): string {
  const n = `${s.count} speaker${s.count === 1 ? "" : "s"}`;
  switch (s.kind) {
    case "label":
      return `${n} to label`;
    case "confirm":
      return `${n} to confirm`;
    case "sync":
      return `${n} to sync`;
    default:
      return "synced";
  }
}

export function speakerStatusTitle(s: SpeakerStatus): string {
  switch (s.kind) {
    case "label":
      return "Speakers Applaud couldn't name. Open the recording to name them";
    case "confirm":
      return "Named automatically. Only confirmed names are sent to Plaud";
    case "sync":
      return "Confirmed names Plaud doesn't have yet. Send them with the browser extension";
    default:
      return "Every speaker is confirmed and the names are in Plaud";
  }
}

/** Pastel colours, readable on the pill background in light and dark themes. */
export const SPEAKER_DOT: Record<SpeakerStatusKind, string> = {
  label: "bg-red-400 dark:bg-red-300",
  confirm: "bg-red-400 dark:bg-red-300",
  sync: "bg-amber-400 dark:bg-amber-300",
  synced: "bg-emerald-400 dark:bg-emerald-300",
};

export const SPEAKER_TEXT: Record<SpeakerStatusKind, string> = {
  label: "text-red-500 dark:text-red-300",
  confirm: "text-amber-600 dark:text-amber-300",
  sync: "text-amber-600 dark:text-amber-300",
  synced: "text-emerald-600 dark:text-emerald-300",
};
