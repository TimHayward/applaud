import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api.js";
import { useDebouncedValue } from "../hooks/useDebouncedValue.js";
import { useRecordingActions } from "../hooks/useRecordingActions.js";
import { useToast } from "../components/Toast.js";
import { formatDurationClock, formatDateShort, formatBytes } from "../lib/format.js";
import type { RecordingRow, RecordingsSort } from "@applaud/shared";

const PAGE_SIZE = 50;

const SORT_OPTIONS: { value: RecordingsSort; label: string }[] = [
  { value: "date_desc", label: "Newest first" },
  { value: "date_asc", label: "Oldest first" },
  { value: "duration_desc", label: "Longest first" },
  { value: "duration_asc", label: "Shortest first" },
  { value: "size_desc", label: "Largest first" },
  { value: "size_asc", label: "Smallest first" },
];

function dateStringToFromMs(s: string): number | undefined {
  if (!s) return undefined;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

function dateStringToToMs(s: string): number | undefined {
  if (!s) return undefined;
  const d = new Date(`${s}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

function StatusDots({ row }: { row: RecordingRow }): JSX.Element {
  const hasAudio = !!row.audioDownloadedAt;
  const hasTranscript = !!row.transcriptDownloadedAt;
  const hasSummary =
    !!row.summaryDownloadedAt && (row.isTrash || hasTranscript);
  return (
    <div className="flex items-center gap-2 text-[10px] font-label font-bold uppercase tracking-widest">
      <StatusPill on={hasAudio} label="audio" color="secondary" />
      <StatusPill on={hasTranscript} label="transcript" color="primary" />
      <StatusPill on={hasSummary} label="summary" color="primary" />
    </div>
  );
}

function StatusPill({
  on,
  label,
  color,
}: {
  on: boolean;
  label: string;
  color: "primary" | "secondary";
}): JSX.Element {
  if (on) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 bg-surface-container-highest ${
          color === "secondary" ? "text-secondary" : "text-primary"
        }`}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            color === "secondary" ? "bg-secondary" : "bg-primary"
          }`}
        />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 bg-surface-container-highest text-outline">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-outline-variant" />
      {label}
    </span>
  );
}

function RecordingIcon({ isTrash }: { isTrash: boolean }): JSX.Element {
  return (
    <div className="w-12 h-12 flex-shrink-0 bg-surface-container-highest rounded-lg flex items-center justify-center">
      {isTrash ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-tertiary">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
    </div>
  );
}

export function Dashboard(): JSX.Element {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const [sort, setSort] = useState<RecordingsSort>("date_desc");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [starredOnly, setStarredOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { bulkMoveToTrash } = useRecordingActions();
  const toast = useToast();
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, sort, fromDate, toDate, starredOnly]);
  // Selection is page-scoped; clear it whenever the visible rows change.
  useEffect(() => {
    setSelected(new Set());
  }, [debouncedSearch, sort, fromDate, toDate, starredOnly, page]);
  const list = useQuery({
    queryKey: ["recordings", { search: debouncedSearch, sort, fromDate, toDate, starredOnly, page }],
    queryFn: () =>
      api.listRecordings({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        search: debouncedSearch || undefined,
        sort,
        from: dateStringToFromMs(fromDate),
        to: dateStringToToMs(toDate),
        starred: starredOnly || undefined,
      }),
  });
  const [triggering, setTriggering] = useState(false);
  const [resyncingIds, setResyncingIds] = useState<Set<string>>(new Set());
  const [resyncErrors, setResyncErrors] = useState<Record<string, string>>({});

  const resyncRecording = async (id: string, e: MouseEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    if (resyncingIds.has(id)) return;
    setResyncingIds((prev) => new Set(prev).add(id));
    setResyncErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      await api.resyncRecording(id);
      await qc.invalidateQueries({ queryKey: ["recordings"] });
    } catch (err) {
      setResyncErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setResyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const triggerSync = async (): Promise<void> => {
    setTriggering(true);
    try {
      await api.syncTrigger();
      await qc.invalidateQueries({ queryKey: ["recordings"] });
      await qc.invalidateQueries({ queryKey: ["sync-status"] });
    } finally {
      setTriggering(false);
    }
  };

  const toggleSelected = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkTrash = async (): Promise<void> => {
    if (await bulkMoveToTrash([...selected])) setSelected(new Set());
  };

  const bulkResync = async (): Promise<void> => {
    const ids = [...selected];
    let okCount = 0;
    let firstError: string | null = null;
    for (const id of ids) {
      try {
        await api.resyncRecording(id);
        okCount++;
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err.message : String(err);
      }
    }
    await qc.invalidateQueries({ queryKey: ["recordings"] });
    if (okCount === ids.length) {
      toast.success(`${okCount} recording${okCount === 1 ? "" : "s"} resynced.`);
    } else {
      toast.error(`${okCount}/${ids.length} resynced — first failure: ${firstError ?? "unknown error"}`);
    }
    setSelected(new Set());
  };

  return (
    <div>
      {/* Page Header */}
      <header className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-2">
          <h1 className="text-5xl font-black leading-none tracking-tighter text-on-surface" style={{ fontWeight: 900 }}>
            Recordings
          </h1>
          <p className="text-on-surface-variant font-label text-sm tracking-wide uppercase">
            {list.data?.total ?? "…"} items total
            {list.data?.totalBytes != null && (
              <>
                <span className="mx-2 text-outline-variant opacity-40">|</span>
                {formatBytes(list.data.totalBytes)} used
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="relative flex-grow md:w-64">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="input pl-10 py-3 border-transparent"
              placeholder="Search archives..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            className="btn-primary py-3 px-5 flex items-center gap-2 shadow-lg shadow-primary/10"
            onClick={() => void triggerSync()}
            disabled={triggering}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={triggering ? "animate-spin" : ""}>
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
              <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
            </svg>
            {triggering ? "Syncing…" : "Sync Now"}
          </button>
        </div>
      </header>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-on-surface-variant">
          Sort
          <select
            className="input py-2 px-3 border-transparent text-sm"
            value={sort}
            onChange={(e) => setSort(e.target.value as RecordingsSort)}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-on-surface-variant">
          From
          <input
            type="date"
            className="input py-2 px-3 border-transparent text-sm"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-on-surface-variant">
          To
          <input
            type="date"
            className="input py-2 px-3 border-transparent text-sm"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
            starredOnly
              ? "border-tertiary/50 bg-tertiary/10 text-tertiary"
              : "border-outline-variant/40 text-on-surface-variant hover:text-on-surface"
          }`}
          onClick={() => setStarredOnly((v) => !v)}
          aria-pressed={starredOnly}
          title="Show only recordings starred in the Plaud app"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={starredOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
          Starred
        </button>
        {(fromDate || toDate) && (
          <button
            type="button"
            className="btn-ghost px-3 py-2 text-sm"
            onClick={() => {
              setFromDate("");
              setToDate("");
            }}
          >
            Clear dates
          </button>
        )}
      </div>

      {/* Bulk-selection action bar */}
      {selected.size > 0 && (
        <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-on-surface">
            {selected.size} selected
          </span>
          <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => void bulkResync()}>
            Resync selected
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-xs rounded-lg border border-error/30 text-error font-semibold hover:bg-error/10 transition-colors"
            onClick={() => void bulkTrash()}
          >
            Move to Trash
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {list.isLoading && (
        <div className="grid gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bg-surface-container rounded-xl h-[76px] animate-pulse" />
          ))}
        </div>
      )}
      {list.error && (
        <div className="card flex flex-col items-center gap-3 p-12 text-center">
          <p className="text-error font-medium">Couldn't load recordings.</p>
          <p className="text-sm text-on-surface-variant">
            {list.error instanceof ApiError ? list.error.message : "Check your connection and try again."}
          </p>
          <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={() => void list.refetch()}>
            Retry
          </button>
        </div>
      )}

      {list.data && list.data.items.length === 0 && (
        <div className="card flex flex-col items-center justify-center p-12 text-center">
          <p className="text-on-surface">No recordings yet.</p>
          <p className="mt-1 text-sm text-on-surface-variant">
            Click <span className="font-medium">Sync now</span> or wait for the next poll
            cycle.
          </p>
        </div>
      )}

      {/* Recordings Grid */}
      {list.data && list.data.items.length > 0 && (
        <div className="grid gap-3">
          {list.data.items.map((r: RecordingRow) => (
            <Link
              key={r.id}
              to={`/recordings/${r.id}`}
              className="group bg-surface-container hover:bg-surface-container-high transition-all duration-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 relative overflow-hidden"
            >
              {/* Hover glow */}
              <div className="absolute inset-0 bg-gradient-to-r from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="relative flex items-center gap-4">
                {/* Inside a <Link>: preventDefault stops anchor navigation; we toggle manually. */}
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary shrink-0 cursor-pointer"
                  checked={selected.has(r.id)}
                  aria-label={`Select ${r.filename}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleSelected(r.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleSelected(r.id);
                    }
                  }}
                  readOnly
                />
                <RecordingIcon isTrash={r.isTrash} />
                <div>
                  <h3 className="text-base font-bold text-on-surface leading-tight group-hover:text-primary transition-colors flex items-center gap-1.5">
                    {r.isStarred && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-tertiary shrink-0" aria-label="Starred in Plaud" role="img"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                    )}
                    {r.displayName ?? r.filename}
                  </h3>
                  <div className="mt-1 flex items-center gap-3 font-label text-[11px] tracking-wider text-on-surface-variant uppercase">
                    <span>{formatDateShort(r.startTime)}</span>
                    <span className="w-1 h-1 rounded-full bg-outline-variant" />
                    <span>{formatDurationClock(r.durationMs)}</span>
                    <span className="w-1 h-1 rounded-full bg-outline-variant" />
                    <span>{formatBytes(r.filesizeBytes)}</span>
                  </div>
                  {resyncErrors[r.id] && (
                    <p className="mt-1 text-xs text-error">Resync failed: {resyncErrors[r.id]}</p>
                  )}
                </div>
              </div>
              <div className="relative flex items-center gap-3">
                <StatusDots row={r} />
                <button
                  className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-primary text-on-primary hover:bg-primary/90 transition-all active:scale-95 shadow-sm"
                  onClick={(e) => void resyncRecording(r.id, e)}
                  title="Resync recording"
                  aria-label="Resync recording"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={resyncingIds.has(r.id) ? "animate-spin" : ""}>
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                    <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
                  </svg>
                </button>
              </div>
            </Link>
          ))}
        </div>
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
