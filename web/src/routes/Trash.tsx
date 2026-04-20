import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecordingRow } from "@applaud/shared";
import { api } from "../api.js";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Trash(): JSX.Element {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["recordings-trash"],
    queryFn: () => api.listTrashRecordings({ limit: 200 }),
  });
  const blocklist = useQuery({
    queryKey: ["sync-blocklist"],
    queryFn: api.syncBlocklist,
    refetchOnMount: "always",
  });

  const restore = async (id: string): Promise<void> => {
    await api.restoreRecording(id);
    await qc.invalidateQueries({ queryKey: ["recordings-trash"] });
    await qc.invalidateQueries({ queryKey: ["recordings"] });
  };

  const purgeNow = async (id: string, filename: string): Promise<void> => {
    const label = filename.length > 120 ? `${filename.slice(0, 117)}…` : filename;
    if (
      !confirm(
        `Permanently delete this recording now?\n\n${label}\n\nLocal files will be removed immediately and the Plaud id will be added to the sync blocklist (same as after the 7-day wait). This cannot be undone.`,
      )
    ) {
      return;
    }
    await api.purgeRecordingFromTrash(id);
    await qc.invalidateQueries({ queryKey: ["recordings-trash"] });
    await qc.invalidateQueries({ queryKey: ["recordings"] });
    await qc.invalidateQueries({ queryKey: ["sync-blocklist"] });
    await qc.invalidateQueries({ queryKey: ["recording", id] });
  };

  return (
    <div>
      <header className="mb-10 flex flex-col gap-4">
        <nav className="text-xs font-label uppercase tracking-widest text-on-surface-variant">
          <Link to="/" className="hover:text-on-surface transition-colors">← Recordings</Link>
        </nav>
        <div>
          <h1 className="text-4xl font-black tracking-tighter text-on-surface">Trash</h1>
          <p className="mt-2 text-on-surface-variant text-sm max-w-xl">
            Recordings you removed in Applaud are hidden from the main list until restored or purged. By default local
            files are removed after about 7 days; use <span className="text-on-surface font-medium">Delete permanently</span>{" "}
            to purge immediately. After purge, Plaud ids are stored in the sync blocklist so they are not downloaded again
            unless you clear that list in Settings.
          </p>
        </div>
      </header>

      <section className="card p-6 space-y-4 mb-10">
        <h2 className="text-lg font-bold text-on-surface">Sync blocklist</h2>
        <p className="text-sm text-on-surface-variant max-w-prose">
          Plaud recording ids in the <code className="text-xs bg-surface-container-highest px-1.5 py-0.5 rounded">sync_ignore</code>{" "}
          table are skipped by the poller (usually after Applaud trash purge). Clear the list from Settings → Sync
          maintenance if you need to pull those ids from Plaud again.
        </p>
        {blocklist.isLoading && <p className="text-on-surface-variant text-sm">loading blocklist…</p>}
        {blocklist.error && <p className="text-error text-sm">Failed to load blocklist.</p>}
        {blocklist.data && blocklist.data.items.length === 0 && (
          <p className="text-sm text-on-surface-variant">No blocked ids.</p>
        )}
        {blocklist.data && blocklist.data.items.length > 0 && (
          <ul className="divide-y divide-outline-variant/20 border border-outline-variant/20 rounded-lg overflow-hidden">
            {blocklist.data.items.map((row) => (
              <li key={row.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 px-4 py-3 bg-surface-container-low">
                <code className="text-xs text-primary break-all">{row.id}</code>
                <span className="text-xs text-on-surface-variant shrink-0">Blocked {formatDate(row.ignoredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h2 className="text-lg font-bold text-on-surface mb-4">Applaud trash</h2>
      {list.isLoading && <p className="text-on-surface-variant">loading…</p>}
      {list.error && <p className="text-error">Failed to load trash.</p>}

      {list.data && list.data.items.length === 0 && (
        <div className="card p-8 text-center text-on-surface-variant">No recordings in Applaud trash.</div>
      )}

      {list.data && list.data.items.length > 0 && (
        <ul className="space-y-3">
          {list.data.items.map((r: RecordingRow) => (
            <li
              key={r.id}
              className="bg-surface-container rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div>
                <Link to={`/recordings/${r.id}`} className="font-bold text-on-surface hover:text-primary">
                  {r.filename}
                </Link>
                <p className="mt-1 text-xs text-on-surface-variant">
                  Deleted {r.userDeletedAt ? formatDate(r.userDeletedAt) : "—"}
                  {r.userPurgeAt ? (
                    <>
                      {" "}
                      · Purges {formatDate(r.userPurgeAt)}
                    </>
                  ) : null}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={() => void restore(r.id)}>
                  Restore
                </button>
                <Link to={`/recordings/${r.id}`} className="btn-ghost px-4 py-2 text-sm inline-flex items-center">
                  Open
                </Link>
                <button
                  type="button"
                  className="px-4 py-2 text-sm rounded-lg border border-error/30 text-error font-semibold hover:bg-error/10 transition-colors"
                  onClick={() => void purgeNow(r.id, r.filename)}
                >
                  Delete permanently
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
