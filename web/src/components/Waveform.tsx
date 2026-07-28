import { useRef, useEffect, useCallback, useMemo, useState, useId } from "react";
import { computePeaks, buildEnvelopePath } from "../lib/waveform.js";

interface WaveformProps {
  recordingId: string;
  /** URL of the audio to decode for real peaks (falls back to synthetic if absent/undecodable). */
  audioSrc?: string;
  /** Recording length; above `MAX_DECODE_MS` we skip decoding to avoid huge in-browser PCM buffers. */
  durationMs?: number;
  progress: number; // 0-1
  onSeek: (fraction: number) => void;
}

const SVG_WIDTH = 1000;
const SVG_HEIGHT = 120;
const NUM_BARS = 160;

/**
 * Decoding a whole file to PCM happens in memory; a 20-minute mono track is
 * already ~230 MB decoded. Above this we keep the decorative waveform rather
 * than risk crashing the tab on very long recordings.
 */
const MAX_DECODE_MS = 20 * 60 * 1000;

// Peaks are expensive to compute (fetch + decode); cache per recording so
// re-mounts, theme toggles, and playback re-renders don't redo the work.
const peaksCache = new Map<string, number[]>();

/** Simple seeded PRNG so each recording gets a deterministic synthetic shape. */
function seedRng(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  return () => {
    h = (h ^ (h >>> 16)) * 0x45d9f3b;
    h = (h ^ (h >>> 16)) * 0x45d9f3b;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 0xffffffff;
  };
}

/** Deterministic fake envelope, used until (or instead of) real peaks. */
function syntheticNorm(seed: string, numPoints: number): number[] {
  const rng = seedRng(seed);
  const raw: number[] = [];
  for (let i = 0; i <= numPoints; i++) {
    const x = i / numPoints;
    const wave =
      Math.sin(x * Math.PI * 2) * 0.3 +
      Math.sin(x * Math.PI * 5.7) * 0.2 +
      Math.sin(x * Math.PI * 11.3) * 0.15 +
      (rng() - 0.5) * 0.7;
    const taper = Math.min(1, Math.min(x, 1 - x) * 8);
    raw.push(Math.abs(wave) * taper);
  }
  const smooth: number[] = [];
  for (let i = 0; i <= numPoints; i++) {
    const prev = raw[Math.max(0, i - 1)] ?? 0;
    const curr = raw[i] ?? 0;
    const next = raw[Math.min(numPoints, i + 1)] ?? 0;
    smooth.push((prev + curr * 2 + next) / 4);
  }
  const maxVal = Math.max(...smooth, 0.01);
  return smooth.map((v) => v / maxVal);
}

/**
 * Fetch + decode the audio and return real amplitude peaks (0-1), or `null`
 * while loading / when decoding is skipped or fails. Fully self-contained and
 * fault-tolerant: any error (network, unsupported codec, oversized, no
 * AudioContext) resolves to `null` so the caller shows the synthetic shape.
 */
