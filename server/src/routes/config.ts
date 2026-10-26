import { Router } from "express";
import { z } from "zod";
import {
  existsSync,
  mkdirSync,
  statSync,
  accessSync,
  constants,
  statfsSync,
} from "node:fs";
import path from "node:path";
import { loadConfig, updateConfig } from "../config.js";
import { testWebhook } from "../webhook/post.js";
import { poller } from "../sync/poller.js";
import { clearSyncIgnore } from "../sync/state.js";
import { redactConfig, mergeWebhookSecret, SECRET_REDACTED } from "./config-helpers.js";
import { LAN_TOKEN_MIN_LENGTH, RATE_LIMIT_SENSITIVE_MAX, RATE_LIMIT_WINDOW_MS } from "../constants.js";
import { createRateLimiter } from "../security/rate-limit.js";

export const configRouter = Router();

/**
 * These two routes reach out of the process on caller-supplied input — one
 * makes an outbound HTTP request, the other touches the filesystem — so they
 * get a much tighter cap than ordinary API traffic.
 */
const sensitiveLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_SENSITIVE_MAX,
  message: "too many requests — slow down",
});

configRouter.get("/", (_req, res) => {
  res.json({ config: redactConfig(loadConfig()) });
});

/** Webhook targets are fetched by the server — keep them to http(s). */
const HttpUrl = z
  .string()
  .url()
  // zod still runs refinements after `.url()` fails, so `new URL` must not be
  // allowed to throw (it would escape safeParse as a 500 instead of a 400, and
  // break the `.or(z.literal(""))` fallbacks below).
  .refine((v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol), {
    message: "URL must use http or https",
  });

/**
 * A `lanToken` is the only thing standing between a LAN-exposed instance and
 * every recording on it, so reject values short enough to guess. The redaction
 * sentinel (preserve) and "" (clear) stay valid — see `mergeWebhookSecret`.
 */
const LanToken = z.string().refine(
  (v) => v === "" || v === SECRET_REDACTED || v.length >= LAN_TOKEN_MIN_LENGTH,
  { message: `LAN token must be at least ${LAN_TOKEN_MIN_LENGTH} characters` },
);

const PatchSchema = z.object({
  recordingsDir: z.string().min(1).max(4096).optional(),
  webhook: z
    .object({
      url: HttpUrl.or(z.literal("")),
      enabled: z.boolean().optional(),
      secret: z.string().optional(),
    })
    .nullable()
    .optional(),
  pollIntervalMinutes: z.number().int().min(1).max(120).optional(),
  bind: z
    .object({
      host: z.string(),
      port: z.number().int().min(1).max(65535),
    })
    .optional(),
  /** Days of history before install to download in full (0–3650). */
  historyDays: z.number().int().min(0).max(3650).optional(),
  lanToken: LanToken.optional(),
  /** "" or null clears it (webhook URLs fall back to the bind address). */
  publicBaseUrl: HttpUrl.or(z.literal("")).nullable().optional(),
});

configRouter.post("/", (req, res) => {
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const patch = parsed.data;
  const prev = loadConfig();
  const mergedSecret = patch.webhook
    ? mergeWebhookSecret(prev.webhook?.secret, patch.webhook.secret)
    : undefined;
  // Same redact/preserve/clear truth table as the webhook secret applies here.
  const mergedLanToken =
    patch.lanToken !== undefined ? mergeWebhookSecret(prev.lanToken ?? undefined, patch.lanToken) : undefined;
  const webhookEnabled = patch.webhook
    ? (patch.webhook.enabled ?? patch.webhook.url.length > 0)
    : false;
  // Stamp when the webhook goes from off/unconfigured to active, so automatic
  // re-delivery doesn't replay every recording downloaded before it existed.
  // Staying active (e.g. a URL or secret edit) keeps the original stamp.
  const prevWebhookActive = Boolean(prev.webhook?.enabled && prev.webhook.url);
  const webhookEnabledAt =
    patch.webhook && webhookEnabled && patch.webhook.url.length > 0
      ? prevWebhookActive
        ? prev.webhook?.enabledAt
        : Date.now()
      : undefined;
  const normalized = {
    ...patch,
    webhook: patch.webhook
      ? {
          url: patch.webhook.url,
          enabled: webhookEnabled,
          ...(mergedSecret ? { secret: mergedSecret } : {}),
          ...(webhookEnabledAt !== undefined ? { enabledAt: webhookEnabledAt } : {}),
        }
      : patch.webhook,
    ...(patch.lanToken !== undefined ? { lanToken: mergedLanToken ?? null } : {}),
    ...(patch.publicBaseUrl !== undefined
      ? { publicBaseUrl: patch.publicBaseUrl ? patch.publicBaseUrl.replace(/\/+$/, "") : null }
      : {}),
  };
  const next = updateConfig(normalized);
  // A wider window brings older recordings into scope: fetch them now.
  if (patch.historyDays !== undefined && patch.historyDays > prev.historyDays && next.setupComplete) {
    void poller.trigger();
  }
  // Poll interval takes effect immediately by rescheduling the running timer.
  if (
    patch.pollIntervalMinutes !== undefined &&
    patch.pollIntervalMinutes !== prev.pollIntervalMinutes
  ) {
    poller.restart();
  }
  // Bind host/port can't be safely re-bound on a live HTTP server from here —
  // flag that a restart is needed instead of silently ignoring the change.
  const restartRequired =
    patch.bind !== undefined &&
    (patch.bind.host !== prev.bind.host || patch.bind.port !== prev.bind.port);
  res.json({ config: redactConfig(next), ...(restartRequired ? { restartRequired: true } : {}) });
});

