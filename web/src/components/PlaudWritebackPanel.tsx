import { useQuery } from "@tanstack/react-query";
import type { PlaudDocumentKind, PlaudWritebackChange, PlaudWritebackRecording } from "@applaud/shared";
import { api } from "../api.js";
import { useToast } from "./Toast.js";
import { formatDurationClock, formatRelative } from "../lib/format.js";

const KIND_LABEL: Record<PlaudDocumentKind, string> = {
  transcript: "Transcript",
  polished: "Polished transcript",
  summary: "Summary",
};

function stateLine(r: PlaudWritebackRecording): { text: string; tone: "info" | "warn" | "ok" } | null {
  switch (r.state) {
    case "sent":
      return {
        text: `Sent to Plaud ${formatRelative(r.lastAttemptAt)}. Applaud's next sync will confirm it.`,
        tone: "info",
      };
    case "partial":
      return {
        text: `The last send stopped part-way${r.lastError ? ` (${r.lastError})` : ""}. Sending again completes it.`,
        tone: "warn",
      };
    case "stale":
      return {
        text: `This recording changed in Plaud since Applaud last synced${r.lastError ? ` (${r.lastError})` : ""}. It can be sent again after the next sync.`,
        tone: "warn",
      };
    case "in_plaud":
      return { text: "Plaud has every name you have confirmed here.", tone: "ok" };
    default:
      return r.lastError ? { text: `The last send failed: ${r.lastError}`, tone: "warn" } : null;
  }
}

function ChangeRow({ change, onCopy }: { change: PlaudWritebackChange; onCopy: (name: string) => void }): JSX.Element {
  return (
    <li className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0 text-sm">
        {change.segment ? (
          <>
            <span className="font-label text-xs text-on-surface-variant">{formatDurationClock(change.segment.startMs)}</span>{" "}
            <span className="text-on-surface-variant">&ldquo;{change.segment.text}&rdquo;</span>
            <span className="block">
              <span className="text-on-surface-variant">{change.from}</span> →{" "}
              <span className="font-semibold text-on-surface">{change.to}</span>
            </span>
          </>
        ) : (
          <>
            <span className="text-on-surface-variant">{change.from}</span> →{" "}
            <span className="font-semibold text-on-surface">{change.to}</span>
            <span className="text-on-surface-variant">
              {" "}
              · {change.segments} line{change.segments === 1 ? "" : "s"}
            </span>
          </>
        )}
      </div>
      <button
        type="button"
        className="shrink-0 text-xs font-semibold text-primary hover:underline"
        onClick={() => onCopy(change.to)}
      >
        Copy name
      </button>
    </li>
  );
}

/**
 * Recording page: the confirmed names Plaud is still missing (P3), how the
 * last send went, and the send history. Useful without the extension: each
 * name can be copied and entered in Plaud by hand.
 */
export function PlaudWritebackPanel({ recordingId }: { recordingId: string }): JSX.Element | null {
  const toast = useToast();
  const q = useQuery({
    queryKey: ["plaud-writeback", "recording", recordingId],
    queryFn: () => api.plaudWritebackRecording(recordingId),
    staleTime: 15_000,
  });
  const r = q.data?.recording;
  const historyItems = q.data?.history ?? [];
  if (!r || (r.pendingSegments === 0 && historyItems.length === 0)) return null;

  const copy = async (name: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(name);
      toast.success(`Copied "${name}".`);
    } catch {
      toast.error("Couldn't copy to the clipboard.");
    }
  };

  const line = stateLine(r);
  return (
    <section className="card p-6 space-y-4">
      <div className="space-y-1">
        <h2 className="font-label text-xs font-bold text-primary uppercase tracking-widest">Names to send to Plaud</h2>
        {r.pendingSegments > 0 && (
          <p className="text-sm text-on-surface-variant max-w-prose">
            Plaud AI only uses names held in Plaud. Rename these speakers in Plaud
            {q.data?.enabled ? ", or send them with the Applaud browser extension" : ""}.
          </p>
        )}
      </div>

      {line && (
        <p
          className={
            line.tone === "warn"
              ? "text-sm text-error"
              : line.tone === "ok"
                ? "text-sm text-secondary"
                : "text-sm text-on-surface-variant"
          }
        >
          {line.text}
        </p>
      )}

      {r.pendingSegments > 0 && r.changes.length > 0 && (
        <ul className="divide-y divide-outline-variant/30">
          {r.changes.map((c) => (
            <ChangeRow
              key={`${c.plaudLabel}|${c.to}|${c.segment?.startMs ?? ""}`}
              change={c}
              onCopy={(name) => void copy(name)}
            />
          ))}
        </ul>
      )}

      {historyItems.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-on-surface select-none">History</summary>
          <ul className="mt-3 space-y-1 text-xs text-on-surface-variant">
            {historyItems.map((h, i) => (
              <li key={`${h.planId}-${h.kind}-${i}`}>
                {formatRelative(h.updatedAt)} · {h.undo ? "Undo: " : ""}
                {KIND_LABEL[h.kind]} · {h.outcome}
                {h.undone ? " (undone)" : ""}
                {h.error ? ` · ${h.error}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
