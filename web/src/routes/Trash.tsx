import { useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { RecordingRow } from "@applaud/shared";
import { api } from "../api.js";
import { useRecordingActions } from "../hooks/useRecordingActions.js";
import { formatDateShort } from "../lib/format.js";

const PAGE_SIZE = 50;

export function Trash(): JSX.Element {
  const { restore, purgeNow, bulkRestore, bulkPurge } = useRecordingActions();
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const list = useQuery({
    queryKey: ["recordings-trash", { page }],
    queryFn: () => api.listTrashRecordings({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    // Hold the current page on screen while the next one loads (see Dashboard).
    placeholderData: keepPreviousData,
  });

  const toggleSelected = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const blocklist = useQuery({
    queryKey: ["sync-blocklist"],
    queryFn: api.syncBlocklist,
    refetchOnMount: "always",
  });

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
                <span className="text-xs text-on-surface-variant shrink-0">Blocked {formatDateShort(row.ignoredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h2 className="text-lg font-bold text-on-surface mb-4">Applaud trash</h2>

      {selected.size > 0 && (
        <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-on-surface">{selected.size} selected</span>
          <button
            type="button"
            className="btn-primary px-3 py-1.5 text-xs"
            onClick={() => {
              void bulkRestore([...selected]).then((ok) => {
                if (ok) setSelected(new Set());
              });
            }}
          >
            Restore selected
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-xs rounded-lg border border-error/30 text-error font-semibold hover:bg-error/10 transition-colors"
            onClick={() => {
              void bulkPurge([...selected]).then((ok) => {
                if (ok) setSelected(new Set());
              });
            }}
          >
            Delete permanently
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {list.isLoading && <p className="text-on-surface-variant">loading…</p>}
      {list.error && <p className="text-error">Failed to load trash.</p>}

      {list.data && list.data.items.length === 0 && (
        <div className="card p-8 text-center text-on-surface-variant">No recordings in Applaud trash.</div>
      )}

      {list.data && list.data.items.length > 0 && (
        <ul
          className={`space-y-3 transition-opacity ${list.isPlaceholderData ? "opacity-60" : "opacity-100"}`}
          aria-busy={list.isPlaceholderData}
        >
          {list.data.items.map((r: RecordingRow) => (
            <li
              key={r.id}
              className="bg-surface-container rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary shrink-0 cursor-pointer"
                  checked={selected.has(r.id)}
                  aria-label={`Select ${r.filename}`}
                  onChange={() => toggleSelected(r.id)}
                />
                <div>
                  <Link to={`/recordings/${r.id}`} className="font-bold text-on-surface hover:text-primary">
                    {r.displayName ?? r.filename}
                  </Link>
                  <p className="mt-1 text-xs text-on-surface-variant">
                    Deleted {r.userDeletedAt ? formatDateShort(r.userDeletedAt) : "—"}
                    {r.userPurgeAt ? (
                      <>
                        {" "}
                        · Purges {formatDateShort(r.userPurgeAt)}
                      </>
                    ) : null}
                  </p>
                </div>
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

      {list.data && list.data.total > PAGE_SIZE && (
        <div className="mt-6 flex items-center justify-between font-label text-xs text-on-surface-variant">
          <button
            type="button"
            className="btn-ghost px-4 py-2 text-sm disabled:opacity-40 disabled:pointer-events-none"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            ← Previous
          </button>
          <span>
            Page {page + 1} of {Math.max(1, Math.ceil(list.data.total / PAGE_SIZE))}
          </span>
          <button
            type="button"
            className="btn-ghost px-4 py-2 text-sm disabled:opacity-40 disabled:pointer-events-none"
            onClick={() => setPage((p) => p + 1)}
            disabled={(page + 1) * PAGE_SIZE >= list.data.total}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
