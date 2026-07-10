import type { NextFunction, Request, Response } from "express";
import { loadConfig } from "../config.js";

/**
 * Gates /api and /media behind cfg.lanToken when one is configured. No-op by
 * default (lanToken is null out of the box), preserving today's loopback-only
 * behavior; set a token in Settings to protect a LAN-exposed instance (e.g.
 * Docker's 0.0.0.0 bind).
 *
 * Accepts the token via `Authorization: Bearer <token>` (used by the web
 * app's fetch calls) or a `?token=` query param (needed for <audio>/<a>
 * elements hitting /media, which can't set custom headers).
 */
export function requireLanToken(req: Request, res: Response, next: NextFunction): void {
  const token = loadConfig().lanToken;
  if (!token) {
    next();
    return;
  }
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  if (bearer === token || queryToken === token) {
    next();
    return;
  }
  res.status(401).json({ error: "unauthorized" });
}
