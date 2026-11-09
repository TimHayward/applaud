/**
 * Reading and writing Plaud's documents from inside the Plaud web app, with
 * the user's own session (plan W8).
 *
 * Shapes are from the spike capture (plan Appendix A.8). Everything is checked
 * before use, and anything unexpected is an error rather than a guess (P6).
 * A write is exactly the request the web app makes when a speaker is renamed:
 * the whole document, with the version it replaces, which Plaud enforces (A.10).
 */
import type {
  PlaudDocument,
  PlaudDocumentKind,
  PlaudDocumentWrite,
  PlaudWritebackResult,
} from "@applaud/shared";

/** Where the web app keeps its session token, prefixed `bearer ` (A.10). */
export const TOKEN_KEY = "pld_tokenstr";
/** Seen on the user's Plaud tab (Phase 2): the API host, device id and workspace. */
export const API_DOMAIN_KEY = "pld_plaud_user_api_domain";
export const DEVICE_KEY = "pld_DEVICE_ID";
export const WORKSPACE_KEY = "pld_session.workspace";

/** Plaud's answer to a write whose `origin_version` is out of date (A.10). */
export const VERSION_CONFLICT = -1800313;
/** Pause between writes, so a send looks like a person renaming speakers, not a burst (P4). */
export const WRITE_PAUSE_MS = 400;

/** Plaud's regional API hosts: `api.plaud.ai`, `api-euc1.plaud.ai`, … */
const API_ORIGIN = /^https:\/\/api(?:-[a-z0-9]+)?\.plaud\.ai(?=\/|$)/;

const OBJECT_KINDS: Record<string, PlaudDocumentKind> = {
  TRANSCRIPT: "transcript",
  POLISHED_TRANSCRIPT: "polished",
  SUMMARY: "summary",
};

/** How warnings name each kind. */
const KIND_LABEL: Record<string, string> = {
  TRANSCRIPT: "transcript",
  POLISHED_TRANSCRIPT: "polished transcript",
  SUMMARY: "summary",
};

export interface PageContext {
  storage: Pick<Storage, "getItem" | "length" | "key">;
  /** URLs the page has requested, newest last (`performance.getEntriesByType("resource")`). */
  resourceUrls: () => string[];
  fetch: typeof fetch;
  language: string;
  timeZone?: string;
  requestId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

function unquote(raw: string): string {
  return raw.trim().replace(/^"|"$/g, "");
}

/** Plaud's device id for this browser, as the web app sends it (`x-device-id`). */
export function readDeviceId(storage: PageContext["storage"]): string | null {
  const raw = storage.getItem(DEVICE_KEY);
  const v = raw ? unquote(raw) : "";
  return /^[A-Za-z0-9_-]{6,128}$/.test(v) ? v : null;
}

/** The workspace the tab is in, as the web app sends it (`x-scope-id`). */
export function readWorkspaceId(storage: PageContext["storage"]): string | null {
  const raw = storage.getItem(WORKSPACE_KEY);
  const m = raw ? /\b(ws_[A-Za-z0-9]{4,64})\b/.exec(raw) : null;
  return m ? m[1]! : null;
}

/** Where some Plaud sessions keep the token instead (seen on a second computer), and its type. */
export const SESSION_TOKENS_KEY = "pld_session.tokens";
export const TOKEN_TYPE_KEY = "pld_tokenType";

const PREFIXED = /^bearer\s+\S{20,}$/i;
const BARE = /^[A-Za-z0-9._~+/=-]{20,}$/;

function withType(storage: PageContext["storage"], value: string): string | null {
  const v = unquote(value);
  if (PREFIXED.test(v)) return v;
  if (!BARE.test(v)) return null;
  const type = unquote(storage.getItem(TOKEN_TYPE_KEY) ?? "") || "bearer";
  return /^[A-Za-z]{1,20}$/.test(type) ? `${type.toLowerCase()} ${v}` : `bearer ${v}`;
}

/** The access token inside `pld_session.tokens`, whatever its exact shape. */
function fromSessionTokens(storage: PageContext["storage"]): string | null {
  const raw = storage.getItem(SESSION_TOKENS_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return withType(storage, raw);
  }
  if (typeof parsed === "string") return withType(storage, parsed);
  // Prefer a key that names an access token, then any key that names a token.
  const found: { score: number; value: string }[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 4) return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === "string") {
        if (/refresh/i.test(k)) continue;
        const score = /access.?token/i.test(k) ? 2 : /token/i.test(k) ? 1 : 0;
        if (score > 0) found.push({ score, value: v });
      } else {
        walk(v, depth + 1);
      }
    }
  };
  walk(parsed, 0);
  for (const f of found.sort((a, b) => b.score - a.score)) {
    const t = withType(storage, f.value);
    if (t) return t;
  }
  return null;
}

