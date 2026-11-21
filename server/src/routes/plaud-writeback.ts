import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  PLAUD_WRITEBACK_PROTOCOL,
  PLAUD_WRITEBACK_PROTOCOL_HEADER,
  plaudAutomationConfig,
  speakerConfig,
  type PlaudAutomationStatus,
  type PlaudWritebackPairingCodeResponse,
  type PlaudWritebackPairResponse,
  type PlaudWritebackPendingResponse,
  type PlaudWritebackRecordingResponse,
} from "@applaud/shared";
import { requireLanToken } from "../auth/lan-token.js";
import { loadConfig, updateConfig } from "../config.js";
import { RATE_LIMIT_AUTH_FAILURES, RATE_LIMIT_WINDOW_MS } from "../constants.js";
import { logger } from "../logger.js";
import {
  authenticateClient,
  issuePairingCode,
  listClients,
  pair,
  revokeClient,
} from "../plaud-writeback/clients.js";
import {
  undoable,
  createPlan,
  createUndo,
  getRecording,
  history,
  listPending,
  recordResults,
} from "../plaud-writeback/store.js";
import { scheduleConfirmation } from "../plaud-writeback/confirm.js";
import { cardsNeeded, markNoCard, saveCard } from "../plaud-writeback/cards.js";
import {
  applyAutomation,
  automationAvailable,
  automationPending,
  automationStatus,
  next as automationNext,
  recordHeartbeat,
  requestRun,
  resume as resumeAutomation,
} from "../plaud-writeback/automation.js";
import { clientKey, createRateLimiter } from "../security/rate-limit.js";
import { getRecordingById } from "../sync/state.js";

/**
 * `/api/plaud-writeback`: sending confirmed speaker names to Plaud through a
 * paired browser extension (docs/plans/plaud-write-back-extension.md).
 *
 * Mounted ahead of the LAN-token guard. Each request is authenticated either
 * by a paired extension's token (W10) or by the LAN token, as the rest of the
 * API is. Reading is open to both; planning, reporting and undo are for the
 * extension only; pairing and revoking are for the web UI only.
 */

/** Plaud documents for a long recording run to a few megabytes. */
export const PLAUD_WRITEBACK_BODY_LIMIT = "16mb";

const pairFailures = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_AUTH_FAILURES,
  message: "too many failed pairing attempts",
});

export function resetPairFailures(): void {
  pairFailures.reset();
}

/** No authentication: the single-use pairing code is the credential. */
export const plaudWritebackPairRouter = Router();

const PairBody = z.object({ code: z.string().max(32), name: z.string().max(200) });