const TestWebhookSchema = z.object({ url: HttpUrl });

configRouter.post("/test-webhook", sensitiveLimiter, async (req, res) => {
  const parsed = TestWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid URL — must be an http(s) URL" });
    return;
  }
  const result = await testWebhook(parsed.data.url);
  res.json(result);
});

const ValidateDirSchema = z.object({
  path: z.string().min(1).max(4096),
  /**
   * Opt-in creation. Without this the route is a pure read-only probe; with it
   * it creates a single leaf directory under an existing parent (never
   * `recursive`), so it can't be used to scaffold arbitrary directory trees
   * anywhere the process can write.
   */
  create: z.boolean().optional(),
});

configRouter.post("/validate-recordings-dir", sensitiveLimiter, (req, res) => {
  const parsed = ValidateDirSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid body" });
    return;
  }
  const p = path.resolve(parsed.data.path);
  try {
    let exists = existsSync(p);
    if (exists && !statSync(p).isDirectory()) {
      res.json({ ok: false, absolutePath: p, exists: true, error: "path is not a directory" });
      return;
    }
    if (!exists) {
      if (!parsed.data.create) {
        res.json({
          ok: false,
          absolutePath: p,
          exists: false,
          error: "directory does not exist",
        });
        return;
      }
      const parent = path.dirname(p);
      if (parent === p || !existsSync(parent)) {
        res.json({
          ok: false,
          absolutePath: p,
          exists: false,
          error: "parent directory does not exist — create it first, or pick an existing folder",
        });
        return;
      }
      try {
        mkdirSync(p);
        exists = true;
      } catch (err) {
        const code = err instanceof Error && "code" in err ? String(err.code) : "unknown";
        res.json({ ok: false, absolutePath: p, exists: false, error: `cannot create (${code})` });
        return;
      }
    }
    try {
      accessSync(p, constants.W_OK);
    } catch {
      res.json({ ok: false, absolutePath: p, exists: true, writable: false, error: "not writable" });
      return;
    }
    let freeBytes: number | undefined;
    try {
      const st = statfsSync(p);
      freeBytes = Number(st.bavail) * Number(st.bsize);
    } catch {
      /* ignore */
    }
    res.json({ ok: true, absolutePath: p, exists: true, writable: true, freeBytes });
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "unknown";
    res.json({ ok: false, absolutePath: p, error: `cannot inspect path (${code})` });
  }
});

const CompleteSchema = z.object({});

configRouter.post("/clear-sync-ignore", (_req, res) => {
  const cleared = clearSyncIgnore();
  void poller.trigger();
  res.json({ ok: true, cleared });
});

configRouter.post("/complete-setup", (req, res) => {
  const parsed = CompleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body" });
    return;
  }
  const cfg = loadConfig();
  if (!cfg.token) {
    res.status(400).json({ error: "no token configured" });
    return;
  }
  if (!cfg.recordingsDir) {
    res.status(400).json({ error: "recordingsDir not set" });
    return;
  }
  // The history window is anchored on the moment sync is first set up.
  updateConfig({ setupComplete: true, installedAt: cfg.installedAt ?? Date.now() });
  poller.start();
  res.json({ ok: true });
});
