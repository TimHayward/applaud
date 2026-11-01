/**
 * Reading Plaud's documents from inside the Plaud web app, with the user's own
 * session (plan W8). Phase 2 is read only: nothing here writes to Plaud.
 *
 * Shapes are from the spike capture (plan Appendix A.8). Everything is checked
 * before use, and anything unexpected is an error rather than a guess (P6).
 */
import type { PlaudDocument, PlaudDocumentKind } from "@applaud/shared";

/** Where the web app keeps its session token, prefixed `bearer ` (A.10). */
export const TOKEN_KEY = "pld_tokenstr";

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
  const urls = ctx.resourceUrls();
  for (let i = urls.length - 1; i >= 0; i--) {
    const m = API_ORIGIN.exec(urls[i] ?? "");
    if (m) return m[0];
  }
  for (let i = 0; i < ctx.storage.length; i++) {
    const key = ctx.storage.key(i);
    const value = key ? ctx.storage.getItem(key) : null;
    const m = value ? /https:\/\/api(?:-[a-z0-9]+)?\.plaud\.ai/.exec(value) : null;
    if (m) return m[0];
  }
  return null;
}

export class PlaudError extends Error {}

/** Headers the web app sends that a read needs (A.8); the minimum set is open question Q1. */
function headers(token: string, language: string): Record<string, string> {
  return {
    authorization: token,
    "app-platform": "web",
    "edit-from": "web",
    "app-language": language.split("-")[0] || "en",
  };
}

interface DetailObject {
  object_id: string;
  object_type: string;
  content_id: string;
  content_url: string;
  version_ms: number;
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

/** Plaud's transcript, polished transcript and summary for one recording, as they are now. */
export async function readDocuments(ctx: PageContext, fileId: string): Promise<ReadResult> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(fileId)) throw new PlaudError("invalid recording id");
  const token = readToken(ctx.storage);
  if (!token) throw new PlaudError("You are not signed in to Plaud in this tab");
  const origin = findApiOrigin(ctx);
  if (!origin)
    throw new PlaudError("Couldn't find Plaud's API address. Reload the Plaud tab and try again");

  const res = await ctx.fetch(`${origin}/file-app/v4/files/detail/${encodeURIComponent(fileId)}`, {
    headers: headers(token, ctx.language),
  });
  if (res.status === 401)
    throw new PlaudError("Plaud says this tab is signed out. Sign in to Plaud again");
  if (!res.ok) throw new PlaudError(`Plaud returned HTTP ${res.status}`);
  const { objects, warnings } = parseDetail(await res.json());
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

/** What a dry run needs from the page, by name only: never a token or other value. */
export interface Diagnosis {
  signedIn: boolean;
  apiOrigin: string | null;
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
    relevantKeys: keys.sort(),
  };
}
