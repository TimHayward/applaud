import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSafe, computeRange, contentDisposition } from "./media.js";

describe("resolveSafe (media path-traversal guard)", () => {
  let base: string;

  beforeEach(() => {
    // realpathSync resolves any symlinked tmp dir (e.g. macOS /tmp -> /private/tmp)
    // so it matches what resolveSafe computes internally.
    base = realpathSync(mkdtempSync(path.join(tmpdir(), "applaud-media-test-")));
    mkdirSync(path.join(base, "rec1"), { recursive: true });
    writeFileSync(path.join(base, "rec1", "audio.ogg"), "fake-audio");
    writeFileSync(path.join(base, "outside-secret.txt"), "should never be reachable");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("resolves a normal nested path within the base dir", () => {
    expect(resolveSafe(base, "rec1/audio.ogg")).toBe(path.join(base, "rec1", "audio.ogg"));
  });

  it("resolves a path that doesn't exist yet without escaping (caller 404s on existsSync)", () => {
    expect(resolveSafe(base, "rec1/missing.ogg")).toBe(path.join(base, "rec1", "missing.ogg"));
  });

  it("rejects a literal .. traversal escaping the base dir", () => {
    expect(resolveSafe(base, "../outside-secret.txt")).toBeNull();
  });

  it("rejects a deep .. traversal escaping the base dir", () => {
    expect(resolveSafe(base, "rec1/../../outside-secret.txt")).toBeNull();
  });

  it("rejects a URL-encoded traversal sequence", () => {
    expect(resolveSafe(base, "%2e%2e%2foutside-secret.txt")).toBeNull();
  });

  it("rejects a NUL byte in the path", () => {
    expect(resolveSafe(base, "rec1/audio.ogg%00.txt")).toBeNull();
  });

  it("contains a leading-slash rel path under base instead of jumping to root", () => {
    // path.join (not path.resolve) is used internally, so a leading "/" in
    // rel is just another separator — it can't be used to escape to the
    // filesystem root the way it could with path.resolve.
    const result = resolveSafe(base, "/rec1/audio.ogg");
    expect(result).toBe(path.join(base, "rec1", "audio.ogg"));
  });
});

describe("computeRange", () => {
  const size = 1000;

  it("serves the LAST N bytes for a suffix range (bytes=-500)", () => {
    // Regression: previously yielded { start: 0, end: 500 } (the first 501 bytes).
    expect(computeRange("bytes=-500", size)).toEqual({ start: 500, end: 999 });
  });

  it("clamps an oversized suffix range to the whole file", () => {
    expect(computeRange("bytes=-5000", size)).toEqual({ start: 0, end: 999 });
  });

  it("treats a zero-length suffix as unsatisfiable", () => {
    expect(computeRange("bytes=-0", size)).toBe("unsatisfiable");
  });

  it("handles a normal open-ended range (bytes=200-)", () => {
    expect(computeRange("bytes=200-", size)).toEqual({ start: 200, end: 999 });
  });

  it("handles a fully-specified range (bytes=100-199)", () => {
    expect(computeRange("bytes=100-199", size)).toEqual({ start: 100, end: 199 });
  });

  it("rejects a start beyond EOF as unsatisfiable", () => {
    expect(computeRange("bytes=1000-1200", size)).toBe("unsatisfiable");
  });

  it("returns null for a non-bytes unit (caller serves full file)", () => {
    expect(computeRange("items=0-10", size)).toBeNull();
  });

  it("returns null for a malformed range", () => {
    expect(computeRange("bytes=-", size)).toBeNull();
  });
});

describe("contentDisposition (inline-vs-download policy)", () => {
  it.each([
    [".ogg", "audio/ogg"],
    [".mp3", "audio/mpeg"],
    [".jpg", "image/jpeg"],
    [".png", "image/png"],
  ])("serves %s inline with its real type", (ext, type) => {
    const r = contentDisposition(ext, `file${ext}`);
    expect(r.type).toBe(type);
    expect(r.disposition).toBeNull();
  });

  it.each([".svg", ".svgz", ".html", ".htm", ".xhtml", ".xml", ".pdf"])(
    "forces %s to an octet-stream download (stored-XSS guard)",
    (ext) => {
      const r = contentDisposition(ext, `evil${ext}`);
      expect(r.type).toBe("application/octet-stream");
      expect(r.disposition).toMatch(/^attachment;/);
    },
  );

  it("keeps the text type for markdown/json but still downloads them", () => {
    expect(contentDisposition(".md", "summary.md").type).toMatch(/^text\/markdown/);
    expect(contentDisposition(".md", "summary.md").disposition).toMatch(/^attachment;/);
    expect(contentDisposition(".json", "transcript.json").type).toBe("application/json");
  });

  it("falls back to octet-stream for an unknown extension", () => {
    const r = contentDisposition(".weird", "thing.weird");
    expect(r.type).toBe("application/octet-stream");
    expect(r.disposition).toMatch(/filename="thing.weird"/);
  });

  it("sanitizes quotes and non-ASCII in the filename, keeping an RFC 5987 copy", () => {
    const r = contentDisposition(".svg", 'bad"name🙂.svg');
    expect(r.disposition).toContain('filename="bad_name');
    expect(r.disposition).toContain("filename*=UTF-8''");
    expect(r.disposition).not.toContain('name"🙂');
  });
});