plaudWritebackPairRouter.post("/pair", (req, res) => {
  const parsed = PairBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const out = pair(parsed.data.code, parsed.data.name);
  if (!out) {
    if (!pairFailures.consume(clientKey(req))) {
      res.setHeader("Retry-After", String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
      res.status(429).json({ error: "too many failed pairing attempts" });
      return;
    }
    res.status(401).json({ error: "the pairing code is wrong or has expired" });
    return;
  }
  logger.info({ clientId: out.clientId }, "browser extension paired for sending names to Plaud");
  const body: PlaudWritebackPairResponse = { ...out, protocol: PLAUD_WRITEBACK_PROTOCOL };
  res.json(body);
});

export const plaudWritebackRouter = Router();

/** The paired extension making this request, if it is one. */
function clientOf(res: Response): number | null {
  return typeof res.locals.writebackClient === "number" ? res.locals.writebackClient : null;
}

/** The automation browser (Automatic Plaud sync), rather than a paired extension. */
function isAutomation(res: Response): boolean {
  return res.locals.writebackKind === "automation";
}

plaudWritebackRouter.use((req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const client = bearer ? authenticateClient(bearer) : null;
  if (client !== null) {
    res.locals.writebackClient = client.id;
    res.locals.writebackKind = client.kind;
    next();
    return;
  }
  requireLanToken(req, res, next);
});

function extensionOnly(req: Request, res: Response, next: NextFunction): void {
  if (clientOf(res) === null) {
    res.status(403).json({ error: "only a paired browser extension can do this" });
    return;
  }
  const sent = Number(req.headers[PLAUD_WRITEBACK_PROTOCOL_HEADER]);
  if (sent !== PLAUD_WRITEBACK_PROTOCOL) {
    res.status(426).json({
      error: `this extension speaks protocol ${Number.isFinite(sent) ? sent : "unknown"}; Applaud needs ${PLAUD_WRITEBACK_PROTOCOL}. Install the extension from the same Applaud release.`,
      protocol: PLAUD_WRITEBACK_PROTOCOL,
    });
    return;
  }
  next();
}

function automationOnly(req: Request, res: Response, next: NextFunction): void {
  if (clientOf(res) !== null && !isAutomation(res)) {
    res.status(403).json({ error: "only the automation browser can do this" });
    return;
  }
  extensionOnly(req, res, next);
}

/**
 * The Settings switch is a hard stop for the automation browser: it may send
 * names or save cards only while automatic sync and that option are on.
 * Paired extensions are unaffected.
 */
function automationAllows(res: Response, what: "names" | "cards" | "undo"): boolean {
  if (!isAutomation(res)) return true;
  const a = plaudAutomationConfig(loadConfig());
  if (what === "undo") {
    res.status(403).json({ error: "the automation browser doesn't undo sends" });
    return false;
  }
  if (!a.enabled || !a[what]) {
    res.status(409).json({
      error:
        what === "names"
          ? "automatic sending of names is off in Applaud (Settings → Automatic Plaud sync)"
          : "automatic fetching of summary cards is off in Applaud (Settings → Automatic Plaud sync)",
    });
    return false;
  }
  return true;
}

function uiOnly(_req: Request, res: Response, next: NextFunction): void {
  if (clientOf(res) !== null) {
    res.status(403).json({ error: "not available to the browser extension" });
    return;
  }
  next();
}

/** Speaker identification on and "Send names to Plaud" on (W12); otherwise a 409 explains which. */
function writingAllowed(res: Response): boolean {
  const s = speakerConfig(loadConfig());
  if (!s.enabled) {
    res.status(409).json({ error: "speaker identification is off in Applaud" });
    return false;
  }
  if (!s.sendToPlaud) {
    res
      .status(409)
      .json({ error: "sending names to Plaud is off in Applaud (Settings → Speakers)" });
    return false;
  }
  return true;
}

plaudWritebackRouter.get("/status", (_req, res) => {
  const s = speakerConfig(loadConfig());
  res.json({
    protocol: PLAUD_WRITEBACK_PROTOCOL,
    speakersEnabled: s.enabled,
    enabled: s.enabled && s.sendToPlaud,
    paired: clientOf(res) !== null,
  });
});

plaudWritebackRouter.get("/pending", (_req, res) => {
  const s = speakerConfig(loadConfig());
  const body: PlaudWritebackPendingResponse = {
    enabled: s.enabled && s.sendToPlaud,
    protocol: PLAUD_WRITEBACK_PROTOCOL,
    recordings: s.enabled ? listPending() : [],
  };
  res.json(body);
});

plaudWritebackRouter.get("/cards/needed", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  res.json({ recordings: cardsNeeded(limit) });
});

const CardBody = z.discriminatedUnion("status", [
  // Base64 of a PNG of at most 10 MB.
  z.object({
    status: z.literal("found"),
    png: z
      .string()
      .min(1)
      .max(14 * 1024 * 1024),
  }),
  z.object({ status: z.literal("none") }),
]);

/** A summary card the extension fetched from Plaud's web app, or word that there is none yet. */
plaudWritebackRouter.post("/cards/:id", extensionOnly, (req, res) => {
  if (!automationAllows(res, "cards")) return;
  const id = req.params.id ?? "";
  const parsed = CardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (!getRecordingById(id)) {
    res.status(404).json({ error: "recording not found" });
    return;
  }
  if (parsed.data.status === "none") {
    markNoCard(id);
    res.json({ ok: true });
    return;
  }
  const dir = loadConfig().recordingsDir;
  if (!dir) {
    res.status(409).json({ error: "no recordings folder is set" });
    return;
  }
  const out = saveCard(dir, id, Buffer.from(parsed.data.png, "base64"));
  if (!out.ok) {
    res.status(out.code).json({ error: out.error });
    return;
  }
  res.json({ ok: true });
});