export type TokenSource = typeof TOKEN_KEY | typeof SESSION_TOKENS_KEY;

/** The tab's session token and the storage key it came from. */
export function findToken(
  storage: PageContext["storage"],
): { token: string; source: TokenSource } | null {
  const raw = storage.getItem(TOKEN_KEY);
  const direct = raw ? withType(storage, raw) : null;
  if (direct) return { token: direct, source: TOKEN_KEY };
  const session = fromSessionTokens(storage);
  return session ? { token: session, source: SESSION_TOKENS_KEY } : null;
}

export function readToken(storage: PageContext["storage"]): string | null {
  return findToken(storage)?.token ?? null;
}

/**
 * The regional API host the web app is using (open question Q1): from the
 * requests the page has made, else from anything in its storage that names one.
 */
export function findApiOrigin(ctx: Pick<PageContext, "storage" | "resourceUrls">): string | null {
  const own = ctx.storage.getItem(API_DOMAIN_KEY);
  // The web app may keep it with or without the scheme; Plaud's API is https only.
  const fromKey = own ? /(?:^|[^\w.-])(api(?:-[a-z0-9]+)?\.plaud\.ai)(?![\w.-])/.exec(own) : null;
  if (fromKey) return `https://${fromKey[1]}`;
  const urls = ctx.resourceUrls();
  for (let i = urls.length - 1; i >= 0; i--) {
    const m = API_ORIGIN.exec(urls[i] ?? "");
    if (m) return m[0];
  }
  for (let i = 0; i < ctx.storage.length; i++) {
    const key = ctx.storage.key(i);
    const value = key ? ctx.storage.getItem(key) : null;
    const m = value ? /https:\/\/api(?:-[a-z0-9]+)?\.plaud\.ai(?![\w.-])/.exec(value) : null;
    if (m) return m[0];
  }
  return null;
}

export class PlaudError extends Error {}

/** The headers the web app sends (A.8), as far as the tab holds their values. */
function headers(ctx: PageContext, token: string): Record<string, string> {
  const device = readDeviceId(ctx.storage);
  const workspace = readWorkspaceId(ctx.storage);
  return {
    authorization: token,
    "app-platform": "web",
    "edit-from": "web",
    "app-language": ctx.language.split("-")[0] || "en",
    ...(device ? { "x-device-id": device } : {}),
    ...(workspace ? { "x-scope-id": workspace, "x-scope-type": "workspace" } : {}),
  };
}

interface DetailObject {
  object_id: string;
  object_type: string;
  content_id: string;
  content_url: string;
  version_ms: number;
  relation_content_ids?: string[] | null;
}

/** The documents in a `files/detail` response, checked. */
export function parseDetail(body: unknown): {
  objects: DetailObject[];
  warnings: string[];
  /** Content id → signed link, for content a document refers to (such as the summary card). */
  relations: Record<string, string>;
  /** Kinds Plaud lists without usable content yet (a polished transcript still being redone, say). */
  incomplete: string[];
} {
  if (!body || typeof body !== "object") throw new PlaudError("Plaud's reply was not JSON");
  const b = body as {
    status?: unknown;
    msg?: unknown;
    data?: { objects?: unknown; relation_content_mapping?: unknown };
  };
  if (b.status !== 0) {
    throw new PlaudError(
      `Plaud refused the request (${String(b.status)}${typeof b.msg === "string" ? `: ${b.msg}` : ""})`,
    );
  }
  if (!Array.isArray(b.data?.objects)) throw new PlaudError("Plaud's reply has no document list");
  const warnings: string[] = [];
  const objects: DetailObject[] = [];
  const seen = new Map<string, number>();
  const incomplete: string[] = [];
  for (const o of b.data.objects as unknown[]) {
    if (!o || typeof o !== "object") continue;
    const x = o as Record<string, unknown>;
    if (typeof x.object_type !== "string" || !Object.hasOwn(OBJECT_KINDS, x.object_type)) continue;
    if (
      typeof x.object_id !== "string" ||
      typeof x.content_id !== "string" ||
      typeof x.content_url !== "string" ||
      typeof x.version_ms !== "number"
    ) {
      // The transcript is what every send rests on: without it, stop. Plaud
      // lists a polished transcript or summary with no content while it is
      // (re)making them, for example after a transcription is retried; leave
      // that one alone and carry on with the rest.
      if (x.object_type === "TRANSCRIPT")
        throw new PlaudError(`Plaud's ${x.object_type} entry is not in the expected shape`);
      incomplete.push(x.object_type);
      warnings.push(
        `Plaud's ${KIND_LABEL[x.object_type]} isn't ready (it has no content yet), so it is left as it is`,
      );
      continue;
    }
    seen.set(x.object_type, (seen.get(x.object_type) ?? 0) + 1);
    objects.push(x as unknown as DetailObject);
  }
  // Open question Q3: more than one of a kind is left alone rather than guessed at.
  for (const [type, n] of seen) {
    if (n > 1)
      warnings.push(`Plaud has ${n} ${KIND_LABEL[type]} documents; they are left as they are`);
  }
  const relations: Record<string, string> = {};
  const mapping = b.data.relation_content_mapping;
  if (mapping && typeof mapping === "object") {
    for (const [id, url] of Object.entries(mapping as Record<string, unknown>)) {
      if (/^c_[A-Za-z0-9]{8,64}$/.test(id) && typeof url === "string") relations[id] = url;
    }
  }
  return {
    objects: objects.filter((o) => seen.get(o.object_type) === 1),
    warnings,
    relations,
    incomplete,
  };
}

