/**
 * Content script on https://web.plaud.ai (plan W8). Runs Plaud requests in the
 * page's origin with the page's own session. The token is read when needed
 * and never stored or passed on. It writes only documents Applaud planned.
 */
import type { ContentRequest, Reply } from "./messages.js";
import { diagnose, readDocuments, writeDocuments, type PageContext } from "./plaud.js";

const ctx: PageContext = {
  storage: localStorage,
  resourceUrls: () => performance.getEntriesByType("resource").map((e) => e.name),
  fetch: (...args) => fetch(...args),
  language: navigator.language || "en",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

chrome.runtime.onMessage.addListener((msg: ContentRequest, sender, sendResponse) => {
  // Only this extension's own service worker talks to the content script.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  const run = async (): Promise<unknown> => {
    switch (msg.type) {
      case "plaud.read":
        return readDocuments(ctx, msg.fileId);
      case "plaud.write":
        return writeDocuments(ctx, msg.fileId, msg.writes);
      case "plaud.diagnose":
        return diagnose(ctx);
      default:
        throw new Error("unknown request");
    }
  };
  run().then(
    (value) => sendResponse({ ok: true, value } satisfies Reply<unknown>),
    (err: unknown) =>
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies Reply<unknown>),
  );
  return true;
});
