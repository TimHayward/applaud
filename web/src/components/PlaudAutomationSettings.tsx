import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PlaudAutomationStatus,
  PlaudAutomationTestResult,
  PlaudAutomationUpdate,
} from "@applaud/shared";
import { api } from "../api.js";
import { useToast } from "./Toast.js";
import { formatRelative } from "../lib/format.js";

export const AUTOMATION_QUERY_KEY = ["plaud-automation"] as const;

const DOCS_URL =
  "https://github.com/TimHayward/applaud/blob/main/docs/portainer.md#automatic-plaud-sync";

/** The viewer's address on this host and the stack's APPLAUD_BROWSER_PORT. */
function defaultViewerAddress(s: Pick<PlaudAutomationStatus, "viewerPort">): string {
  return `https://${window.location.hostname}:${s.viewerPort || 3001}`;
}

/** The viewer's address: as set, else the default one. */
export function viewerAddress(s: Pick<PlaudAutomationStatus, "viewerUrl" | "viewerPort">): string {
  return s.viewerUrl || defaultViewerAddress(s);
}

/** The browser checks in every minute; a test unanswered after this has failed. */
const TEST_TIMEOUT_MS = 90_000;

/** A failed test, in words. */
export function testResultText(t: PlaudAutomationTestResult): string {
  if (t.plaudSignedIn === false)
    return "the browser is signed out of Plaud. Open the browser and sign in";
  return t.error ?? "the browser couldn't check Plaud";
}

/** An API error's message: the server's `error` text when it sent JSON. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const body = JSON.parse(raw) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    /* not JSON */
  }
  return raw;
}

/**
 * Settings → Automatic Plaud sync: lets the Applaud browser container send
 * confirmed names and fetch summary cards without anyone opening Plaud.
 * Off by default. The desktop extension is unaffected either way.
 */