export interface ReadResult {
  documents: PlaudDocument[];
  warnings: string[];
}

function session(ctx: PageContext, fileId: string): { token: string; origin: string } {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(fileId)) throw new PlaudError("invalid recording id");
  const token = readToken(ctx.storage);
  if (!token) throw new PlaudError("You are not signed in to Plaud in this tab");
  const origin = findApiOrigin(ctx);
  if (!origin)
    throw new PlaudError("Couldn't find Plaud's API address. Reload the Plaud tab and try again");
  return { token, origin };
}

async function fetchDetail(
  ctx: PageContext,
  origin: string,
  token: string,
  fileId: string,
): Promise<ReturnType<typeof parseDetail>> {
  const res = await ctx.fetch(`${origin}/file-app/v4/files/detail/${encodeURIComponent(fileId)}`, {
    headers: headers(ctx, token),
  });
  if (res.status === 401)
    throw new PlaudError("Plaud says this tab is signed out. Sign in to Plaud again");
  if (!res.ok) throw new PlaudError(`Plaud returned HTTP ${res.status}`);
  return parseDetail(await res.json());
}

/** Plaud's transcript, polished transcript and summary for one recording, as they are now. */
export async function readDocuments(ctx: PageContext, fileId: string): Promise<ReadResult> {
  const { token, origin } = session(ctx, fileId);

  const { objects, warnings } = await fetchDetail(ctx, origin, token, fileId);
  if (!objects.some((o) => o.object_type === "TRANSCRIPT"))
    throw new PlaudError("Plaud has no transcript for this recording");

  const documents: PlaudDocument[] = [];
  for (const o of objects) {
    // Signed storage links: no credentials are sent with them.
    const content = await ctx.fetch(o.content_url, { credentials: "omit" });
    if (!content.ok)
      throw new PlaudError(
        `Couldn't download Plaud's ${OBJECT_KINDS[o.object_type]} (HTTP ${content.status})`,
      );
    documents.push({
      kind: OBJECT_KINDS[o.object_type]!,
      objectId: o.object_id,
      contentId: o.content_id,
      version: o.version_ms,
      content: await content.text(),
    });
  }
  return { documents, warnings };
}

/** The summary's reference to its card, as Plaud writes it at the top of the summary. */
const CARD_REF = /plaud:\/\/image\?type=summaryCard&id=(c_[A-Za-z0-9]{8,64})/;
const CARD_MAX_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * - `found`: the card, as base64 PNG.
 * - `none`: the summary refers to no card.
 * - `not_ready`: it refers to one Plaud hasn't produced yet.
 */
export type CardResult =
  { status: "found"; png: string } | { status: "none" } | { status: "not_ready" };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * The summary card Plaud's web app shows for a recording. Plaud's official
 * API names the card but never provides it; the web app's file detail maps
 * its id to a signed link to the PNG. Read only.
 */
