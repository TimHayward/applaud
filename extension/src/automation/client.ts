/**
 * The automation browser's own calls to Applaud (`/api/plaud-writeback/automation/*`)
 * and its credential, which Applaud writes into the folder the browser
 * container mounts at `secret/` inside this extension. Sends, results and
 * cards go through the desktop extension's `ApplaudClient`, unchanged.
 */
import {
  PLAUD_AUTOMATION_CLIENT_FILE,
  PLAUD_AUTOMATION_FEATURES,
  PLAUD_AUTOMATION_FEATURES_HEADER,
  PLAUD_AUTOMATION_VERSION_HEADER,
  PLAUD_WRITEBACK_PROTOCOL,
  PLAUD_WRITEBACK_PROTOCOL_HEADER,
  type PlaudAutomationClientFile,
  type PlaudAutomationHeartbeat,
  type PlaudAutomationNextResponse,
  type PlaudWritebackRecording,
} from "@applaud/shared";
import { ApplaudError, normaliseApplaudUrl } from "../applaud.js";

/** Read the credential Applaud left for this browser; null while automatic sync is off. */
export async function loadCredential(
  url: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<PlaudAutomationClientFile | null> {
  try {
    const res = await fetchImpl(url, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<PlaudAutomationClientFile>;
    const origin =
      typeof body.applaudUrl === "string" ? normaliseApplaudUrl(body.applaudUrl) : null;
    if (!origin || typeof body.token !== "string" || !/^[0-9a-f]{64}$/.test(body.token))
      return null;
    return { applaudUrl: origin, token: body.token };
  } catch {
    return null;
  }
}

export const CREDENTIAL_PATH = `secret/${PLAUD_AUTOMATION_CLIENT_FILE}`;

export class AutomationClient {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    /** The extension's manifest version, reported so Settings can spot an old build. */
    private readonly version: string | null = null,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}/api/plaud-writeback/automation${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          [PLAUD_WRITEBACK_PROTOCOL_HEADER]: String(PLAUD_WRITEBACK_PROTOCOL),
          [PLAUD_AUTOMATION_FEATURES_HEADER]: PLAUD_AUTOMATION_FEATURES.join(","),
          ...(this.version ? { [PLAUD_AUTOMATION_VERSION_HEADER]: this.version } : {}),
          authorization: `Bearer ${this.token}`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApplaudError(`Couldn't reach Applaud at ${this.origin}`, 0);
    }
    if (!res.ok) {
      let message = `Applaud returned HTTP ${res.status}`;
      try {
        const b = (await res.json()) as { error?: unknown };
        if (typeof b.error === "string") message = b.error;
      } catch {
        /* not JSON */
      }
      throw new ApplaudError(message, res.status);
    }
    return (await res.json()) as T;
  }

  next(): Promise<PlaudAutomationNextResponse> {
    return this.call("GET", "/next");
  }

  async pending(): Promise<PlaudWritebackRecording[]> {
    return (await this.call<{ recordings: PlaudWritebackRecording[] }>("GET", "/pending"))
      .recordings;
  }

  heartbeat(hb: PlaudAutomationHeartbeat): Promise<{ ok: boolean }> {
    return this.call("POST", "/heartbeat", hb);
  }
}
