/** Cosine similarity; 0 when either vector is all zeros. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Scale to unit length; an all-zero vector is returned unchanged. */
export function normalise(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const out = new Float32Array(v.length);
  if (n === 0) return out;
  const s = 1 / Math.sqrt(n);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * s;
  return out;
}

/** Unit-length mean of unit-length vectors, or null for none. */
export function centroid(vectors: Float32Array[]): Float32Array | null {
  const first = vectors[0];
  if (!first) return null;
  const sum = new Float32Array(first.length);
  for (const v of vectors) {
    const u = normalise(v);
    for (let i = 0; i < sum.length; i++) sum[i]! += u[i]!;
  }
  return normalise(sum);
}

/** SQLite BLOB for a vector (float32, platform byte order: little-endian on every supported host). */
export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function fromBlob(b: Buffer | Uint8Array): Float32Array {
  // Copy: a Buffer's offset into its pool need not be 4-byte aligned.
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