export async function readSummaryCard(ctx: PageContext, fileId: string): Promise<CardResult> {
  const { token, origin } = session(ctx, fileId);
  const { objects, relations, incomplete } = await fetchDetail(ctx, origin, token, fileId);
  const summary = objects.find((o) => o.object_type === "SUMMARY");
  if (!summary) return { status: incomplete.includes("SUMMARY") ? "not_ready" : "none" };
  const res = await ctx.fetch(summary.content_url, { credentials: "omit" });
  if (!res.ok) throw new PlaudError(`Couldn't download Plaud's summary (HTTP ${res.status})`);
  const ref = CARD_REF.exec(await res.text());
  if (!ref) return { status: "none" };
  const url = relations[ref[1]!];
  if (!url) return { status: "not_ready" };
  if (!/^https:\/\//.test(url))
    throw new PlaudError("Plaud's link to the summary card isn't https");

  const card = await ctx.fetch(url, { credentials: "omit" });
  if (card.status === 403 || card.status === 404) return { status: "not_ready" };
  if (!card.ok) throw new PlaudError(`Couldn't download the summary card (HTTP ${card.status})`);
  const bytes = new Uint8Array(await card.arrayBuffer());
  if (bytes.length === 0 || bytes.length > CARD_MAX_BYTES)
    throw new PlaudError("The summary card is empty or too large");
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b))
    throw new PlaudError("The summary card isn't a PNG image");
  return { status: "found", png: toBase64(bytes) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Write the documents Applaud planned, in order (W5), and report each.
 * Before writing, Plaud's current version of each document is checked against
 * the one the plan was built from, and Plaud checks it again on the write
 * (W6). The first document that isn't applied stops the run; the documents
 * after it are not reported, and Applaud records them as not written.
 */
export async function writeDocuments(
  ctx: PageContext,
  fileId: string,
  writes: PlaudDocumentWrite[],
): Promise<PlaudWritebackResult[]> {
  const { token, origin } = session(ctx, fileId);
  const { objects } = await fetchDetail(ctx, origin, token, fileId);
  const results: PlaudWritebackResult[] = [];
  for (const [i, w] of writes.entries()) {
    const current = objects.find((o) => o.object_id === w.objectId && o.content_id === w.contentId);
    if (!current || current.version_ms !== w.originVersion) {
      results.push({
        kind: w.kind,
        outcome: "conflict",
        error: current
          ? "Plaud's document changed since it was read"
          : "the document is no longer in Plaud",
      });
      break;
    }
    if (i > 0) await (ctx.sleep ?? sleep)(WRITE_PAUSE_MS);
    const result = await writeOne(
      ctx,
      origin,
      token,
      fileId,
      w,
      current.relation_content_ids ?? null,
    );
    results.push(result);
    if (result.outcome !== "applied") break;
  }
  return results;
}

async function writeOne(
  ctx: PageContext,
  origin: string,
  token: string,
  fileId: string,
  w: PlaudDocumentWrite,
  relations: string[] | null,
): Promise<PlaudWritebackResult> {
  let res: Response;
  try {
    res = await ctx.fetch(
      `${origin}/file-app/v4/files/update/content/${encodeURIComponent(fileId)}`,
      {
        method: "PATCH",
        headers: {
          ...headers(ctx, token),
          "content-type": "application/json",
          "x-request-id": ctx.requestId?.() ?? crypto.randomUUID(),
          ...(ctx.timeZone ? { "x-timezone-iana": ctx.timeZone } : {}),
        },
        body: JSON.stringify({
          object_id: w.objectId,
          content_id: w.contentId,
          content: w.content,
          origin_version: w.originVersion,
          ...(Array.isArray(relations) && relations.length > 0
            ? { relation_content_ids: relations }
            : {}),
        }),
      },
    );
  } catch {
    // No reply: Plaud may or may not have applied it. The next send reads Plaud
    // afresh, so it completes the work either way (W5).
    return {
      kind: w.kind,
      outcome: "failed",
      error: "no reply from Plaud; it may have been written",
    };
  }
  if (res.status === 401) {
    return { kind: w.kind, outcome: "failed", error: "Plaud says this tab is signed out" };
  }
  let body: { status?: unknown; msg?: unknown; data?: { version_ms?: unknown } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* handled below */
  }
  const msg = typeof body.msg === "string" ? body.msg.slice(0, 200) : `HTTP ${res.status}`;
  // Success is status 0 in the body; HTTP 200 alone is not (W6).
  if (res.ok && body.status === 0 && typeof body.data?.version_ms === "number") {
    return { kind: w.kind, outcome: "applied", newVersion: body.data.version_ms };
  }
  if (body.status === VERSION_CONFLICT) {
    return { kind: w.kind, outcome: "conflict", error: `Plaud: ${msg}` };
  }
  return { kind: w.kind, outcome: "failed", error: `Plaud: ${msg}` };
}

/** What a dry run needs from the page, by name only: never a token or other value. */
export interface Diagnosis {
  signedIn: boolean;
  /** The storage key the token was found under (its name, never its value). */
  tokenSource: TokenSource | null;
  apiOrigin: string | null;
  deviceId: boolean;
  workspace: boolean;
  /** Storage keys that may hold the region, workspace or device id (open question Q1). */
  relevantKeys: string[];
}

export function diagnose(ctx: Pick<PageContext, "storage" | "resourceUrls">): Diagnosis {
  const keys: string[] = [];
  for (let i = 0; i < ctx.storage.length; i++) {
    const k = ctx.storage.key(i);
    if (k && /device|scope|workspace|region|domain|api|token/i.test(k)) keys.push(k);
  }
  return {
    signedIn: readToken(ctx.storage) !== null,
    tokenSource: findToken(ctx.storage)?.source ?? null,
    apiOrigin: findApiOrigin(ctx),
    deviceId: readDeviceId(ctx.storage) !== null,
    workspace: readWorkspaceId(ctx.storage) !== null,
    relevantKeys: keys.sort(),
  };
}
