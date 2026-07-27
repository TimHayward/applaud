import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import openUrl from "open";
import { logger } from "./logger.js";
import { loadConfig, updateConfig } from "./config.js";
import { ensureConfigDir, lockPath, configDir } from "./paths.js";
import { sweepOrphanedTempFiles } from "./fsAtomic.js";
import { authRouter } from "./routes/auth.js";
import { configRouter } from "./routes/config.js";
import { recordingsRouter } from "./routes/recordings.js";
import { syncRouter } from "./routes/sync.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { mediaRouter } from "./routes/media.js";
import { poller } from "./sync/poller.js";
import { requireLanToken, requireLanTokenMedia } from "./auth/lan-token.js";
import { buildAppCsp, securityHeaders } from "./security/headers.js";
import { requireAllowedHost } from "./security/host-check.js";
import { createRateLimiter } from "./security/rate-limit.js";
import { hardenWindowsConfigDir } from "./security/windows-acl.js";
import {
  LAN_TOKEN_MIN_LENGTH,
  RATE_LIMIT_API_MAX,
  RATE_LIMIT_MEDIA_MAX,
  RATE_LIMIT_WINDOW_MS,
} from "./constants.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the web bundle dir relative to the compiled server entry.
// When installed: <repo>/server/dist/index.js → <repo>/web/dist
const WEB_DIST = path.resolve(__dirname, "..", "..", "web", "dist");