function useAudioPeaks(recordingId: string, audioSrc?: string, durationMs?: number): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() => peaksCache.get(recordingId) ?? null);

  useEffect(() => {
    const cached = peaksCache.get(recordingId);
    if (cached) {
      setPeaks(cached);
      return;
    }
    setPeaks(null);
    if (!audioSrc) return;
    if (durationMs != null && durationMs > MAX_DECODE_MS) return;
    const AudioCtx: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      let ctx: AudioContext | null = null;
      try {
        const res = await fetch(audioSrc, { signal: controller.signal });
        if (!res.ok || cancelled) return;
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        ctx = new AudioCtx();
        const decoded = await ctx.decodeAudioData(buf);
        if (cancelled) return;
        const computed = computePeaks(decoded.getChannelData(0), NUM_BARS);
        peaksCache.set(recordingId, computed);
        setPeaks(computed);
      } catch {
        /* network / decode / unsupported — keep the synthetic fallback */
      } finally {
        void ctx?.close().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [recordingId, audioSrc, durationMs]);

  return peaks;
}

/**
 * Waveform acting as a seek slider: click, drag, hover preview, and keyboard
 * (arrow keys ±5%, Home/End) via role="slider". Renders real decoded peaks
 * when available, falling back to a deterministic synthetic shape.
 */
export function Waveform({ recordingId, audioSrc, durationMs, progress, onSeek }: WaveformProps): JSX.Element {
  const realPeaks = useAudioPeaks(recordingId, audioSrc, durationMs);
  const gradRef = useRef<SVGLinearGradientElement>(null);
  const containerRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef(false);
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);

  const path = useMemo(() => {
    const norm =
      realPeaks && realPeaks.length > 0 ? realPeaks : syntheticNorm(recordingId, 80);
    return buildEnvelopePath(norm, SVG_WIDTH, SVG_HEIGHT);
  }, [realPeaks, recordingId]);

  // Update gradient stops directly in the DOM for performance (no re-render)
  useEffect(() => {
    const grad = gradRef.current;
    if (!grad) return;
    const stops = grad.querySelectorAll("stop");
    const p = Math.max(0, Math.min(1, progress)) * 100;

    const glowStart = Math.max(0, p - 3.5);
    const brightStart = Math.max(0, p - 1.5);
    const brightEnd = Math.min(100, p + 1.5);
    const glowEnd = Math.min(100, p + 3.5);

    stops[0]?.setAttribute("offset", "0%");
    stops[1]?.setAttribute("offset", `${glowStart}%`);
    stops[2]?.setAttribute("offset", `${brightStart}%`);
    stops[3]?.setAttribute("offset", `${p}%`);
    stops[4]?.setAttribute("offset", `${brightEnd}%`);
    stops[5]?.setAttribute("offset", `${glowEnd}%`);
    stops[6]?.setAttribute("offset", "100%");
  }, [progress]);

  const fractionFromEvent = useCallback((clientX: number): number => {
    const svg = containerRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      draggingRef.current = true;
      containerRef.current?.setPointerCapture(e.pointerId);
      onSeek(fractionFromEvent(e.clientX));
    },
    [onSeek, fractionFromEvent],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const frac = fractionFromEvent(e.clientX);
      setHoverFrac(frac);
      if (draggingRef.current) onSeek(frac);
    },
    [onSeek, fractionFromEvent],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    draggingRef.current = false;
    containerRef.current?.releasePointerCapture(e.pointerId);
  }, []);

  // stopPropagation matters as much as preventDefault here: AudioPlayer has a
  // document-level keydown handler (←/→ = ∓10s/+30s) that would otherwise also
  // run for these presses and override the slider's ±5% step.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      const clamped = Math.max(0, Math.min(1, progress));
      const seekTo = (frac: number): void => {
        e.preventDefault();
        e.stopPropagation();
        onSeek(frac);
      };
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        seekTo(Math.max(0, clamped - 0.05));
      } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        seekTo(Math.min(1, clamped + 0.05));
      } else if (e.key === "Home") {
        seekTo(0);
      } else if (e.key === "End") {
        seekTo(1);
      }
    },
    [onSeek, progress],
  );

  // useId keeps gradient defs unique even with multiple waveforms mounted.
  const gradId = `wf-grad-${useId().replace(/:/g, "")}`;
  const playheadX = Math.max(0, Math.min(1, progress)) * SVG_WIDTH;

  return (
    <svg
      ref={containerRef}
      viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
      preserveAspectRatio="none"
      className="w-full h-28 rounded-lg bg-surface-container-highest/30 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40 touch-none"
      role="slider"
      aria-label="Seek position"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.max(0, Math.min(1, progress)) * 100)}
      aria-valuetext={`${Math.round(Math.max(0, Math.min(1, progress)) * 100)}% played`}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => setHoverFrac(null)}
      onKeyDown={handleKeyDown}
    >
      <defs>
        <linearGradient
          id={gradId}
          x1="0%" y1="0%" x2="100%" y2="0%"
          ref={gradRef}
        >
          {/* dim → glow-start → bright-start → center → bright-end → glow-end → dim */}
          <stop offset="0%" stopColor="rgb(var(--color-surface-container-highest))" stopOpacity="0.25" />
          <stop offset="0%" stopColor="rgb(var(--color-surface-container-highest))" stopOpacity="0.25" />
          <stop offset="0%" stopColor="rgb(var(--color-primary))" stopOpacity="0.4" />
          <stop offset="0%" stopColor="rgb(var(--color-primary))" stopOpacity="1" />
          <stop offset="0%" stopColor="rgb(var(--color-primary))" stopOpacity="0.4" />
          <stop offset="0%" stopColor="rgb(var(--color-surface-container-highest))" stopOpacity="0.25" />
          <stop offset="100%" stopColor="rgb(var(--color-surface-container-highest))" stopOpacity="0.25" />
        </linearGradient>
      </defs>
      <path d={path} fill={`url(#${gradId})`} />
      {/* Playhead */}
      <line
        x1={playheadX}
        x2={playheadX}
        y1={4}
        y2={SVG_HEIGHT - 4}
        stroke="rgb(var(--color-primary))"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
      {/* Hover scrub preview */}
      {hoverFrac !== null && (
        <line
          x1={hoverFrac * SVG_WIDTH}
          x2={hoverFrac * SVG_WIDTH}
          y1={4}
          y2={SVG_HEIGHT - 4}
          stroke="rgb(var(--color-on-surface-variant))"
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
          opacity={0.6}
        />
      )}
    </svg>
  );
}
