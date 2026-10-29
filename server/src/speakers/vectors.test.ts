import { describe, it, expect } from "vitest";
import { centroid, cosine, fromBlob, normalise, toBlob } from "./vectors.js";

const f = (...xs: number[]): Float32Array => new Float32Array(xs);

describe("vectors", () => {
  it("cosine", () => {
    expect(cosine(f(1, 0), f(1, 0))).toBeCloseTo(1);
    expect(cosine(f(1, 0), f(0, 1))).toBeCloseTo(0);
    expect(cosine(f(1, 0), f(-2, 0))).toBeCloseTo(-1);
    expect(cosine(f(0, 0), f(1, 0))).toBe(0);
  });

  it("normalise", () => {
    expect(Array.from(normalise(f(3, 4)))).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
    expect(Array.from(normalise(f(0, 0)))).toEqual([0, 0]);
  });

  it("centroid weighs each vector equally, whatever its length", () => {
    const c = centroid([f(10, 0), f(0, 1)])!;
    expect(c[0]).toBeCloseTo(Math.SQRT1_2);
    expect(c[1]).toBeCloseTo(Math.SQRT1_2);
    expect(centroid([])).toBeNull();
  });

  it("round-trips through a BLOB, including from an unaligned buffer", () => {
    const v = f(0.5, -1.25, 3);
    expect(Array.from(fromBlob(toBlob(v)))).toEqual([0.5, -1.25, 3]);
    const padded = Buffer.concat([Buffer.from([9]), toBlob(v)]).subarray(1);
    expect(Array.from(fromBlob(padded))).toEqual([0.5, -1.25, 3]);
  });
});
