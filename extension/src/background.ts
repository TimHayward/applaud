/**
 * Service worker: holds the pairing with Applaud and runs the dry run
 * (plan section 3, steps 2 to 4). Plaud is only ever reached through the
 * content script in a Plaud tab. Phase 2: read only.
 */
import { PLAUD_WRITEBACK_PROTOCOL } from "@applaud/shared";
import { ApplaudClient, ApplaudError, normaliseApplaudUrl } from "./applaud.js";
import type {
  ContentReplies,
  ContentRequest,
  PopupReplies,
  PopupRequest,
  Reply,
  StatusReply,
} from "./messages.js";

interface Stored {
  applaudUrl?: string;
  token?: string;
}

async function stored(): Promise<Stored> {
  return (await chrome.storage.local.get(["applaudUrl", "token"])) as Stored;
}

async function client(): Promise<ApplaudClient> {
  const s = await stored();
  if (!s.applaudUrl || !s.token) throw new Error("Pair the extension with Applaud first");
  return new ApplaudClient(s.applaudUrl, s.token);
}

async function plaudTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: "https://web.plaud.ai/*" });
  return tabs.find((t) => t.active) ?? tabs[0] ?? null;
}

async function askPlaud<K extends ContentRequest["type"]>(
  req: Extract<ContentRequest, { type: K }>,
): Promise<ContentReplies[K]> {
  const tab = await plaudTab();
  if (tab?.id === undefined)
    throw new Error("Open Plaud (web.plaud.ai) in a tab and sign in, then try again");
  let reply: Reply<ContentReplies[K]> | undefined;
  try {
    reply = (await chrome.tabs.sendMessage(tab.id, req)) as Reply<ContentReplies[K]> | undefined;
  } catch {
    throw new Error("The Plaud tab isn't ready for the extension. Reload it and try again");
  }
  if (!reply) throw new Error("The Plaud tab didn't answer. Reload it and try again");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

async function status(): Promise<StatusReply> {
  const s = await stored();
  const base: StatusReply = {
    paired: !!(s.applaudUrl && s.token),
    applaudUrl: s.applaudUrl ?? null,
    applaud: null,
    plaudTab: (await plaudTab()) !== null,
    error: null,
  };
  if (!base.paired) return base;
  try {
    const st = await (await client()).status();
    if (st.protocol !== PLAUD_WRITEBACK_PROTOCOL) {
      return {
        ...base,
        error: `This extension speaks protocol ${PLAUD_WRITEBACK_PROTOCOL}; Applaud speaks ${st.protocol}. Install the extension from the same Applaud release`,
      };
    }
    return {
      ...base,
      applaud: { enabled: st.enabled, speakersEnabled: st.speakersEnabled, protocol: st.protocol },
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

async function pair(applaudUrl: string, code: string, name: string): Promise<StatusReply> {
  const origin = normaliseApplaudUrl(applaudUrl);
  if (!origin) throw new Error("Enter Applaud's address, for example http://192.168.1.20:44471");
  // The popup asks for this permission on the user's click (W9).
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
    throw new Error(`The extension needs permission to reach ${origin}`);
  }
  const out = await new ApplaudClient(origin, null).pair(code, name);
  await chrome.storage.local.set({ applaudUrl: origin, token: out.token });
  return status();
}

async function unpair(): Promise<StatusReply> {
  const s = await stored();
  await chrome.storage.local.remove(["applaudUrl", "token"]);
  if (s.applaudUrl)
    await chrome.permissions.remove({ origins: [`${s.applaudUrl}/*`] }).catch(() => false);
  return status();
}

async function handle(msg: PopupRequest): Promise<PopupReplies[PopupRequest["type"]]> {
  switch (msg.type) {
    case "status":
      return status();
    case "pair":
      return pair(msg.applaudUrl, msg.code, msg.name);
    case "unpair":
      return unpair();
    case "pending":
      return (await (await client()).pending()).recordings;
    case "dryRun": {
      const app = await client();
      const read = await askPlaud({ type: "plaud.read", fileId: msg.recordingId });
      const plan = await app.dryRun(msg.recordingId, read.documents);
      return { plan, warnings: read.warnings };
    }
    case "diagnose":
      return askPlaud({ type: "plaud.diagnose" });
    default:
      throw new Error("unknown request");
  }
}

chrome.runtime.onMessage.addListener((msg: PopupRequest, sender, sendResponse) => {
  // Only the extension's own pages (the popup); a content script's sender URL is the web page's.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")))
    return false;
  handle(msg).then(
    (value) => sendResponse({ ok: true, value } satisfies Reply<unknown>),
    (err: unknown) =>
      sendResponse({
        ok: false,
        error: err instanceof ApplaudError || err instanceof Error ? err.message : String(err),
      } satisfies Reply<unknown>),
  );
  return true;
});
