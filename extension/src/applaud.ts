/**
 * Talking to the user's Applaud from the extension's service worker (plan W9,
 * W10, W13). The extension token reaches `/api/plaud-writeback/*` only.
 */
import {
  PLAUD_WRITEBACK_PROTOCOL,
  PLAUD_WRITEBACK_PROTOCOL_HEADER,
  type PlaudDocument,
  type PlaudWritebackPairResponse,
  type PlaudWritebackPendingResponse,
  type PlaudWritebackPlanResponse,
  type PlaudWritebackResult,
  type PlaudWritebackUndoable,
  type PlaudCardRequest,
  type PlaudCardsNeededResponse,
} from "@applaud/shared";

export class ApplaudError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The Applaud address the user typed, reduced to its origin. Only http(s);
 * a path or query the user pasted is dropped.
 */
export function normaliseApplaudUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.origin;
}

async function errorFrom(res: Response): Promise<ApplaudError> {
  let message = `Applaud returned HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    /* not JSON */
  }
  if (res.status === 401) message = "Applaud no longer recognises this extension. Pair it again";
  return new ApplaudError(message, res.status);
}

export class ApplaudClient {
  constructor(
    private readonly origin: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}/api/plaud-writeback${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          [PLAUD_WRITEBACK_PROTOCOL_HEADER]: String(PLAUD_WRITEBACK_PROTOCOL),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApplaudError(`Couldn't reach Applaud at ${this.origin}`, 0);
    }
    if (!res.ok) throw await errorFrom(res);
    return (await res.json()) as T;
  }

  pair(code: string, name: string): Promise<PlaudWritebackPairResponse> {
    return this.call("POST", "/pair", { code, name });
  }

  status(): Promise<{
    protocol: number;
    speakersEnabled: boolean;
    enabled: boolean;
    paired: boolean;
  }> {
    return this.call("GET", "/status");
  }

  pending(): Promise<PlaudWritebackPendingResponse> {
    return this.call("GET", "/pending");
  }

  /** What would change; Applaud records nothing and returns no plan id. */
  dryRun(recordingId: string, documents: PlaudDocument[]): Promise<PlaudWritebackPlanResponse> {
    return this.call("POST", "/plan", { recordingId, documents, dryRun: true });
  }

  /** The documents to write, recorded by Applaud as planned with their previous content (W11). */
  plan(recordingId: string, documents: PlaudDocument[]): Promise<PlaudWritebackPlanResponse> {
    return this.call("POST", "/plan", { recordingId, documents });
  }

  results(planId: string, results: PlaudWritebackResult[]): Promise<{ ok: boolean }> {
    return this.call("POST", "/results", { planId, results });
  }

  undo(recordingId: string): Promise<PlaudWritebackPlanResponse> {
    return this.call("POST", `/undo/${encodeURIComponent(recordingId)}`, {});
  }

  undoable(): Promise<{ recordings: PlaudWritebackUndoable[] }> {
    return this.call("GET", "/undoable");
  }

  /** Recordings whose summary card is worth fetching, newest first. */
  cardsNeeded(limit = 25): Promise<PlaudCardsNeededResponse> {
    return this.call("GET", `/cards/needed?limit=${limit}`);
  }

  card(recordingId: string, body: PlaudCardRequest): Promise<{ ok: boolean }> {
    return this.call("POST", `/cards/${encodeURIComponent(recordingId)}`, body);
  }
}
