import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import type { RecordingRow } from "@applaud/shared";

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusDots({ row }: { row: RecordingRow }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <Dot on={!!row.audioDownloadedAt} label="audio" />
      <Dot on={!!row.transcriptDownloadedAt} label="transcript" />
      <Dot on={!!row.summaryPath && !!row.transcriptDownloadedAt} label="summary" />
    </div>
  );
}

function Dot({ on, label }: { on: boolean; label: string }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${
        on ? "bg-emerald-100 text-emerald-700" : "bg-ink-100 text-ink-400"
      }`}
    >
      <span
        className={`inline-block h-1 w-1 rounded-full ${
          on ? "bg-emerald-500" : "bg-ink-300"
        }`}
      />
      {label}
    </span>
  );
}

export function Dashboard(): JSX.Element {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const list = useQuery({
    queryKey: ["recordings", { search }],
    queryFn: () => api.listRecordings({ limit: 200, search: search || undefined }),
  });
  const [triggering, setTriggering] = useState(false);

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

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
            Recordings
          </h1>
          <p className="text-sm text-ink-500">
            {list.data?.total ?? "…"} total
          </p>
        </div>
        <div className="flex gap-2">
          <input
            className="input max-w-xs"
            placeholder="Search filenames…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn-primary" onClick={() => void triggerSync()} disabled={triggering}>
            {triggering ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>

      {list.isLoading && <p className="text-ink-500">loading…</p>}
      {list.error && (
        <p className="text-red-600">Failed to load recordings: {String(list.error)}</p>
      )}

      {list.data && list.data.items.length === 0 && (
        <div className="card flex flex-col items-center justify-center p-12 text-center">
          <p className="text-ink-700">No recordings yet.</p>
          <p className="mt-1 text-sm text-ink-500">
            Click <span className="font-medium">Sync now</span> or wait for the next poll
            cycle.
          </p>
        </div>
      )}

      {list.data && list.data.items.length > 0 && (
        <div className="divide-y divide-ink-200 overflow-hidden rounded-lg border border-ink-200 bg-white">
          {list.data.items.map((r) => (
            <Link
              key={r.id}
              to={`/recordings/${r.id}`}
              className="flex items-center gap-4 px-5 py-4 hover:bg-ink-50"
            >
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium text-ink-900">{r.filename}</div>
                <div className="mt-0.5 flex items-center gap-3 text-xs text-ink-500">
                  <span>{formatDate(r.startTime)}</span>
                  <span>·</span>
                  <span>{formatDuration(r.durationMs)}</span>
                  <span>·</span>
                  <span>{(r.filesizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                </div>
              </div>
              <StatusDots row={r} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