function acquireLock(): boolean {
  const lp = lockPath();
  if (existsSync(lp)) {
    try {
      const pid = Number(readFileSync(lp, "utf8").trim());
      if (pid && !Number.isNaN(pid)) {
        try {
          process.kill(pid, 0);
          // process exists
          logger.error({ pid }, `applaud already running (PID ${pid}). Refusing to start.`);
          return false;
        } catch {
          // stale lock
          logger.warn({ pid }, "removing stale lock file");
          unlinkSync(lp);
        }
      }
    } catch {
      unlinkSync(lp);
    }
  }
  writeFileSync(lp, String(process.pid));
  const cleanup = (): void => {
    try {
      unlinkSync(lp);
    } catch {
      /* ignore */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  return true;
}

function shouldOpenBrowser(): boolean {
  if (process.env.APPLAUD_NO_OPEN === "1") return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT) return false;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    // Allow WSL to still open (wslview handles it), detect via /proc/version
    try {
      const v = readFileSync("/proc/version", "utf8");
      if (!/microsoft/i.test(v)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Container mode is signalled by an explicit config dir (see the Dockerfile). */
function isContainerMode(): boolean {
  return !!process.env.APPLAUD_CONFIG_DIR;
}

/**
 * In container mode the server binds `0.0.0.0`, so anything that can route to
 * the container could otherwise read every recording and POST config —
 * `lanToken` defaults to `null`, which makes the auth gate a no-op. Require a
 * token there: use `APPLAUD_LAN_TOKEN` if provided, otherwise generate one and
 * print it, so the instance is never unauthenticated by accident.
 *
 * `APPLAUD_ALLOW_NO_AUTH=1` opts out, for setups that put their own
 * authenticating proxy in front.
 */
function ensureContainerAuth(): void {
  if (!isContainerMode()) return;
  if (loadConfig().lanToken) return;
  if (process.env.APPLAUD_ALLOW_NO_AUTH === "1") {
    logger.warn(
      "APPLAUD_ALLOW_NO_AUTH=1 — /api and /media are served without authentication on 0.0.0.0",
    );
    return;
  }
  const provided = process.env.APPLAUD_LAN_TOKEN;
  if (provided && provided.length < LAN_TOKEN_MIN_LENGTH) {
    logger.error(
      { minLength: LAN_TOKEN_MIN_LENGTH },
      "APPLAUD_LAN_TOKEN is too short — refusing to start",
    );
    process.exit(1);
  }
  const token = provided ?? randomBytes(24).toString("hex");
  updateConfig({ lanToken: token });
  if (!provided) {
    const port = loadConfig().bind.port;
    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "  ┌─ LAN access token generated ────────────────────────────────",
        `  │  ${token}`,
        "  │",
        "  │  This container listens on 0.0.0.0, so /api and /media now",
        "  │  require the token. Open:",
        `  │    http://<host>:${port}/?token=${token}`,
        "  │  once per browser (it's stored locally), or change it in",
        "  │  Settings → LAN Access. Set APPLAUD_LAN_TOKEN to pin your own,",
        "  │  or APPLAUD_ALLOW_NO_AUTH=1 to disable this.",
        "  └─────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
  }
  logger.info("container mode: LAN token required for /api and /media");
}

async function main(): Promise<void> {
  ensureConfigDir();
  // chmod 600 does nothing on Windows — restrict the config dir ACL instead
  // (best-effort, once per install; see security/windows-acl.ts).
  hardenWindowsConfigDir(configDir());
  // Skip lock file in Docker — PID reuse makes it unreliable in containers
  if (!isContainerMode() && !acquireLock()) {
    process.exit(1);
  }

  ensureContainerAuth();
  const cfg = loadConfig();

  // Sweep atomic-write temp files orphaned by a crash between write and rename
  // (both writeFileAtomic's `.tmp-<hex>` and the audio downloader's `.tmp-<id>`),
  // so they don't accumulate in the config and recording folders over time.
  try {
    const removed = sweepOrphanedTempFiles(configDir());
    const recRemoved = cfg.recordingsDir ? sweepOrphanedTempFiles(cfg.recordingsDir) : 0;
    const total = removed + recRemoved;
    if (total > 0) logger.info({ removed: total }, "swept orphaned temp files");
  } catch (err) {
    logger.warn({ err }, "temp-file sweep failed (non-fatal)");
  }

  const app = express();
  app.disable("x-powered-by");

  // nosniff / CSP / no-referrer on every response. The CSP hashes the inline
  // theme-bootstrap script in the built index.html so it needs no
  // 'unsafe-inline'; /media overrides this with a sandboxed policy.
  const indexHtmlPath = path.join(WEB_DIST, "index.html");
  const appCsp = buildAppCsp(existsSync(indexHtmlPath) ? readFileSync(indexHtmlPath, "utf8") : "");
  app.use(securityHeaders(appCsp));

  // Reject requests arriving under a hostname that isn't ours — the standard
  // DNS-rebinding defense, and the only one that helps a token-less loopback
  // install (a rebound page is same-origin, so CORS/CSRF checks don't apply).
  app.use(requireAllowedHost);

  app.use(express.json({ limit: "1mb" }));

  // Unauthenticated liveness probe (e.g. the Docker HEALTHCHECK) — must stay
  // reachable even when a lanToken is configured, and discloses nothing.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Coarse per-IP caps so nothing here can be hammered indefinitely; the
  // brute-force-sensitive routes carry their own tighter limits (failed-token
  // attempts in auth/lan-token.ts, test-webhook/validate-dir in routes/config).
  app.use(
    "/api",
    createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_API_MAX }),
  );
  app.use(
    "/media",
    createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MEDIA_MAX }),
  );

  // Gate /api and /media behind cfg.lanToken when one is configured (always in
  // container mode; see ensureContainerAuth). /media additionally accepts
  // `?token=` for <audio>/<a>/<img>, which can't set headers.
  app.use("/api", requireLanToken);
  app.use("/media", requireLanTokenMedia);

  // API routes
  app.use("/api/auth", authRouter);
  app.use("/api/config", configRouter);
  app.use("/api/recordings", recordingsRouter);
  app.use("/api/sync", syncRouter);
  app.use("/api/webhooks", webhooksRouter);
  app.use("/media", mediaRouter);

  app.get("/api/setup/status", (_req, res) => {
    const current = loadConfig();
    res.json({
      setupComplete: current.setupComplete,
      hasToken: !!current.token,
      hasRecordingsDir: !!current.recordingsDir,
    });
  });

  // Static web bundle + SPA fallback
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false }));
    app.get(/^(?!\/api\/|\/media\/).*/, (_req, res) => {
      res.sendFile(path.join(WEB_DIST, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res
        .status(503)
        .send(
          "web bundle not built. run `pnpm build` first, or run the web dev server with `pnpm dev`.",
        );
    });
  }

  const bindHost = isContainerMode() ? "0.0.0.0" : cfg.bind.host;
  const { port } = cfg.bind;
  app.listen(port, bindHost, () => {
    const host = bindHost;
    const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
    logger.info({ url }, `applaud listening`);
    // eslint-disable-next-line no-console
    console.log(`\n▸ applaud is running at ${url}\n`);
    if (!cfg.setupComplete) {
      // eslint-disable-next-line no-console
      console.log("  First run detected — opening the setup wizard in your browser.\n");
      if (shouldOpenBrowser()) {
        openUrl(`${url}/setup`).catch((err) => {
          logger.warn({ err }, "failed to auto-open browser");
        });
      } else {
        // eslint-disable-next-line no-console
        console.log(`  (Headless host detected. Open ${url}/setup manually.)\n`);
      }
    } else {
      poller.start();
    }
  });
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
