/**
 * Service worker of the Applaud automation extension, the build that runs in
 * the always-on browser container (Settings → Automatic Plaud sync). It has
 * no popup: it checks in with Applaud every minute and runs when Applaud says
 * a run is due. The desktop extension (`../background.ts`) is a separate
 * build and is unaffected by this one.
 *
 * `plaudTab`, `askPlaud` and the unreported-results queue are copies of the
 * desktop worker's, kept here so that worker stays exactly as it is.
 */
import type { PlaudWritebackResult } from "@applaud/shared";
import { ApplaudClient, ApplaudError } from "../applaud.js";
import type { ContentReplies, ContentRequest, Reply } from "../messages.js";
import type { SendDeps } from "../send.js";
import { AutomationClient, CREDENTIAL_PATH, loadCredential } from "./client.js";
import { runOnce, type RunDeps } from "./run.js";

const ALARM = "applaud-automation";
const PLAUD_URL = "https://web.plaud.ai/";
const TAB_LOAD_TIMEOUT_MS = 60_000;

// ── Results Applaud couldn't be told about (copied from background.ts) ──

interface Unreported {
  applaudUrl: string;
  planId: string;
  results: PlaudWritebackResult[];
}

async function unreported(): Promise<Unreported[]> {
  const v = (await chrome.storage.local.get("unreported")) as { unreported?: Unreported[] };
  return Array.isArray(v.unreported) ? v.unreported : [];
}

async function keepUnreported(
  applaudUrl: string,
  planId: string,
  results: PlaudWritebackResult[],
): Promise<void> {
  const list = await unreported();
  list.push({ applaudUrl, planId, results });
  await chrome.storage.local.set({ unreported: list });
}

async function flushUnreported(applaudUrl: string, token: string): Promise<number> {
  const list = await unreported();
  if (list.length === 0) return 0;
  const keep: Unreported[] = [];
  for (const u of list) {
    if (u.applaudUrl !== applaudUrl) continue;
    try {
      await new ApplaudClient(u.applaudUrl, token).results(u.planId, u.results);
    } catch (err) {
      // 404/409: Applaud already has them or dropped the plan; nothing more to do.
      if (!(err instanceof ApplaudError) || err.status === 0 || err.status >= 500) keep.push(u);
    }
  }
  await chrome.storage.local.set({ unreported: keep });
  return keep.length;
}

// ── The Plaud tab (copied from background.ts, plus opening one in the background) ──

/** The Plaud tab this worker opened for the current run, closed when the run ends. */
let openedTabId: number | null = null;

async function plaudTab(): Promise<chrome.tabs.Tab | null> {
  if (openedTabId !== null) {
    const tab = await chrome.tabs.get(openedTabId).catch(() => null);
    if (tab) return tab;
    openedTabId = null;
  }
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

function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Plaud didn't finish loading in the automation browser"));
    }, TAB_LOAD_TIMEOUT_MS);
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // It may already have loaded before the listener was added.
    void chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") onUpdated(tabId, { status: "complete" });
    });
  });
}

/** Use an open Plaud tab, or open one in the background. True when this run opened it. */
async function openPlaud(): Promise<boolean> {
  if (await plaudTab()) return false;
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.create({ url: PLAUD_URL, active: false });
  } catch {
    // No browser window left open: make one.
    const win = await chrome.windows.create({ url: PLAUD_URL, focused: false });
    tab = win?.tabs?.[0];
  }
  if (tab?.id === undefined) throw new Error("Couldn't open Plaud in the automation browser");
  openedTabId = tab.id;
  await waitForLoad(tab.id);
  return true;
}

async function closePlaud(): Promise<void> {
  const id = openedTabId;
  openedTabId = null;
  if (id !== null) await chrome.tabs.remove(id).catch(() => undefined);
}

// ── The run ──

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const cred = await loadCredential(chrome.runtime.getURL(CREDENTIAL_PATH));
    if (!cred) return; // Automatic sync is off in Applaud.
    const app = new ApplaudClient(cred.applaudUrl, cred.token);
    const auto = new AutomationClient(cred.applaudUrl, cred.token);
    const sendDeps: SendDeps = {
      readPlaud: (fileId) => askPlaud({ type: "plaud.read", fileId }),
      writePlaud: (fileId, writes) => askPlaud({ type: "plaud.write", fileId, writes }),
      plan: (id, docs) => app.plan(id, docs),
      undo: (id) => app.undo(id),
      report: (planId, results) => app.results(planId, results),
      keepUnreported: (planId, results) => keepUnreported(cred.applaudUrl, planId, results),
    };
    const deps: RunDeps = {
      next: () => auto.next(),
      pending: async () =>
        (await auto.pending()).map((r) => ({ recordingId: r.recordingId, title: r.title })),
      cardsNeeded: async () => (await app.cardsNeeded()).recordings.map((r) => r.recordingId),
      saveCard: (id, body) => app.card(id, body),
      heartbeat: (hb) => auto.heartbeat(hb),
      flushUnreported: () => flushUnreported(cred.applaudUrl, cred.token),
      send: sendDeps,
      readCard: (fileId) => askPlaud({ type: "plaud.card", fileId }),
      openPlaud,
      closePlaud,
      signedIn: async () => (await askPlaud({ type: "plaud.diagnose" })).signedIn,
    };
    await runOnce(deps);
  } catch (err) {
    // Applaud unreachable or refusing: try again at the next check-in.
    console.warn("Applaud automation:", err instanceof Error ? err.message : String(err));
  } finally {
    running = false;
  }
}

async function ensureAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });
  }
}

chrome.runtime.onInstalled.addListener(() => void ensureAlarm());
chrome.runtime.onStartup.addListener(() => void ensureAlarm());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void tick();
});
void ensureAlarm();
