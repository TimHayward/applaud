import { useEffect, useRef, useState } from "react";
import { api } from "../../api.js";

type SignInState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; redirectUri: string }
  | { kind: "connected"; email: string | null }
  | { kind: "error"; message: string };

/** How often to check whether the sign-in tab has finished. */
const STATUS_POLL_MS = 2000;
/** Give up waiting after this long (Plaud's own sign-in state lasts 30 minutes). */
const WAIT_LIMIT_MS = 15 * 60 * 1000;

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not a JSON error body.
  }
  return raw;
}

/**
 * Plaud sign-in through Plaud's own OAuth page. Applaud never sees the Plaud
 * password: the browser signs in on Plaud's site and is sent back to Applaud,
 * which receives a renewable session. `variant="reconnect"` reuses it from
 * Settings after setup (no wizard step label; `onBack` acts as Cancel).
 */
export function AuthStep({
  onNext,
  onBack,
  variant = "setup",
}: {
  onNext: () => void;
  onBack: () => void;
  variant?: "setup" | "reconnect";
}): JSX.Element {
  const reconnect = variant === "reconnect";
  const [state, setState] = useState<SignInState>({ kind: "idle" });
  const [pasted, setPasted] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = (): void => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => stopPolling, []);

  // The session in place when this step opened; a sign-in has finished once a
  // different one shows up (a reconnect starts from an existing session).
  // `undefined` until the first status check returns.
  const initialConnectedAt = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    api
      .authStatus()
      .then((s) => {
        initialConnectedAt.current = s.connected ? s.connectedAt : null;
        // On first setup, show an existing connection rather than asking again.
        if (!reconnect && s.connected) setState({ kind: "connected", email: s.email });
      })
      .catch(() => undefined);
  }, [reconnect]);

  const finish = (email: string | null): void => {
    stopPolling();
    setState({ kind: "connected", email });
    if (reconnect) onNext();
  };

  const signIn = async (): Promise<void> => {
    // Open the tab synchronously, inside the click, so popup blockers allow it;
    // it is pointed at Plaud once the authorisation URL is known.
    const tab = window.open("about:blank", "_blank");
    setState({ kind: "starting" });
    try {
      const { authorizeUrl, redirectUri } = await api.authStart();
      if (tab) {
        // Don't hand Plaud's page a handle back to Applaud.
        tab.opener = null;
        tab.location.href = authorizeUrl;
      }
      else window.location.assign(authorizeUrl);
      setState({ kind: "waiting", redirectUri });
      const startedAt = Date.now();
      stopPolling();
      pollRef.current = setInterval(() => {
        if (Date.now() - startedAt > WAIT_LIMIT_MS) {
          stopPolling();
          setState({ kind: "error", message: "Timed out waiting for Plaud sign-in. Start again." });
          return;
        }
        api
          .authStatus()
          .then((s) => {
            const baseline = initialConnectedAt.current;
            if (baseline !== undefined && s.connected && s.connectedAt !== baseline) finish(s.email);
          })
          .catch(() => undefined);
      }, STATUS_POLL_MS);
    } catch (err) {
      tab?.close();
      setState({ kind: "error", message: errorText(err) });
    }
  };

  const submitPasted = async (): Promise<void> => {
    setPasteBusy(true);
    try {
      const r = await api.authComplete(pasted.trim());
      if (r.ok) finish(r.email ?? null);
      else setState({ kind: "error", message: r.error ?? "Sign-in could not be completed." });
    } catch (err) {
      setState({ kind: "error", message: errorText(err) });
    } finally {
      setPasteBusy(false);
    }
  };

  return (
    <div className={reconnect ? "space-y-4" : "space-y-8"}>
      {reconnect ? (
        <p className="text-sm text-on-surface-variant max-w-prose">
          Sign in again with the same Plaud account. Applaud keeps your library and resumes syncing as soon as the new
          session is accepted.
        </p>
      ) : (
        <div className="space-y-2">
          <span className="font-label text-primary text-xs font-bold tracking-widest uppercase">Step 2</span>
          <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Connect Your Plaud Account</h1>
          <p className="text-on-surface-variant text-base max-w-md leading-relaxed">
            You sign in on Plaud&apos;s own page and approve access. Applaud never sees your Plaud password.
          </p>
        </div>
      )}

      <div className="rounded-xl bg-surface-container-low p-6 space-y-4">
        {state.kind === "connected" ? (
          <p className="text-sm text-on-surface">
            ✓ Connected to Plaud{state.email && <> as <span className="font-medium">{state.email}</span></>}.
          </p>
        ) : (
          <>
            <button
              className="btn-primary"
              onClick={() => void signIn()}
              disabled={state.kind === "starting"}
            >
              {state.kind === "waiting" ? "Open Plaud sign-in again" : "Sign in with Plaud"}
            </button>
            {state.kind === "starting" && <p className="text-sm text-on-surface-variant">Contacting Plaud…</p>}
            {state.kind === "waiting" && (
              <div className="space-y-3">
                <p className="text-sm text-on-surface-variant">
                  Finish signing in on the Plaud tab. This page continues on its own once Plaud sends you back.
                </p>
                <details className="rounded-xl bg-surface-container p-4 text-sm">
                  <summary className="cursor-pointer font-medium text-on-surface">
                    The Plaud tab ended on a page that would not load?
                  </summary>
                  <div className="mt-3 space-y-3">
                    <p className="text-xs text-on-surface-variant">
                      Plaud sends you back to <code className="break-all">{state.redirectUri}</code>. If this browser
                      can&apos;t reach that address, copy the full address from that tab&apos;s address bar and paste it
                      here.
                    </p>
                    <input
                      className="w-full bg-surface-container-highest/50 border-0 rounded-lg p-3 font-mono text-xs text-on-surface focus:ring-2 focus:ring-primary/40 focus:outline-none"
                      placeholder={`${state.redirectUri}?code=…&state=…`}
                      value={pasted}
                      onChange={(e) => setPasted(e.target.value)}
                    />
                    <button
                      className="btn-secondary"
                      onClick={() => void submitPasted()}
                      disabled={pasteBusy || !pasted.includes("code=")}
                    >
                      {pasteBusy ? "Connecting…" : "Finish sign-in"}
                    </button>
                  </div>
                </details>
              </div>
            )}
            {state.kind === "error" && <p className="text-sm text-error">{state.message}</p>}
          </>
        )}
      </div>

      <div className={`flex justify-between ${reconnect ? "" : "pt-4"}`}>
        {reconnect ? (
          <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onBack}>
            Cancel
          </button>
        ) : (
          <>
            <button className="flex items-center gap-2 text-on-surface-variant font-semibold text-sm hover:text-on-surface transition-colors group" onClick={onBack}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:-translate-x-1 transition-transform"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
              Back
            </button>
            <button className="btn-primary px-6" onClick={onNext} disabled={state.kind !== "connected"}>
              Continue
            </button>
          </>
        )}
      </div>
    </div>
  );
}
