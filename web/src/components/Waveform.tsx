import { useRef, useEffect, useCallback, useMemo } from "react";

interface WaveformProps {
  recordingId: string;
  progress: number; // 0-1
  onSeek: (fraction: number) => void;
}

/** Simple seeded PRNG so each recording gets a deterministic waveform. */
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

/** Generate a wavy path mirrored around the center. */
function generateWavePath(
  width: number,
  height: number,
  seed: string,
  numPoints: number = 80,
): string {
  const rng = seedRng(seed);
  const mid = height / 2;
  const maxAmp = mid * 0.85;

  // Generate amplitude values with some smoothing
  const raw: number[] = [];
  for (let i = 0; i <= numPoints; i++) {
    // Base wave from layered sines + randomness
    const x = i / numPoints;
    const wave =
      Math.sin(x * Math.PI * 2) * 0.3 +
      Math.sin(x * Math.PI * 5.7) * 0.2 +
      Math.sin(x * Math.PI * 11.3) * 0.15 +
      (rng() - 0.5) * 0.7;
    // Taper at edges
    const taper = Math.min(1, Math.min(x, 1 - x) * 8);
    raw.push(Math.abs(wave) * taper);
  }

  // Smooth
  const smooth: number[] = [];
  for (let i = 0; i <= numPoints; i++) {
    const prev = raw[Math.max(0, i - 1)] ?? 0;
    const curr = raw[i] ?? 0;
    const next = raw[Math.min(numPoints, i + 1)] ?? 0;
    smooth.push((prev + curr * 2 + next) / 4);
  }

  // Normalize to 0-1
  const maxVal = Math.max(...smooth, 0.01);
  const norm = smooth.map((v) => v / maxVal);

  // Build path: top half (going right), then bottom half (going left)
  const step = width / numPoints;
  let topPath = `M 0 ${mid}`;
  for (let i = 0; i <= numPoints; i++) {
    const x = i * step;
    const amp = (norm[i] ?? 0) * maxAmp;
    topPath += ` L ${x.toFixed(1)} ${(mid - amp).toFixed(1)}`;
  }
  // Continue along bottom (mirrored)
  let bottomPath = "";
  for (let i = numPoints; i >= 0; i--) {
    const x = i * step;
    const amp = (norm[i] ?? 0) * maxAmp;
    bottomPath += ` L ${x.toFixed(1)} ${(mid + amp).toFixed(1)}`;
  }

  return topPath + bottomPath + " Z";
}

const SVG_WIDTH = 1000;
const SVG_HEIGHT = 120;

export function Waveform({ recordingId, progress, onSeek }: WaveformProps): JSX.Element {
  const gradRef = useRef<SVGLinearGradientElement>(null);
  const containerRef = useRef<SVGSVGElement>(null);

  const path = useMemo(
    () => generateWavePath(SVG_WIDTH, SVG_HEIGHT, recordingId),
    [recordingId],
  );

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

  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = containerRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      onSeek(Math.max(0, Math.min(1, fraction)));
    },
    [onSeek],
  );

  // Gradient ID unique per instance
  const gradId = `wf-grad-${recordingId.slice(0, 8)}`;

  return (
    <svg
      ref={containerRef}
      viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
      preserveAspectRatio="none"
      className="w-full h-28 rounded-lg bg-surface-container-highest/30 cursor-pointer"
      onClick={handleClick}
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
    </svg>
  );
}
