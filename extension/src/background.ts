/**
 * Service worker: holds the pairing with Applaud and runs dry runs, sends and
 * undos (plan section 3). Plaud is only ever reached through the content
 * script in a Plaud tab. One send at a time, whether single or a batch.
 */
import { PLAUD_WRITEBACK_PROTOCOL, type PlaudWritebackResult } from "@applaud/shared";
import { ApplaudClient, ApplaudError, normaliseApplaudUrl } from "./applaud.js";
import type {
  ContentReplies,
  ContentRequest,
  PopupReplies,
  PopupRequest,
  Reply,
  StatusReply,
} from "./messages.js";
import { MAX_BATCH, newBatch, runBatch, type BatchItem, type BatchState } from "./batch.js";
import { send, undo, type SendDeps } from "./send.js";
import { fetchCardIfNeeded, fetchCards, type CardDeps } from "./cards.js";

interface Stored {
  applaudUrl?: string;
  token?: string;
}

/** Results Plaud accepted that Applaud hasn't recorded yet (it was unreachable). */
interface Unreported {
  applaudUrl: string;
  planId: string;
  results: PlaudWritebackResult[];
}

async function unreported(): Promise<Unreported[]> {
  const v = (await chrome.storage.local.get("unreported")) as { unreported?: Unreported[] };
  return Array.isArray(v.unreported) ? v.unreported : [];
}

async function keepUnreported(planId: string, results: PlaudWritebackResult[]): Promise<void> {
  const s = await stored();
  if (!s.applaudUrl) return;
  const list = await unreported();
  list.push({ applaudUrl: s.applaudUrl, planId, results });
  await chrome.storage.local.set({ unreported: list });
}

/** Tell Applaud about earlier results it missed; keep the ones that still fail. */
async function flushUnreported(): Promise<number> {
  const list = await unreported();
  if (list.length === 0) return 0;
  const s = await stored();
  const keep: Unreported[] = [];
  for (const u of list) {
    if (!s.token || u.applaudUrl !== s.applaudUrl) continue; // paired elsewhere since: drop
    try {
      await new ApplaudClient(u.applaudUrl, s.token).results(u.planId, u.results);
    } catch (err) {
      // 404/409: Applaud already has them or dropped the plan; nothing more to do.
      if (!(err instanceof ApplaudError) || err.status === 0 || err.status >= 500) keep.push(u);
    }
  }
  await chrome.storage.local.set({ unreported: keep });
  return keep.length;
}

let busy = false;

async function exclusive<T>(run: () => Promise<T>): Promise<T> {
  if (busy) throw new Error("A send is already running. Wait for it to finish");
  busy = true;
  try {
    return await run();
  } finally {
    busy = false;
  }
}

/**
 * The batch's progress lives in session storage, so a popup opened later
 * (or on another window) can show it; the loop itself runs here.
 */
let batchActive = false;
let batchStop = false;

async function batchState(): Promise<BatchState | null> {
  const v = (await chrome.storage.session.get("batch")) as { batch?: BatchState };
  const state = v.batch ?? null;
  // The worker restarted mid-batch (rare): the loop is gone, so say so.
  if (state?.running && !batchActive) {
    state.running = false;
    state.current = null;
    state.stoppedBecause = "the extension restarted; send the rest again";
    state.finishedAt = Date.now();
    await chrome.storage.session.set({ batch: state });
  }
  return state;
}

async function startBatch(items: BatchItem[]): Promise<BatchState> {
  if (busy) throw new Error("A send is already running. Wait for it to finish");
  const clean = items
    .filter(
      (i) => typeof i?.recordingId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(i.recordingId),
    )
    .slice(0, MAX_BATCH)
    .map((i) => ({ recordingId: i.recordingId, title: String(i.title ?? "").slice(0, 200) }));
  if (clean.length === 0) throw new Error("Nothing to send");
  const deps = await sendDeps();
  const cards = await cardDeps();
  const state = newBatch(clean, Date.now());
  await chrome.storage.session.set({ batch: state });
  busy = true;
  batchActive = true;
  batchStop = false;
  void runBatch(state, {
    send: async (id) => {
      await fetchCardIfNeeded(cards, id);
      return send(deps, id);
    },
    save: (s) => chrome.storage.session.set({ batch: s }),
    stopRequested: () => batchStop,
  }).finally(() => {
    busy = false;
    batchActive = false;
  });
  return state;
}

async function cardDeps(): Promise<CardDeps> {
  const app = await client();
  return {
    needed: async () => (await app.cardsNeeded()).recordings.map((r) => r.recordingId),
    readCard: (fileId) => askPlaud({ type: "plaud.card", fileId }),
    save: (id, body) => app.card(id, body),
  };
}

async function sendDeps(): Promise<SendDeps> {
  const app = await client();
  return {
    readPlaud: (fileId) => askPlaud({ type: "plaud.read", fileId }),
    writePlaud: (fileId, writes) => askPlaud({ type: "plaud.write", fileId, writes }),
    plan: (id, docs) => app.plan(id, docs),
    undo: (id) => app.undo(id),
    report: (planId, results) => app.results(planId, results),
    keepUnreported,
  };
}

async function stored(): Promise<Stored> {
  return (await chrome.storage.local.get(["applaudUrl", "token"])) as Stored;
}

async function client(): Promise<ApplaudClient> {
  const s = await stored();
  if (!s.applaudUrl || !s.token) throw new Error("Pair the extension with Applaud first");
  return new ApplaudClient(s.applaudUrl, s.token);
}

/** The Plaud tab you're looking at, else the one used most recently. */
async function plaudTab(): Promise<chrome.tabs.Tab | null> {
  const [current] = await chrome.tabs.query({
    url: "https://web.plaud.ai/*",
    active: true,
    lastFocusedWindow: true,
  });
  if (current) return current;
  const tabs = await chrome.tabs.query({ url: "https://web.plaud.ai/*" });
  return tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0] ?? null;
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
    // A Plaud tab opened before the extension was installed or reloaded has no
    // content script yet: add it, then ask once more.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      reply = (await chrome.tabs.sendMessage(tab.id, req)) as Reply<ContentReplies[K]> | undefined;
    } catch {
      throw new Error("The Plaud tab isn't ready for the extension. Reload it and try again");
    }
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
    unreported: 0,
    error: null,
  };
  if (!base.paired) return base;
  base.unreported = await flushUnreported().catch(() => base.unreported);
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
      // While this recording is open in Plaud anyway: its summary card, if Applaud lacks it.
      await fetchCardIfNeeded(await cardDeps(), msg.recordingId);
      return { plan, warnings: read.warnings };
    }
    case "undoable":
      return (await (await client()).undoable()).recordings;
    case "apply": {
      const deps = await sendDeps();
      const cards = await cardDeps();
      // The card first, so Applaud's re-read and webhook after the send carry it.
      return exclusive(async () => {
        await fetchCardIfNeeded(cards, msg.recordingId);
        return send(deps, msg.recordingId);
      });
    }
    case "cardsNeeded":
      return (await (await client()).cardsNeeded(100)).recordings.length;
    case "fetchCards": {
      const cards = await cardDeps();
      return exclusive(() => fetchCards(cards));
    }
    case "undo": {
      const deps = await sendDeps();
      return exclusive(() => undo(deps, msg.recordingId));
    }
    case "sendAll":
      return startBatch(Array.isArray(msg.items) ? msg.items : []);
    case "batchStatus":
      return batchState();
    case "stopBatch":
      batchStop = true;
      return batchState();
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
