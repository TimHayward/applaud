/**
 * Pure waveform math, shared by the real (decoded-audio) and synthetic
 * (seeded-fallback) renderers. Kept dependency-free so it's unit-testable
 * without a DOM or AudioContext.
 */

/**
 * Downsample decoded PCM to `numBars` normalized peak values (0-1). Each bar is
 * the maximum absolute sample over its window; the result is scaled so the
 * loudest bar is 1, with a small floor so quiet passages still render.
 */
export function computePeaks(samples: Float32Array, numBars: number): number[] {
  if (numBars <= 0 || samples.length === 0) return [];
  const bars = new Array<number>(numBars).fill(0);
  const windowSize = Math.max(1, Math.floor(samples.length / numBars));
  let globalMax = 0;
  for (let i = 0; i < numBars; i++) {
    const start = i * windowSize;
    const end = i === numBars - 1 ? samples.length : Math.min(samples.length, start + windowSize);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(samples[j] ?? 0);
      if (v > peak) peak = v;
    }
    bars[i] = peak;
    if (peak > globalMax) globalMax = peak;
  }
  if (globalMax <= 0) return bars.map(() => 0);
  return bars.map((p) => Math.max(0.03, p / globalMax));
}

/**
 * Build a mirrored-envelope SVG path from normalized amplitudes (0-1): a line
 * across the top half (left→right) then mirrored back along the bottom,
 * closed into a fillable shape.
 */
export function buildEnvelopePath(norm: number[], width: number, height: number): string {
  const n = norm.length;
  if (n === 0) return "";
  const mid = height / 2;
  const maxAmp = mid * 0.9;
  const step = width / (n - 1 || 1);
  let top = `M 0 ${mid.toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const amp = (norm[i] ?? 0) * maxAmp;
    top += ` L ${x.toFixed(1)} ${(mid - amp).toFixed(1)}`;
  }
  let bottom = "";
  for (let i = n - 1; i >= 0; i--) {
    const x = i * step;
    const amp = (norm[i] ?? 0) * maxAmp;
    bottom += ` L ${x.toFixed(1)} ${(mid + amp).toFixed(1)}`;
  }
  return `${top}${bottom} Z`;
}
