import { useCallback, useEffect, useState } from "react";
import { Waveform } from "./Waveform.js";
import { formatTimeCompact } from "../lib/transcript.js";

const PLAYBACK_RATES = [1, 1.25, 1.5, 2];

/** True when the keydown originated in a form field / editable element (shortcuts must not fire). */
function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" ||
    t.isContentEditable
  );
}

/**
 * Audio player card: play/pause, ±skips, waveform seek, playback speed,
 * volume, keyboard shortcuts (Space, ←/→), and a download link.
 * Owns the <audio> element; the parent supplies the ref so e.g. the
 * transcript's click-to-seek can drive playback.
 */
export function AudioPlayer({
  src,
  recordingId,
  audioRef,
  onTimeChange,
}: {
  src: string;
  recordingId: string;
  audioRef: React.RefObject<HTMLAudioElement>;
  onTimeChange?: (seconds: number) => void;
}): JSX.Element {
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);

  const onTimeUpdate = useCallback(() => {
    const t = audioRef.current?.currentTime ?? 0;
    setCurrentTime(t);
    onTimeChange?.(t);
  }, [audioRef, onTimeChange]);

  const onLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Number.isFinite(audio.duration)) {
      setAudioDuration(audio.duration);
    } else {
      // Chrome reports duration as Infinity for streamed OGG until the whole
      // file has been scanned. Seeking near the end forces it to resolve —
      // the durationchange listener below reads the real value and resets
      // playback position back to the start.
      audio.currentTime = 1e101;
    }
  }, [audioRef]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = (): void => setIsPlaying(true);
    const onPause = (): void => setIsPlaying(false);
    const onDurationChange = (): void => {
      if (!Number.isFinite(audio.duration)) return;
      setAudioDuration(audio.duration);
      if (audio.currentTime > audio.duration) audio.currentTime = 0;
    };
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    if (Number.isFinite(audio.duration)) setAudioDuration(audio.duration);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [audioRef, onTimeUpdate, onLoadedMetadata, src]);

  const togglePlay = useCallback((): void => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) { void audio.play(); } else { audio.pause(); }
  }, [audioRef]);
  const skipBack = useCallback((): void => { if (audioRef.current) audioRef.current.currentTime -= 10; }, [audioRef]);
  const skipForward = useCallback((): void => { if (audioRef.current) audioRef.current.currentTime += 30; }, [audioRef]);

  // Keyboard shortcuts: Space = play/pause, ← = -10s, → = +30s.
  // Skipped while typing in a form field or when a dialog is open.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (isTypingTarget(e)) return;
      if (document.querySelector("[role='dialog'],[role='alertdialog']")) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        skipBack();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        skipForward();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [togglePlay, skipBack, skipForward]);

  const cycleRate = (): void => {
    const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length] ?? 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const changeVolume = (v: number): void => {
    setVolume(v);
    if (audioRef.current) audioRef.current.volume = v;
  };

  return (
    <section className="card p-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={togglePlay}
            className="w-12 h-12 flex items-center justify-center bg-primary rounded-xl text-on-primary shadow-lg shadow-primary/20 active:scale-90 transition-transform"
            aria-label={isPlaying ? "Pause" : "Play"}
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            {isPlaying ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3" /></svg>
            )}
          </button>
          <button onClick={skipBack} className="p-2 text-on-surface-variant hover:text-primary transition-colors" title="Skip back 10 seconds (←)" aria-label="Skip back 10 seconds">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /><text x="12" y="15.5" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="bold" fontFamily="sans-serif">10</text></svg>
          </button>
          <button onClick={skipForward} className="p-2 text-on-surface-variant hover:text-primary transition-colors" title="Skip forward 30 seconds (→)" aria-label="Skip forward 30 seconds">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" /><text x="12" y="15.5" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="bold" fontFamily="sans-serif">30</text></svg>
          </button>
          <button
            onClick={cycleRate}
            className="px-2 py-1 rounded-lg text-xs font-bold font-label text-on-surface-variant hover:text-primary border border-outline-variant/40 hover:border-primary/40 transition-colors min-w-[3.25rem]"
            title="Playback speed"
            aria-label={`Playback speed ${rate}x — click to change`}
          >
            {rate}×
          </button>
          <div className="flex items-center gap-1.5" title="Volume">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-on-surface-variant shrink-0">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              {volume > 0 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
              {volume > 0.5 && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
            </svg>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => changeVolume(Number(e.target.value))}
              className="w-20 accent-primary"
              aria-label="Volume"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 font-label text-sm">
          <span className="text-primary font-bold">{formatTimeCompact(currentTime)}</span>
          <span className="text-on-surface-variant">/ {formatTimeCompact(audioDuration)}</span>
        </div>
      </div>
      <Waveform
        recordingId={recordingId}
        progress={audioDuration > 0 ? currentTime / audioDuration : 0}
        onSeek={(frac) => { if (audioRef.current && audioDuration > 0) audioRef.current.currentTime = frac * audioDuration; }}
      />
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      <div className="mt-3 flex justify-end">
        <a href={src} className="btn-ghost text-xs" download>Download .ogg</a>
      </div>
    </section>
  );
}
