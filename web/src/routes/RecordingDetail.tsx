import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function RecordingDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const id = params.id ?? "";
  const q = useQuery({
    queryKey: ["recording", id],
    queryFn: () => api.recordingDetail(id),
    enabled: !!id,
  });

  if (q.isLoading) return <p className="text-ink-500">loading…</p>;
  if (q.error || !q.data)
    return (
      <div>
        <p className="text-red-600">Not found.</p>
        <Link to="/" className="btn-ghost mt-3 inline-flex">
          ← Back
        </Link>
      </div>
    );

  const { recording: r, mediaBase } = q.data;

  const del = async (): Promise<void> => {
    if (!confirm("Delete the local copy of this recording? (Plaud is unaffected.)")) return;
    await api.deleteRecording(r.id);
    await qc.invalidateQueries({ queryKey: ["recordings"] });
    navigate("/");
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <Link to="/" className="text-sm text-ink-500 hover:text-ink-700">
            ← Recordings
          </Link>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-ink-900">
            {r.filename}
          </h1>
          <div className="mt-1 text-sm text-ink-500">
            {formatDate(r.startTime)} · {formatDuration(r.durationMs)} ·{" "}
            {(r.filesizeBytes / 1024 / 1024).toFixed(1)} MB
          </div>
        </div>
        <button className="btn-secondary" onClick={() => void del()}>
          Delete local copy
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {r.audioDownloadedAt && (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
                Audio
              </h2>
              <audio
                src={`${mediaBase}/audio.ogg`}
                controls
                className="w-full"
                preload="metadata"
              />
              <div className="mt-2 text-xs text-ink-500">
                <a href={`${mediaBase}/audio.ogg`} className="underline" download>
                  Download .ogg
                </a>
              </div>
            </div>
          )}

          {r.transcriptText ? (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
                Transcript
              </h2>
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-800">
                {r.transcriptText}
              </pre>
            </div>
          ) : r.audioDownloadedAt ? (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
                Transcript
              </h2>
              <p className="text-sm text-ink-500">
                Transcript is still pending on Plaud's side. We'll pull it on the next
                sync cycle.
              </p>
            </div>
          ) : null}
        </div>

        <aside className="space-y-6">
          {r.summaryMarkdown && (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
                Summary
              </h2>
              <div className="prose prose-sm prose-ink max-w-none whitespace-pre-wrap text-sm text-ink-800">
                {r.summaryMarkdown}
              </div>
            </div>
          )}
          <div className="card p-5 text-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
              Details
            </h2>
            <dl className="space-y-2">
              <Meta label="Recording ID" value={r.id} mono />
              <Meta label="Device" value={r.serialNumber} mono />
              <Meta label="Folder" value={r.folder} mono />
              <Meta
                label="Downloaded"
                value={r.audioDownloadedAt ? formatDate(r.audioDownloadedAt) : "pending"}
              />
              <Meta
                label="Transcript downloaded"
                value={
                  r.transcriptDownloadedAt
                    ? formatDate(r.transcriptDownloadedAt)
                    : "pending"
                }
              />
              {r.lastError && <Meta label="Last error" value={r.lastError} />}
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Meta({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className={`mt-0.5 break-all text-ink-800 ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
