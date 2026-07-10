import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSafe } from "./media.js";

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