plaudWritebackRouter.get("/undoable", (_req, res) => {
  const s = speakerConfig(loadConfig());
  res.json({ recordings: s.enabled ? undoable() : [] });
});

plaudWritebackRouter.get("/recordings/:id", (req, res) => {
  const s = speakerConfig(loadConfig());
  const id = req.params.id ?? "";
  if (!getRecordingById(id)) {
    res.status(404).json({ error: "recording not found" });
    return;
  }
  const body: PlaudWritebackRecordingResponse = {
    enabled: s.enabled && s.sendToPlaud,
    recording: s.enabled ? getRecording(id) : null,
    history: s.enabled ? history(id) : [],
  };
  res.json(body);
});

const Kind = z.enum(["transcript", "polished", "summary"]);

const PlanBody = z.object({
  recordingId: z.string().min(1).max(200),
  /** Show the changes without recording a plan (Phase 2). */
  dryRun: z.boolean().optional(),
  documents: z
    .array(
      z.object({
        kind: Kind,
        objectId: z.string().min(1).max(200),
        contentId: z.string().min(1).max(200),
        version: z.number().int().nonnegative(),
        content: z.string(),
      }),
    )
    .max(3),
});

plaudWritebackRouter.post("/plan", extensionOnly, (req, res) => {
  if (!automationAllows(res, "names")) return;
  if (!writingAllowed(res)) return;
  const parsed = PlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const dir = loadConfig().recordingsDir;
  if (!dir || !getRecordingById(parsed.data.recordingId)) {
    res.status(404).json({ error: "recording not found" });
    return;
  }
  try {
    const out = createPlan(
      dir,
      parsed.data.recordingId,
      clientOf(res),
      parsed.data.documents,
      Date.now(),
      {
        dryRun: parsed.data.dryRun === true,
      },
    );
    if (!out.ok) {
      res.status(out.code).json({ error: out.error });
      return;
    }
    res.json(out.body);
  } catch (err) {
    logger.warn(
      { recordingId: parsed.data.recordingId, err },
      "could not plan a write-back to Plaud",
    );
    res.status(500).json({ error: "could not plan the write-back" });
  }
});

const ResultsBody = z.object({
  planId: z.string().regex(/^[0-9a-f]{24}$/),
  results: z
    .array(
      z.object({
        kind: Kind,
        outcome: z.enum(["applied", "conflict", "failed"]),
        newVersion: z.number().int().nonnegative().optional(),
        error: z.string().max(2000).optional(),
      }),
    )
    .max(3),
});

/** Accepted even while writing is switched off: a write already made must still be recorded. */
plaudWritebackRouter.post("/results", extensionOnly, (req, res) => {
  const parsed = ResultsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const out = recordResults(parsed.data.planId, parsed.data.results);
  if (!out.ok) {
    res.status(out.code).json({ error: out.error });
    return;
  }
  // Something changed in Plaud: re-read it through the official API (W7).
  if (out.applied > 0) scheduleConfirmation(out.recordingId);
  res.json({ ok: true });
});

plaudWritebackRouter.post("/undo/:id", extensionOnly, (req, res) => {
  if (!automationAllows(res, "undo")) return;
  if (!writingAllowed(res)) return;
  const id = req.params.id ?? "";
  if (!getRecordingById(id)) {
    res.status(404).json({ error: "recording not found" });
    return;
  }
  const out = createUndo(id, clientOf(res));
  if (!out.ok) {
    res.status(out.code).json({ error: out.error });
    return;
  }
  res.json(out.body);
});

plaudWritebackRouter.post("/pairing-code", uiOnly, (_req, res) => {
  const body: PlaudWritebackPairingCodeResponse = issuePairingCode();
  res.json(body);
});

plaudWritebackRouter.get("/clients", uiOnly, (_req, res) => {
  res.json({ clients: listClients() });
});

plaudWritebackRouter.delete("/clients/:id", uiOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  if (!revokeClient(id)) {
    res.status(404).json({ error: "extension not found" });
    return;
  }
  res.json({ clients: listClients() });
});

// ── Automatic Plaud sync (the browser container) ──

