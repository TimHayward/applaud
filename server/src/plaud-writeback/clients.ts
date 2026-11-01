import { createHash, randomBytes, randomInt } from "node:crypto";
import type { PlaudWritebackClient } from "@applaud/shared";
import { getDb } from "../db.js";

/**
 * Paired browser extensions (W10). Pairing: the user asks Applaud for a code
 * (Settings, behind the LAN token), types it into the extension, and the
 * extension exchanges it once for its own token. Only a hash of the token is
 * stored; the token reaches the write-back routes and nothing else.
 */

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
/** Unambiguous characters: no 0/O, 1/I/L. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
const NAME_MAX = 80;
/** `last_used_at` is refreshed at most this often, so polling doesn't write on every call. */
const TOUCH_INTERVAL_MS = 60 * 1000;

let pending: { code: string; expiresAt: number } | null = null;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** A new single-use code; any earlier unused code stops working. */
export function issuePairingCode(now: number = Date.now()): { code: string; expiresAt: number } {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  pending = { code, expiresAt: now + PAIRING_CODE_TTL_MS };
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: pending.expiresAt };
}

/** Exchange a pairing code for a token. Null when the code is wrong, used or expired. */
export function pair(
  code: string,
  name: string,
  now: number = Date.now(),
): { token: string; clientId: number } | null {
  if (!pending || now > pending.expiresAt || normaliseCode(code) !== pending.code) return null;
  pending = null;
  const token = randomBytes(32).toString("hex");
  const label = name.trim().slice(0, NAME_MAX) || "Browser extension";
  const info = getDb()
    .prepare("INSERT INTO plaud_writeback_clients (name, token_hash, created_at) VALUES (?, ?, ?)")
    .run(label, hashToken(token), now);
  return { token, clientId: Number(info.lastInsertRowid) };
}

/** The paired client a token belongs to, or null. */
export function authenticate(token: string, now: number = Date.now()): number | null {
  const row = getDb()
    .prepare(
      "SELECT id, last_used_at FROM plaud_writeback_clients WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .get(hashToken(token)) as { id: number; last_used_at: number | null } | undefined;
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at > TOUCH_INTERVAL_MS) {
    getDb()
      .prepare("UPDATE plaud_writeback_clients SET last_used_at = ? WHERE id = ?")
      .run(now, row.id);
  }
  return row.id;
}

export function listClients(): PlaudWritebackClient[] {
  return (
    getDb()
      .prepare(
        "SELECT id, name, created_at, last_used_at FROM plaud_writeback_clients WHERE revoked_at IS NULL ORDER BY id",
      )
      .all() as { id: number; name: string; created_at: number; last_used_at: number | null }[]
  ).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

export function revokeClient(id: number, now: number = Date.now()): boolean {
  return (
    getDb()
      .prepare(
        "UPDATE plaud_writeback_clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(now, id).changes > 0
  );
}

/** Tests only. */
export function resetPairingForTests(): void {
  pending = null;
}
