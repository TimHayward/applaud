import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { buildAppCsp, inlineScriptHashes, MEDIA_CSP, securityHeaders } from "./headers.js";

const INDEX_HTML = `<!doctype html><html><body>
  <script>
      (function () { document.documentElement.classList.add("dark"); })();
  </script>
  <div id="root"></div>
  <script type="module" src="/assets/main.js"></script>
</body></html>`;

describe("inlineScriptHashes", () => {
  it("hashes inline scripts and ignores external ones", () => {
    const hashes = inlineScriptHashes(INDEX_HTML);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
  });

  it("returns nothing for markup with no inline script", () => {
    expect(inlineScriptHashes(`<script src="/a.js"></script>`)).toEqual([]);
  });

  it("skips an empty inline script", () => {
    expect(inlineScriptHashes(`<script>   </script>`)).toEqual([]);
  });
});

describe("buildAppCsp", () => {
  it("allows the inline bootstrap by hash rather than 'unsafe-inline'", () => {
    const csp = buildAppCsp(INDEX_HTML);
    expect(csp).toMatch(/script-src 'self' 'sha256-/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("locks down the dangerous directives", () => {
    const csp = buildAppCsp("");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
  });
});

describe("MEDIA_CSP", () => {
  it("sandboxes media into an opaque origin with no scripting", () => {
    expect(MEDIA_CSP).toContain("sandbox");
    expect(MEDIA_CSP).toContain("default-src 'none'");
    expect(MEDIA_CSP).not.toContain("allow-scripts");
  });
});

describe("securityHeaders", () => {
  it("sets nosniff, no-referrer, and the CSP on every response", () => {
    const set: Record<string, string> = {};
    const res = {
      setHeader: vi.fn((k: string, v: string) => {
        set[k] = v;
      }),
    } as unknown as Response;
    const next = vi.fn();
    securityHeaders("default-src 'self'")({} as Request, res, next);
    expect(set["X-Content-Type-Options"]).toBe("nosniff");
    expect(set["Referrer-Policy"]).toBe("no-referrer");
    expect(set["X-Frame-Options"]).toBe("DENY");
    expect(set["Content-Security-Policy"]).toBe("default-src 'self'");
    expect(next).toHaveBeenCalledTimes(1);
  });
});
