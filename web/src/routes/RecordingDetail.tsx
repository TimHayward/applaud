import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import Markdown from "react-markdown";
import { sanitizePlaudSummaryMarkdown } from "@applaud/shared";
import { api } from "../api.js";
import { Waveform } from "../components/Waveform.js";

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

function formatTimeCompact(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

interface TranscriptBlock {
  timestamp: string;
  seconds: number;
  speaker: string;
  text: string;
}

function parseTimestamp(ts: string): number {
  const parts = ts.split(":").map((p) => parseInt(p, 10));
  if (parts.length === 3) {
    return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  }
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}

function parseTranscript(raw: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const regex = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+(.+?):\s+([\s\S]*?)(?=\n\n\[|\s*$)/gm;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const ts = match[1] ?? "";
    blocks.push({
      timestamp: ts,
      seconds: parseTimestamp(ts),
      speaker: (match[2] ?? "").trim(),
      text: (match[3] ?? "").trim(),
    });
  }
  return blocks;
}

const SPEAKER_COLORS = [
  "#00c7ae", "#a3e635", "#ffbe9c", "#818cf8", "#fb7185", "#fbbf24",
  "#38bdf8", "#a78bfa", "#34d399", "#fb923c", "#94a3b8", "#fda4af",
];
const UNKNOWN_COLOR = "#94a3b8";

function isUnknownSpeaker(speaker: string): boolean {
  return /^speaker\s*\d*$/i.test(speaker.trim());
}

function speakerColor(speaker: string, map: Map<string, string>): string {
  if (isUnknownSpeaker(speaker)) return UNKNOWN_COLOR;
  if (!map.has(speaker)) {
    map.set(speaker, SPEAKER_COLORS[map.size % SPEAKER_COLORS.length] ?? SPEAKER_COLORS[0]!);
  }
  return map.get(speaker) ?? SPEAKER_COLORS[0]!;
}

// --- Search helpers ---

interface SearchMatch {
  blockIndex: number;
  startChar: number;
  length: number;
}

function findAllMatches(blocks: TranscriptBlock[], query: string): SearchMatch[] {
  if (!query) return [];
  const lower = query.toLowerCase();
  const matches: SearchMatch[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const text = (blocks[bi]?.text ?? "").toLowerCase();
    let pos = 0;
    while (pos < text.length) {
      const idx = text.indexOf(lower, pos);
      if (idx === -1) break;
      matches.push({ blockIndex: bi, startChar: idx, length: query.length });
      pos = idx + 1;
    }
  }
  return matches;
}

function HighlightedText({
  text,
  matches,
  activeMatchIndex,
  globalOffset,
}: {
  text: string;
  matches: SearchMatch[];
  activeMatchIndex: number;
  globalOffset: number;
}): JSX.Element {
  if (matches.length === 0) return <>{text}</>;
  const parts: JSX.Element[] = [];
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    if (m.startChar > cursor) {
      parts.push(<span key={`t${cursor}`}>{text.slice(cursor, m.startChar)}</span>);
    }
    const isActive = globalOffset + i === activeMatchIndex;
    parts.push(
      <mark
        key={`m${m.startChar}`}
        className={`rounded px-0.5 ${
          isActive ? "bg-primary text-on-primary" : "bg-primary/25 text-on-surface"
        }`}
      >
        {text.slice(m.startChar, m.startChar + m.length)}
      </mark>,
    );
    cursor = m.startChar + m.length;
  }
  if (cursor < text.length) {
    parts.push(<span key={`t${cursor}`}>{text.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}

// --- Main page ---

export function RecordingDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const audioRef = useRef<HTMLAudioElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [isResyncing, setIsResyncing] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);
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

  const onTimeUpdate = useCallback(() => {
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
  }, []);

  const onLoadedMetadata = useCallback(() => {
    if (audioRef.current) setAudioDuration(audioRef.current.duration);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = (): void => setIsPlaying(true);
    const onPause = (): void => setIsPlaying(false);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    if (audio.duration) setAudioDuration(audio.duration);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [onTimeUpdate, onLoadedMetadata, q.data]);

  if (q.isLoading) return <p className="text-on-surface-variant">loading…</p>;
  if (q.error || !q.data)
    return (
      <div>
        <p className="text-error">Not found.</p>
        <Link to="/" className="btn-ghost mt-3 inline-flex">← Back</Link>
      </div>
    );

  const { recording: r, mediaBase } = q.data;

  const del = async (): Promise<void> => {
    if (
      !confirm(
        "Move this recording to Trash? Local files stay until automatic purge (~7 days). You can restore from Trash until then. Nothing is deleted in Plaud.",
      )
    ) {
      return;
    }
    await api.deleteRecording(r.id);
    await qc.invalidateQueries({ queryKey: ["recordings"] });
    await qc.invalidateQueries({ queryKey: ["recordings-trash"] });
    navigate("/trash");
  };

  const restore = async (): Promise<void> => {
    await api.restoreRecording(r.id);
    await qc.invalidateQueries({ queryKey: ["recordings"] });
    await qc.invalidateQueries({ queryKey: ["recordings-trash"] });
    await qc.invalidateQueries({ queryKey: ["recording", id] });
    void q.refetch();
  };

  const purgeNow = async (): Promise<void> => {
    if (
      !confirm(
        "Permanently delete this recording now? Local files will be removed immediately and the Plaud id will be added to the sync blocklist (same as after the 7-day wait). This cannot be undone.",
      )
    ) {
      return;
    }
    await api.purgeRecordingFromTrash(r.id);
    await qc.invalidateQueries({ queryKey: ["recordings"] });
    await qc.invalidateQueries({ queryKey: ["recordings-trash"] });
    await qc.invalidateQueries({ queryKey: ["sync-blocklist"] });
    await qc.invalidateQueries({ queryKey: ["recording", id] });
    navigate("/trash");
  };

  const resync = async (): Promise<void> => {
    setResyncError(null);
    setIsResyncing(true);
    try {
      await api.resyncRecording(r.id);
      await qc.invalidateQueries({ queryKey: ["recording", id] });
      await qc.invalidateQueries({ queryKey: ["recordings"] });
    } catch (err) {
      setResyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsResyncing(false);
    }
  };

  const togglePlay = (): void => {
    if (!audioRef.current) return;
    if (audioRef.current.paused) { audioRef.current.play(); } else { audioRef.current.pause(); }
  };
  const skipBack = (): void => { if (audioRef.current) audioRef.current.currentTime -= 10; };
  const skipForward = (): void => { if (audioRef.current) audioRef.current.currentTime += 30; };

  const isComplete =
    !!r.audioDownloadedAt && (!!r.transcriptDownloadedAt || r.isTrash);

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
                <span className="font-semibold text-on-surface">{formatDate(r.userPurgeAt)}</span> unless you restore it.
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
          <span className="text-primary truncate max-w-md">{r.filename}</span>
        </nav>
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-4xl md:text-5xl font-black text-on-surface tracking-tight mb-2">{r.filename}</h1>
            <div className="flex items-center gap-4 text-on-surface-variant font-label text-sm">
              <div className="flex items-center gap-1.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                <span>{formatDate(r.startTime)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                <span>{formatDuration(r.durationMs)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                <span>{(r.filesizeBytes / 1024 / 1024).toFixed(1)} MB</span>
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
          {/* Audio */}
          {r.audioDownloadedAt && (
            <section className="card p-6 overflow-hidden">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <button onClick={togglePlay} className="w-12 h-12 flex items-center justify-center bg-primary rounded-xl text-on-primary shadow-lg shadow-primary/20 active:scale-90 transition-transform">
                    {isPlaying ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3" /></svg>
                    )}
                  </button>
                  <button onClick={skipBack} className="p-2 text-on-surface-variant hover:text-primary transition-colors" title="Skip back 10 seconds">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /><text x="12" y="15.5" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="bold" fontFamily="sans-serif">10</text></svg>
                  </button>
                  <button onClick={skipForward} className="p-2 text-on-surface-variant hover:text-primary transition-colors" title="Skip forward 30 seconds">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" /><text x="12" y="15.5" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="bold" fontFamily="sans-serif">30</text></svg>
                  </button>
                </div>
                <div className="flex items-center gap-2 font-label text-sm">
                  <span className="text-primary font-bold">{formatTimeCompact(currentTime)}</span>
                  <span className="text-on-surface-variant">/ {formatTimeCompact(audioDuration)}</span>
                </div>
              </div>
              <Waveform recordingId={r.id} progress={audioDuration > 0 ? currentTime / audioDuration : 0} onSeek={(frac) => { if (audioRef.current && audioDuration > 0) audioRef.current.currentTime = frac * audioDuration; }} />
              <audio ref={audioRef} src={`${mediaBase}/audio.ogg`} preload="metadata" className="hidden" />
              <div className="mt-3 flex justify-end">
                <a href={`${mediaBase}/audio.ogg`} className="btn-ghost text-xs" download>Download .ogg</a>
              </div>
            </section>
          )}

          {/* Transcript */}
          {r.transcriptText ? (
            <TranscriptCard
              text={r.transcriptText}
              currentTime={currentTime}
              transcriptRef={transcriptRef}
              blockRefs={blockRefs}
              onSeek={(sec) => { if (audioRef.current) { audioRef.current.currentTime = sec; audioRef.current.play(); } }}
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
          {summaryMarkdownDisplay && (
            <>
              <section className="bg-surface-container-high rounded-xl p-6 shadow-lg border border-outline-variant/20 relative">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-label uppercase tracking-widest text-tertiary flex items-center gap-2 font-semibold">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                    AI Summary
                  </h2>
                  <button
                    onClick={() => setSummaryExpanded(true)}
                    className="p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded-lg transition-colors"
                    title="Expand summary"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                      <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
                    </svg>
                  </button>
                </div>
                <div className="overflow-hidden relative" style={{ maxHeight: "50vh" }}>
                  <div className="prose prose-sm prose-invert max-w-none text-sm leading-relaxed text-on-surface [&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-on-surface [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-on-surface [&_h3]:text-sm [&_h3]:font-bold [&_h3]:text-on-surface [&_p]:text-on-surface-variant [&_li]:text-on-surface-variant [&_strong]:text-on-surface [&_a]:text-primary [&_ul]:space-y-1 [&_ol]:space-y-1">
                    <Markdown>{summaryMarkdownDisplay}</Markdown>
                  </div>
                  {/* Fade overlay at bottom */}
                  <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-surface-container-high to-transparent pointer-events-none" />
                </div>
              </section>

              {/* Expanded modal */}
              {summaryExpanded && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-6" onClick={() => setSummaryExpanded(false)}>
                  <div className="absolute inset-0 bg-surface/80 backdrop-blur-sm" />
                  <div
                    className="relative bg-surface-container-high rounded-2xl border border-outline-variant/20 shadow-2xl w-full max-w-4xl"
                    style={{ maxHeight: "90vh" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between p-6 border-b border-outline-variant/30">
                      <h2 className="text-sm font-label uppercase tracking-widest text-tertiary flex items-center gap-2 font-semibold">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                        AI Summary
                      </h2>
                      <button
                        onClick={() => setSummaryExpanded(false)}
                        className="p-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded-lg transition-colors"
                        title="Close"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                    <div className="overflow-y-auto p-6" style={{ maxHeight: "calc(90vh - 73px)" }}>
                      <div className="prose prose-sm prose-invert max-w-none text-sm leading-relaxed text-on-surface [&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-on-surface [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-on-surface [&_h3]:text-sm [&_h3]:font-bold [&_h3]:text-on-surface [&_p]:text-on-surface-variant [&_li]:text-on-surface-variant [&_strong]:text-on-surface [&_a]:text-primary [&_ul]:space-y-1 [&_ol]:space-y-1">
                        <Markdown>{summaryMarkdownDisplay}</Markdown>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          <section className="card p-6 text-sm">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-on-surface-variant font-label">Details</h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-[10px] font-label text-on-surface-variant uppercase tracking-wider">Recording ID</dt>
                <dd className="mt-1"><span className="font-label text-xs text-primary bg-primary/10 px-2 py-1 rounded">{r.id}</span></dd>
              </div>
              <Meta label="Device" value={r.serialNumber} mono />
              <Meta label="Folder" value={r.folder} mono />
              <Meta label="Downloaded" value={r.audioDownloadedAt ? formatDate(r.audioDownloadedAt) : "pending"} />
              <Meta label="Transcript downloaded" value={r.transcriptDownloadedAt ? formatDate(r.transcriptDownloadedAt) : "pending"} />
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

// --- Transcript card with search ---

function TranscriptCard({
  text,
  currentTime,
  transcriptRef,
  blockRefs,
  onSeek,
}: {
  text: string;
  currentTime: number;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  blockRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
  onSeek: (seconds: number) => void;
}): JSX.Element {
  const blocks = useMemo(() => parseTranscript(text), [text]);
  const speakerMap = useMemo(() => new Map<string, string>(), []);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const allMatches = useMemo(() => findAllMatches(blocks, searchQuery), [blocks, searchQuery]);

  useEffect(() => { setActiveMatch(0); }, [searchQuery]);

  // Scroll to active search match
  useEffect(() => {
    if (allMatches.length === 0 || activeMatch < 0) return;
    const m = allMatches[activeMatch];
    if (!m) return;
    const el = blockRefs.current.get(m.blockIndex);
    if (el && transcriptRef.current) {
      const container = transcriptRef.current;
      const elTop = el.offsetTop - container.offsetTop;
      container.scrollTo({ top: elTop - 60, behavior: "smooth" });
    }
  }, [activeMatch, allMatches, blockRefs, transcriptRef]);

  const goNext = useCallback(() => {
    if (allMatches.length === 0) return;
    setActiveMatch((a) => (a + 1) % allMatches.length);
  }, [allMatches.length]);

  const goPrev = useCallback(() => {
    if (allMatches.length === 0) return;
    setActiveMatch((a) => (a - 1 + allMatches.length) % allMatches.length);
  }, [allMatches.length]);

  // Ctrl/Cmd+F to open search
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const handleSearchKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") { setSearchOpen(false); setSearchQuery(""); }
    else if (e.key === "Enter" && e.shiftKey) { goPrev(); }
    else if (e.key === "Enter") { goNext(); }
  };

  // Per-block match data with global offset
  const blockMatchMap = useMemo(() => {
    const map = new Map<number, { matches: SearchMatch[]; globalOffset: number }>();
    let offset = 0;
    for (let bi = 0; bi < blocks.length; bi++) {
      const bm = allMatches.filter((m) => m.blockIndex === bi);
      if (bm.length > 0) {
        map.set(bi, { matches: bm, globalOffset: offset });
        offset += bm.length;
      }
    }
    return map;
  }, [allMatches, blocks.length]);

  // Active playback block
  const activeIndex = useMemo(() => {
    if (blocks.length === 0) return -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (currentTime >= (blocks[i]?.seconds ?? 0)) return i;
    }
    return -1;
  }, [blocks, currentTime]);

  // Auto-scroll to active playback block (only when not searching)
  useEffect(() => {
    if (searchQuery) return;
    if (activeIndex < 0) return;
    const el = blockRefs.current.get(activeIndex);
    if (el && transcriptRef.current) {
      const container = transcriptRef.current;
      const elTop = el.offsetTop - container.offsetTop;
      const elBottom = elTop + el.offsetHeight;
      const scrollTop = container.scrollTop;
      const viewHeight = container.clientHeight;
      if (elTop < scrollTop || elBottom > scrollTop + viewHeight) {
        container.scrollTo({ top: elTop - 40, behavior: "smooth" });
      }
    }
  }, [activeIndex, blockRefs, transcriptRef, searchQuery]);

  // Fallback for unparseable transcripts
  if (blocks.length === 0) {
    return (
      <section className="card overflow-hidden flex flex-col" style={{ maxHeight: "600px" }}>
        <div className="p-6 bg-surface-container-high flex justify-between items-center border-b border-outline-variant/30 flex-shrink-0">
          <h2 className="text-sm font-label uppercase tracking-widest text-primary font-semibold">Transcript</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <pre className="whitespace-pre-wrap font-sans text-base leading-relaxed text-on-surface">{text}</pre>
        </div>
      </section>
    );
  }

  return (
    <section className="card overflow-hidden flex flex-col" style={{ maxHeight: "600px" }}>
      {/* Header with search */}
      <div className="p-6 bg-surface-container-high flex justify-between items-center border-b border-outline-variant/30 flex-shrink-0 gap-3">
        <h2 className="text-sm font-label uppercase tracking-widest text-primary font-semibold">Transcript</h2>
        {searchOpen ? (
          <div className="flex items-center gap-2">
            <div className="relative">
              <input
                ref={searchInputRef}
                type="text"
                className="input py-1.5 pl-8 pr-3 text-sm w-48 border-transparent"
                placeholder="Search…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                autoFocus
              />
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            </div>
            {searchQuery && (
              <span className="text-xs text-on-surface-variant font-label whitespace-nowrap">
                {allMatches.length > 0 ? `${activeMatch + 1}/${allMatches.length}` : "0/0"}
              </span>
            )}
            <button onClick={goPrev} className="p-1 text-on-surface-variant hover:text-on-surface transition-colors" title="Previous (Shift+Enter)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
            </button>
            <button onClick={goNext} className="p-1 text-on-surface-variant hover:text-on-surface transition-colors" title="Next (Enter)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <button onClick={() => { setSearchOpen(false); setSearchQuery(""); }} className="p-1 text-on-surface-variant hover:text-on-surface transition-colors" title="Close (Esc)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        ) : (
          <button
            onClick={() => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 50); }}
            className="p-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded-lg transition-colors"
            title="Search transcript (Ctrl+F)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          </button>
        )}
      </div>

      {/* Transcript body */}
      <div ref={transcriptRef as React.RefObject<HTMLDivElement>} className="flex-1 overflow-y-auto p-6 space-y-6">
        {blocks.map((block, i) => {
          const isActive = i === activeIndex;
          const color = speakerColor(block.speaker, speakerMap);
          const bm = blockMatchMap.get(i);
          return (
            <div
              key={i}
              ref={(el) => { if (el) blockRefs.current.set(i, el); }}
              className={`flex gap-6 cursor-pointer group transition-opacity duration-200 ${
                activeIndex >= 0 && !isActive && !searchQuery ? "opacity-50" : "opacity-100"
              }`}
              onClick={() => onSeek(block.seconds)}
            >
              <div className="w-20 shrink-0 text-right">
                <p className="text-[10px] font-label text-on-surface-variant/60 leading-tight">{block.timestamp}</p>
                <p className="text-xs font-bold tracking-tight mt-1 uppercase" style={{ color }}>{block.speaker}</p>
              </div>
              <div className="flex-1">
                <p className={`text-on-surface leading-relaxed text-base ${isActive && !searchQuery ? "font-medium" : ""}`}>
                  {bm ? (
                    <HighlightedText text={block.text} matches={bm.matches} activeMatchIndex={activeMatch} globalOffset={bm.globalOffset} />
                  ) : (
                    block.text
                  )}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
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
