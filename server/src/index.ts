import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import openUrl from "open";
import { logger } from "./logger.js";
import { loadConfig } from "./config.js";
import { ensureConfigDir, lockPath } from "./paths.js";
import { authRouter } from "./routes/auth.js";
import { configRouter } from "./routes/config.js";
import { recordingsRouter } from "./routes/recordings.js";
import { syncRouter } from "./routes/sync.js";
import { mediaRouter } from "./routes/media.js";
import { poller } from "./sync/poller.js";

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

async function main(): Promise<void> {
  ensureConfigDir();
  if (!acquireLock()) {
    process.exit(1);
  }

  const cfg = loadConfig();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // API routes
  app.use("/api/auth", authRouter);
  app.use("/api/config", configRouter);
  app.use("/api/recordings", recordingsRouter);
  app.use("/api/sync", syncRouter);
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

  const { host, port } = cfg.bind;
  app.listen(port, host, () => {
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