/** The automation browser asks every minute whether to run. */
plaudWritebackRouter.get("/automation/next", automationOnly, (_req, res) => {
  res.json(automationNext(loadConfig()));
});

plaudWritebackRouter.get("/automation/pending", automationOnly, (_req, res) => {
  const cfg = loadConfig();
  const s = speakerConfig(cfg);
  const a = plaudAutomationConfig(cfg);
  const sending = s.enabled && s.sendToPlaud && a.enabled && a.names;
  res.json({ recordings: sending ? automationPending() : [] });
});

const HeartbeatBody = z.object({
  plaudSignedIn: z.boolean().nullable(),
  ran: z.boolean(),
  sent: z.number().int().nonnegative().max(10_000),
  conflicts: z.number().int().nonnegative().max(10_000),
  failed: z.number().int().nonnegative().max(10_000),
  cards: z.number().int().nonnegative().max(10_000),
  error: z.string().max(2000).optional(),
  shapeError: z.boolean().optional(),
});

plaudWritebackRouter.post("/automation/heartbeat", automationOnly, (req, res) => {
  const parsed = HeartbeatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  recordHeartbeat(clientOf(res)!, parsed.data);
  res.json({ ok: true });
});

function statusBody(): PlaudAutomationStatus {
  return automationStatus(loadConfig());
}

plaudWritebackRouter.get("/automation/status", uiOnly, (_req, res) => {
  res.json(statusBody());
});

const AutomationBody = z.object({
  enabled: z.boolean().optional(),
  names: z.boolean().optional(),
  cards: z.boolean().optional(),
  viewerUrl: z
    .string()
    .max(2000)
    .refine((v) => v === "" || (URL.canParse(v) && /^https?:$/.test(new URL(v).protocol)), {
      message: "the browser address must be an http or https URL",
    })
    .optional(),
});

plaudWritebackRouter.put("/automation", uiOnly, (req, res) => {
  const parsed = AutomationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.enabled === true && !automationAvailable()) {
    res.status(409).json({
      error:
        "the browser container isn't set up: APPLAUD_AUTOMATION_DIR is not set (see docs/portainer.md)",
    });
    return;
  }
  const prev = plaudAutomationConfig(loadConfig());
  const nextCfg = updateConfig({
    plaudAutomation: {
      ...prev,
      ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)),
    },
  });
  try {
    applyAutomation(nextCfg);
  } catch (err) {
    logger.warn({ err }, "could not update the automation browser's credential");
    // Don't leave it switched on without a credential the browser can read.
    if (!prev.enabled && plaudAutomationConfig(nextCfg).enabled) {
      try {
        applyAutomation(updateConfig({ plaudAutomation: prev }));
      } catch {
        /* the switch is off again; nothing was written */
      }
    }
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    res.status(500).json({
      error:
        code === "EACCES" || code === "EPERM"
          ? `could not write the automation browser's credential: Applaud has no permission to write to the shared automation folder. Delete the stack's automation volume and update the stack (see docs/portainer.md, Troubleshooting)`
          : `could not write the automation browser's credential${code ? ` (${code})` : ""}`,
    });
    return;
  }
  // Turning it on: run as soon as the browser checks in.
  if (!prev.enabled && plaudAutomationConfig(nextCfg).enabled) requestRun();
  res.json(statusBody());
});

plaudWritebackRouter.post("/automation/run", uiOnly, (_req, res) => {
  if (!plaudAutomationConfig(loadConfig()).enabled) {
    res.status(409).json({ error: "automatic Plaud sync is off" });
    return;
  }
  requestRun();
  res.json(statusBody());
});

plaudWritebackRouter.post("/automation/resume", uiOnly, (_req, res) => {
  resumeAutomation();
  requestRun();
  res.json(statusBody());
});

/**
 * Anything else under /api/plaud-writeback ends here rather than falling
 * through to the LAN-token guard, which would refuse an extension token as
 * "unauthorized" and wrongly tell the user to pair again. Most likely the
 * extension is newer than this Applaud.
 */
plaudWritebackRouter.use((_req, res) => {
  res.status(404).json({
    error:
      "Applaud doesn't support this yet. Update Applaud to the release the extension came with",
  });
});
