import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { useToast } from "./Toast.js";
import { formatRelative } from "../lib/format.js";

/** Recent webhook delivery attempts with a re-drive button for failures. */
export function WebhookDeliveries(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const [redelivering, setRedelivering] = useState<Set<number>>(new Set());
  const log = useQuery({
    queryKey: ["webhook-log"],
    queryFn: () => api.webhookLog({ limit: 20 }),
  });

  const redeliver = async (logId: number, recordingId: string, event: string): Promise<void> => {
    if (event !== "audio_ready" && event !== "transcript_ready") return;
    setRedelivering((prev) => new Set(prev).add(logId));
    try {
      await api.webhookRedeliver(recordingId, event);
      toast.success("Webhook redelivered.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRedelivering((prev) => {
        const next = new Set(prev);
        next.delete(logId);
        return next;
      });
      await qc.invalidateQueries({ queryKey: ["webhook-log"] });
    }
  };

  return (
    <section className="card p-8 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-on-surface">Webhook Deliveries</h2>
        <button
          type="button"
          className="btn-ghost px-3 py-1.5 text-xs"
          onClick={() => void log.refetch()}
          disabled={log.isFetching}
        >
          {log.isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="text-sm text-on-surface-variant max-w-prose">
        The most recent delivery attempts (each retry is logged separately). Failed deliveries can be re-driven once
        the receiver is reachable again.
      </p>
      {log.isLoading && <p className="text-sm text-on-surface-variant">loading…</p>}
      {log.error && <p className="text-sm text-error">Failed to load the delivery log.</p>}
      {log.data && log.data.items.length === 0 && (
        <p className="text-sm text-on-surface-variant">No deliveries yet.</p>
      )}
      {log.data && log.data.items.length > 0 && (
        <ul className="divide-y divide-outline-variant/20 border border-outline-variant/20 rounded-lg overflow-hidden">
          {log.data.items.map((row) => {
            const ok = row.error == null && row.statusCode != null && row.statusCode >= 200 && row.statusCode < 300;
            return (
              <li key={row.id} className="flex flex-col sm:flex-row sm:items-center gap-2 px-4 py-3 bg-surface-container-low">
                <span
                  className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold font-label uppercase tracking-wider ${
                    ok ? "bg-secondary/15 text-secondary" : "bg-error/15 text-error"
                  }`}
                >
                  {ok ? `HTTP ${row.statusCode}` : row.statusCode ? `HTTP ${row.statusCode}` : "failed"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-on-surface truncate">
                    <span className="font-semibold">{row.event}</span>
                    {row.recordingFilename ? <> · {row.recordingFilename}</> : null}
                  </p>
                  <p className="text-[11px] text-on-surface-variant truncate">
                    {formatRelative(row.firedAt)}
                    {row.durationMs != null ? ` · ${row.durationMs}ms` : ""}
                    {row.error ? ` · ${row.error}` : ""}
                  </p>
                </div>
                {!ok && row.recordingId && (
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1.5 text-xs shrink-0"
                    disabled={redelivering.has(row.id)}
                    onClick={() => void redeliver(row.id, row.recordingId!, row.event)}
                  >
                    {redelivering.has(row.id) ? "Redelivering…" : "Redeliver"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
