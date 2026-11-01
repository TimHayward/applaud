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

export function readToken(storage: PageContext["storage"]): string | null {
  const raw = storage.getItem(TOKEN_KEY);
  if (!raw) return null;
  const v = raw.trim().replace(/^"|"$/g, "");
  return /^bearer\s+\S{20,}$/i.test(v) ? v : null;
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
export function parseDetail(body: unknown): { objects: DetailObject[]; warnings: string[] } {
  if (!body || typeof body !== "object") throw new PlaudError("Plaud's reply was not JSON");
  const b = body as { status?: unknown; msg?: unknown; data?: { objects?: unknown } };
  if (b.status !== 0) {
    throw new PlaudError(
      `Plaud refused the request (${String(b.status)}${typeof b.msg === "string" ? `: ${b.msg}` : ""})`,
    );
  }
  if (!Array.isArray(b.data?.objects)) throw new PlaudError("Plaud's reply has no document list");
  const warnings: string[] = [];
  const objects: DetailObject[] = [];
  const seen = new Map<string, number>();
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
      throw new PlaudError(`Plaud's ${x.object_type} entry is not in the expected shape`);
    }
    seen.set(x.object_type, (seen.get(x.object_type) ?? 0) + 1);
    objects.push(x as unknown as DetailObject);
  }
  // Open question Q3: more than one of a kind is left alone rather than guessed at.
  for (const [type, n] of seen) {
    if (n > 1)
      warnings.push(`Plaud has ${n} ${OBJECT_KINDS[type]} documents; they are left as they are`);
  }
  return { objects: objects.filter((o) => seen.get(o.object_type) === 1), warnings };
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
): Promise<{ objects: DetailObject[]; warnings: string[] }> {
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
    apiOrigin: findApiOrigin(ctx),
    deviceId: readDeviceId(ctx.storage) !== null,
    workspace: readWorkspaceId(ctx.storage) !== null,
    relevantKeys: keys.sort(),
  };
}