export function PlaudAutomationSettings(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const status = useQuery({
    queryKey: AUTOMATION_QUERY_KEY,
    queryFn: api.plaudAutomationStatus,
    refetchInterval: (q) =>
      q.state.data?.test.requestedAt ? 3_000 : q.state.data?.enabled ? 15_000 : 60_000,
  });
  const speakers = useQuery({ queryKey: ["speaker-status"], queryFn: api.speakerStatus });
  const s = status.data;
  const [viewerUrl, setViewerUrl] = useState("");
  useEffect(() => {
    if (s) setViewerUrl(s.viewerUrl);
  }, [s?.viewerUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (run: () => Promise<PlaudAutomationStatus>, done?: string): Promise<void> => {
    setWorking(true);
    try {
      qc.setQueryData(AUTOMATION_QUERY_KEY, await run());
      if (done) toast.success(done);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setWorking(false);
    }
  };
  const update = (patch: PlaudAutomationUpdate): Promise<void> =>
    act(() => api.updatePlaudAutomation(patch));

  const sendToPlaud = speakers.data?.enabled === true && speakers.data.sendToPlaud === true;
  const busy = working || !s;

  // Connection test: the browser answers at its next check-in, within a minute.
  const testing = s?.test.requestedAt ?? null;
  // Re-render while waiting, so an unanswered test shows as such.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (testing === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, [testing]);
  const testStale = testing !== null && Date.now() - testing > TEST_TIMEOUT_MS;
  const testStarted = useRef<number | null>(null);
  const lastTest = s?.test.last ?? null;
  useEffect(() => {
    const started = testStarted.current;
    if (started === null || !lastTest || lastTest.at < started) return;
    testStarted.current = null;
    if (lastTest.plaudSignedIn)
      toast.success("Test passed: the browser is connected and signed in to Plaud.");
    else toast.error(`Test failed: ${testResultText(lastTest)}.`);
  }, [lastTest?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const startTest = async (): Promise<void> => {
    testStarted.current = Date.now();
    await act(api.testPlaudAutomation, "Testing. The browser answers within a minute.");
  };

  return (
    <section className="card p-8 space-y-6">
      <div className="flex justify-between items-start gap-6">
        <div className="space-y-1">
          <h2 className="text-xl font-bold text-on-surface">Automatic Plaud sync</h2>
          <p className="text-sm text-on-surface-variant max-w-prose">
            Sends the speaker names you confirm, and fetches summary cards, without you opening
            Plaud. It runs in the Applaud browser container, which stays signed in to Plaud. Plaud
            is only contacted when there is something to do. Like the extension, this is not a Plaud
            feature and Plaud does not support it. The browser extension keeps working as it does
            now.
          </p>
        </div>
        <label className="flex items-center gap-2 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-outline-variant text-primary focus:ring-primary cursor-pointer"
            checked={s?.enabled ?? false}
            disabled={busy || (!s.available && !s.enabled)}
            onChange={(e) => void update({ enabled: e.target.checked })}
          />
          <span className="text-sm font-semibold text-on-surface">{s?.enabled ? "On" : "Off"}</span>
        </label>
      </div>

      {status.error && <p className="text-sm text-error">Failed to load automatic sync status.</p>}

      {s && !s.available && (
        <p className="text-sm text-on-surface-variant bg-surface-container-low rounded-lg px-3 py-2 max-w-prose">
          The browser container isn&apos;t set up for this Applaud. Add the{" "}
          <code>applaud-browser</code> service to your stack, as described in the{" "}
          <a
            className="font-semibold text-primary hover:underline"
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
          >
            setup guide
          </a>
          , then come back here to turn this on.
        </p>
      )}

      {s?.enabled && (
        <>
          <div className="space-y-3">
            <label className="flex items-start gap-3 cursor-pointer max-w-prose">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary cursor-pointer"
                checked={s.names}
                disabled={busy || !sendToPlaud}
                onChange={(e) => void update({ names: e.target.checked })}
              />
              <span className="text-xs text-on-surface-variant">
                <span className="block text-sm font-semibold text-on-surface">
                  Send confirmed speaker names
                </span>
                {sendToPlaud
                  ? "Recordings with names to send are sent a few minutes after you confirm them. Each send can be undone from the browser extension."
                  : "Turn on Speaker identification → Send names to Plaud first."}
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer max-w-prose">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary cursor-pointer"
                checked={s.cards}
                disabled={busy}
                onChange={(e) => void update({ cards: e.target.checked })}
              />
              <span className="text-xs text-on-surface-variant">
                <span className="block text-sm font-semibold text-on-surface">
                  Fetch summary cards
                </span>
                Saves each recording&apos;s summary card image next to its summary.
              </span>
            </label>
          </div>

          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-on-surface-variant">Browser</dt>
            <dd className="text-on-surface">
              {s.lastSeenAt ? (
                <>
                  {s.needsAttention === "not_seen" ? "not checking in" : "connected"} · last
                  check-in {formatRelative(s.lastSeenAt)}
                </>
              ) : (
                <>
                  waiting for the browser container ·{" "}
                  <a
                    className="font-semibold text-primary hover:underline"
                    href={DOCS_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    setup guide
                  </a>
                </>
              )}
            </dd>
            <dt className="text-on-surface-variant">Plaud</dt>
            <dd className="text-on-surface">
              {s.plaudSignedIn === false ? (
                <span className="text-error font-semibold">signed out</span>
              ) : s.plaudSignedIn ? (
                "signed in"
              ) : (
                "not checked yet"
              )}
              {" · "}
              <a
                className="font-semibold text-primary hover:underline"
                href={viewerAddress(s)}
                target="_blank"
                rel="noreferrer"
              >
                Open the browser{s.plaudSignedIn === false ? " to sign in" : ""}
              </a>
            </dd>
            <dt className="text-on-surface-variant">Last run</dt>
            <dd className="text-on-surface">
              {s.lastRunAt && s.last ? (
                <>
                  {formatRelative(s.lastRunAt)} · {s.last.sent} name send
                  {s.last.sent === 1 ? "" : "s"}
                  {s.last.conflicts ? `, ${s.last.conflicts} changed in Plaud` : ""}
                  {s.last.failed ? `, ${s.last.failed} failed` : ""} · {s.last.cards} card
                  {s.last.cards === 1 ? "" : "s"}
                  {s.last.error && (
                    <span className="block text-xs text-on-surface-variant">{s.last.error}</span>
                  )}
                </>
              ) : (
                "none yet"
              )}
            </dd>
            {(testing !== null || lastTest) && (
              <>
                <dt className="text-on-surface-variant">Last test</dt>
                <dd className="text-on-surface">
                  {testing !== null && !testStale ? (
                    "testing… waiting for the browser to check in"
                  ) : testing !== null ? (
                    <span className="text-error font-semibold">
                      no answer: check the applaud-browser container is running, then test again
                    </span>
                  ) : lastTest!.plaudSignedIn ? (
                    <>{formatRelative(lastTest!.at)} · passed: connected and signed in to Plaud</>
                  ) : (
                    <>
                      {formatRelative(lastTest!.at)} ·{" "}
                      <span className="text-error font-semibold">failed</span>:{" "}
                      {testResultText(lastTest!)}
                    </>
                  )}
                </dd>
              </>
            )}
          </dl>

          {s.paused && (
            <div className="flex flex-wrap items-center gap-4 text-sm bg-error/10 border border-error/30 rounded-lg px-3 py-2">
              <span className="text-error font-semibold">
                Paused: Plaud answered in a way Applaud doesn&apos;t recognise ({s.paused}). Nothing
                more is sent until you resume.
              </span>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg border border-error/30 text-error font-semibold hover:bg-error/10 disabled:opacity-50"
                disabled={busy}
                onClick={() =>
                  void act(api.resumePlaudAutomation, "Resumed. It runs within a minute.")
                }
              >
                Resume
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-4">
            <button
              type="button"
              className="px-4 py-2 rounded-lg border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/10 transition-colors disabled:opacity-50"
              disabled={busy || s.paused !== null}
              onClick={() => void act(api.runPlaudAutomation, "It runs within a minute.")}
            >
              Run now
            </button>
            <button
              type="button"
              className="px-4 py-2 rounded-lg border border-outline-variant text-on-surface text-sm font-semibold hover:bg-surface-container transition-colors disabled:opacity-50"
              disabled={busy || (testing !== null && !testStale)}
              title="Check the browser is connected and signed in to Plaud, after reopening, refreshing or reconfiguring it. Sends nothing."
              onClick={() => void startTest()}
            >
              {testing !== null && !testStale ? "Testing…" : "Test connection"}
            </button>
            <label className="space-y-1 flex-grow max-w-md">
              <span className="block font-label text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
                Browser address
              </span>
              <input
                type="url"
                className="w-full bg-surface-container-highest/50 border-0 rounded-lg p-3 text-sm text-on-surface focus:ring-2 focus:ring-primary/40 focus:outline-none"
                placeholder={defaultViewerAddress(s)}
                value={viewerUrl}
                onChange={(e) => setViewerUrl(e.target.value)}
                onBlur={() => {
                  if (viewerUrl.trim() !== s.viewerUrl)
                    void update({ viewerUrl: viewerUrl.trim() });
                }}
              />
            </label>
          </div>
        </>
      )}
    </section>
  );
}

/** Dashboard banner while automatic sync needs the user: signed out, not checking in, or paused. */
export function PlaudAutomationBanner(): JSX.Element | null {
  const status = useQuery({
    queryKey: AUTOMATION_QUERY_KEY,
    queryFn: api.plaudAutomationStatus,
    refetchInterval: 60_000,
  });
  const s = status.data;
  if (!s?.enabled || !s.needsAttention) return null;
  const text =
    s.needsAttention === "signed_out"
      ? "The Applaud browser is signed out of Plaud, so names and summary cards aren't being synced."
      : s.needsAttention === "paused"
        ? "Automatic Plaud sync is paused because Plaud answered in a way Applaud doesn't recognise."
        : "The Applaud browser hasn't checked in for over 30 minutes. Check the applaud-browser container is running.";
  return (
    <p className="mb-6 text-sm font-semibold text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">
      {text}{" "}
      {s.needsAttention === "signed_out" ? (
        <a className="underline" href={viewerAddress(s)} target="_blank" rel="noreferrer">
          Open the browser to sign in
        </a>
      ) : (
        <Link className="underline" to="/settings#automatic-plaud-sync">
          Automatic Plaud sync settings
        </Link>
      )}
    </p>
  );
}
