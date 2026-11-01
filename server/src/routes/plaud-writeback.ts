import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  PLAUD_WRITEBACK_PROTOCOL,
  PLAUD_WRITEBACK_PROTOCOL_HEADER,
  speakerConfig,
  type PlaudWritebackPairingCodeResponse,
  type PlaudWritebackPairResponse,
  type PlaudWritebackPendingResponse,
  type PlaudWritebackRecordingResponse,
} from "@applaud/shared";
import { requireLanToken } from "../auth/lan-token.js";
import { loadConfig } from "../config.js";
import { RATE_LIMIT_AUTH_FAILURES, RATE_LIMIT_WINDOW_MS } from "../constants.js";
import { logger } from "../logger.js";
import {
  authenticate,
  issuePairingCode,
  listClients,
  pair,
  revokeClient,
} from "../plaud-writeback/clients.js";
import {
  createPlan,
  createUndo,
  getRecording,
  history,
  listPending,
  recordResults,
} from "../plaud-writeback/store.js";
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

plaudWritebackRouter.use((req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const clientId = bearer ? authenticate(bearer) : null;
  if (clientId !== null) {
    res.locals.writebackClient = clientId;
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
    const out = createPlan(dir, parsed.data.recordingId, clientOf(res), parsed.data.documents);
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
  res.json({ ok: true });
});

plaudWritebackRouter.post("/undo/:id", extensionOnly, (req, res) => {
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
