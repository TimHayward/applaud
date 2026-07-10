import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, useMemo } from "react";
import { sanitizePlaudSummaryMarkdown } from "@applaud/shared";
import { api, mediaUrl, ApiError } from "../api.js";
import { useToast } from "../components/Toast.js";
import { useRecordingActions } from "../hooks/useRecordingActions.js";
import { AudioPlayer } from "../components/AudioPlayer.js";
import { TranscriptCard } from "../components/TranscriptCard.js";
import { SummaryPanel } from "../components/SummaryPanel.js";
import { AttachmentsCard } from "../components/AttachmentsCard.js";
import { formatDurationVerbose, formatDateTime, formatBytes } from "../lib/format.js";

export function RecordingDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const actions = useRecordingActions();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isResyncing, setIsResyncing] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const id = params.id ?? "";
  const q = useQuery({
    queryKey: ["recording", id],
    queryFn: () => api.recordingDetail(id),
    enabled: !!id,
  });

  const summaryMarkdownDisplay = useMemo(() => {
    const raw = q.data?.recording.summaryMarkdown;
    const rec = q.data?.recording;
    if (!raw || !rec) return null;
    return sanitizePlaudSummaryMarkdown(raw, {
      startTimeMs: rec.startTime,
      endTimeMs: rec.endTime,
    });
  }, [q.data]);

  if (q.isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-10 w-2/3 max-w-md bg-surface-container rounded-lg animate-pulse" />
        <div className="h-40 bg-surface-container rounded-xl animate-pulse" />
        <div className="h-64 bg-surface-container rounded-xl animate-pulse" />
      </div>
    );
  }
  if (q.error || !q.data) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="card flex flex-col items-center gap-3 p-12 text-center">
        <p className="text-error font-medium">{notFound ? "Recording not found." : "Couldn't load this recording."}</p>
        {!notFound && (
          <p className="text-sm text-on-surface-variant">
            {q.error instanceof Error ? q.error.message : "Check your connection and try again."}
          </p>
        )}
        <div className="flex gap-3">
          {!notFound && (
            <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={() => void q.refetch()}>
              Retry
            </button>
          )}
          <Link to="/" className="btn-ghost px-4 py-2 text-sm inline-flex items-center">← Back</Link>
        </div>
      </div>
    );
  }

  const { recording: r, mediaBase } = q.data;

  const del = async (): Promise<void> => {
    if (await actions.moveToTrash(r.id)) navigate("/trash");
  };

  const restore = async (): Promise<void> => {
    if (await actions.restore(r.id)) void q.refetch();
  };

  const purgeNow = async (): Promise<void> => {
    if (await actions.purgeNow(r.id, r.filename)) navigate("/trash");
  };

  const resync = async (): Promise<void> => {
    setResyncError(null);
    setIsResyncing(true);
    try {
      await api.resyncRecording(r.id);
      await qc.invalidateQueries({ queryKey: ["recording", id] });
      await qc.invalidateQueries({ queryKey: ["recordings"] });
      toast.success("Resync complete.");
    } catch (err) {
      setResyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsResyncing(false);
    }
  };

  const startEditingTitle = (): void => {
    setTitleDraft(r.displayName ?? r.filename);
    setEditingTitle(true);
  };

  const saveTitle = async (): Promise<void> => {
    const trimmed = titleDraft.trim();
    // Empty, or matching Plaud's filename exactly, means "no override".
    const next = trimmed.length === 0 || trimmed === r.filename ? null : trimmed;
    try {
      await api.renameRecording(r.id, next);
      await qc.invalidateQueries({ queryKey: ["recording", id] });
      await qc.invalidateQueries({ queryKey: ["recordings"] });
      setEditingTitle(false);
      toast.success(next ? "Title updated." : "Title reverted to Plaud's filename.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(r.id);
      toast.success("Recording ID copied.");
    } catch {
      toast.error("Couldn't copy to clipboard.");
    }
  };

  const isComplete = !!r.audioDownloadedAt && (!!r.transcriptDownloadedAt || r.isTrash);

  const downloadFiles: { label: string; file: string }[] = [
    ...(r.transcriptDownloadedAt
      ? [
          { label: "Transcript (.txt)", file: "transcript.txt" },
          { label: "Transcript raw (.json)", file: "transcript.json" },
        ]
      : []),
    ...(summaryMarkdownDisplay ? [{ label: "Summary (.md)", file: "summary.md" }] : []),
    ...(r.metadata ? [{ label: "Metadata (.json)", file: "metadata.json" }] : []),
  ];

  return (
    <div>
      {r.userDeletedAt && (
        <div className="mb-6 rounded-xl border border-tertiary/30 bg-tertiary/10 p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <p className="text-sm text-on-surface">
            This recording is in Trash.
            {r.userPurgeAt ? (
              <>
                {" "}
                Local files will be removed after{" "}
                <span className="font-semibold text-on-surface">{formatDateTime(r.userPurgeAt)}</span> unless you restore it.
              </>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-2 shrink-0">
            <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={() => void restore()}>
              Restore
            </button>
            <button
              type="button"
              className="px-4 py-2 text-sm rounded-lg border border-error/30 text-error font-semibold hover:bg-error/10 transition-colors"
              onClick={() => void purgeNow()}
            >
              Delete permanently
            </button>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="mb-8">
        <nav className="flex items-center gap-2 text-xs font-label uppercase tracking-widest text-on-surface-variant mb-4">
          <Link to="/" className="hover:text-on-surface transition-colors">Recordings</Link>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          <span className="text-primary truncate max-w-md">{r.displayName ?? r.filename}</span>
        </nav>
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <div className="flex items-center gap-2 mb-2">
                <input
                  autoFocus
                  className="input text-2xl md:text-3xl font-black py-2 flex-1 min-w-0"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveTitle();
                    else if (e.key === "Escape") setEditingTitle(false);
                  }}
                />
                <button className="btn-primary px-3 py-2 text-sm shrink-0" onClick={() => void saveTitle()}>
                  Save
                </button>
                <button className="btn-ghost px-3 py-2 text-sm shrink-0" onClick={() => setEditingTitle(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 mb-1 group/title">
                <h1 className="text-4xl md:text-5xl font-black text-on-surface tracking-tight truncate">
                  {r.displayName ?? r.filename}
                </h1>
                <button
                  onClick={startEditingTitle}
                  className="p-1.5 text-on-surface-variant hover:text-on-surface md:opacity-0 md:group-hover/title:opacity-100 transition-opacity shrink-0"
                  title="Rename"
                  aria-label="Rename recording"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                </button>
              </div>
            )}
            {r.displayName && !editingTitle && (
              <p className="text-xs text-on-surface-variant mb-2">
                Renamed locally — Plaud calls it "{r.filename}". Reverts on the next resync.
              </p>
            )}
            <div className="flex items-center gap-4 text-on-surface-variant font-label text-sm">
              <div className="flex items-center gap-1.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                <span>{formatDateTime(r.startTime)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                <span>{formatDurationVerbose(r.durationMs)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                <span>{formatBytes(r.filesizeBytes)}</span>
              </div>
            </div>
          </div>
          {!r.userDeletedAt ? (
            <div className="flex flex-wrap gap-3">
              <button
                className="flex items-center gap-2 px-4 py-2 bg-primary text-on-primary text-sm font-semibold rounded-lg hover:bg-primary/90 transition-all active:scale-95 whitespace-nowrap disabled:opacity-50 disabled:pointer-events-none"
                onClick={() => void resync()}
                disabled={isResyncing || !r.audioDownloadedAt}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={isResyncing ? "animate-spin" : ""}>
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                  <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
                </svg>
                {isResyncing ? "Resyncing..." : "Resync Recording"}
              </button>
              <button className="flex items-center gap-2 px-4 py-2 border border-error/20 hover:border-error/50 text-error text-sm font-semibold rounded-lg transition-all active:scale-95 whitespace-nowrap" onClick={() => void del()}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                Move to Trash
              </button>
            </div>
          ) : null}
        </div>
        {resyncError ? <p className="mt-3 text-sm text-error">{resyncError}</p> : null}
      </div>

      {/* Layout */}
      <div className="grid gap-6 lg:grid-cols-10">
        <div className="lg:col-span-7 space-y-6">
          {r.audioDownloadedAt && (
            <AudioPlayer
              src={mediaUrl(`${mediaBase}/audio.ogg`)}
              recordingId={r.id}
              audioRef={audioRef}
              onTimeChange={setCurrentTime}
            />
          )}

          {r.transcriptText ? (
            <TranscriptCard
              text={r.transcriptText}
              currentTime={currentTime}
              onSeek={(sec) => { if (audioRef.current) { audioRef.current.currentTime = sec; void audioRef.current.play(); } }}
            />
          ) : r.audioDownloadedAt ? (
            <section className="card p-6">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-on-surface-variant font-label">Transcript</h2>
              <p className="text-sm text-on-surface-variant">
                {r.isTrash
                  ? "This file is deleted in Plaud. Applaud always pulls audio; transcript and summary are checked periodically in the background when Plaud has them again (they do not count as pending sync work)."
                  : "Transcript is still pending on Plaud's side. We'll pull it on the next sync cycle."}
              </p>
            </section>
          ) : null}
        </div>

        {/* Sidebar */}
        <aside className="lg:col-span-3 space-y-6">
          {summaryMarkdownDisplay && <SummaryPanel markdown={summaryMarkdownDisplay} />}
          <AttachmentsCard attachments={r.attachments} />
          {downloadFiles.length > 0 && (
            <section className="card p-6">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-on-surface-variant font-label">Files</h2>
              <ul className="space-y-1.5">
                {downloadFiles.map((f) => (
                  <li key={f.file}>
                    <a href={mediaUrl(`${mediaBase}/${f.file}`)} className="text-sm text-primary hover:underline" download>
                      {f.label}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="card p-6 text-sm">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-on-surface-variant font-label">Details</h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-[10px] font-label text-on-surface-variant uppercase tracking-wider">Recording ID</dt>
                <dd className="mt-1 flex items-center gap-1.5">
                  <span className="font-label text-xs text-primary bg-primary/10 px-2 py-1 rounded break-all">{r.id}</span>
                  <button
                    onClick={() => void copyId()}
                    className="p-1 text-on-surface-variant hover:text-on-surface transition-colors shrink-0"
                    title="Copy recording ID"
                    aria-label="Copy recording ID"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  </button>
                </dd>
              </div>
              <Meta label="Device" value={r.serialNumber} mono />
              <Meta label="Folder" value={r.folder} mono />
              <Meta label="Downloaded" value={r.audioDownloadedAt ? formatDateTime(r.audioDownloadedAt) : "pending"} />
              <Meta label="Transcript downloaded" value={r.transcriptDownloadedAt ? formatDateTime(r.transcriptDownloadedAt) : "pending"} />
              <Meta label="Webhook: audio_ready" value={r.webhookAudioFiredAt ? formatDateTime(r.webhookAudioFiredAt) : "not sent"} />
              <Meta label="Webhook: transcript_ready" value={r.webhookTranscriptFiredAt ? formatDateTime(r.webhookTranscriptFiredAt) : "not sent"} />
              {r.lastError && <Meta label="Last error" value={r.lastError} />}
              <div className="pt-3 border-t border-outline-variant/30 flex items-center justify-between">
                <span className="text-[10px] font-label text-on-surface-variant uppercase tracking-wider">Last Synced</span>
                <span className={`text-xs font-bold ${isComplete ? "text-secondary" : "text-tertiary"}`}>{isComplete ? "COMPLETE" : "PENDING"}</span>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div>
      <dt className="text-[10px] font-label text-on-surface-variant uppercase tracking-wider">{label}</dt>
      <dd className={`mt-0.5 break-all text-on-surface ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
