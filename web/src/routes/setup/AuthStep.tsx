import { useEffect, useState } from "react";
import { api } from "../../api.js";

type DetectState =
  | { kind: "idle" }
  | { kind: "detecting" }
  | { kind: "found"; email?: string; browser?: string; profile?: string; token: string }
  | { kind: "notfound" }
  | { kind: "error"; message: string };

type WatchState =
  | { kind: "inactive" }
  | { kind: "waiting"; elapsedSec: number }
  | { kind: "error"; message: string };

type ManualState =
  | { kind: "idle" }
  | { kind: "validating" }
  | { kind: "error"; message: string };

export function AuthStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}): JSX.Element {
  const [detect, setDetect] = useState<DetectState>({ kind: "idle" });
  const [watch, setWatch] = useState<WatchState>({ kind: "inactive" });
  const [manual, setManual] = useState<ManualState>({ kind: "idle" });
  const [manualText, setManualText] = useState("");
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    setDetect({ kind: "detecting" });
    api
      .authDetect()
      .then((r) => {
        if (r.found && r.token) {
          setDetect({ kind: "found", email: r.email, browser: r.browser, profile: r.profile, token: r.token });
        } else if (r.error) {
          setDetect({ kind: "error", message: r.error });
        } else {
          setDetect({ kind: "notfound" });
        }
      })
      .catch((err: Error) => setDetect({ kind: "error", message: err.message }));
  }, []);

  const accept = async (token: string, email?: string): Promise<void> => {
    try {
      const r = await api.authAccept(token, email);
      if (r.ok) { setAccepted(true); onNext(); }
      else { setDetect({ kind: "error", message: r.error ?? "token validation failed" }); }
    } catch (err) {
      setDetect({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const startWatch = async (): Promise<void> => {
    try {
      const { watchId } = await api.authStartWatch();
      setWatch({ kind: "waiting", elapsedSec: 0 });
      const es = new EventSource(`/api/auth/watch/${watchId}/events`);
      const start = Date.now();
      const tick = setInterval(() => {
        setWatch({ kind: "waiting", elapsedSec: Math.floor((Date.now() - start) / 1000) });
      }, 1000);
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "found") { clearInterval(tick); es.close(); setAccepted(true); onNext(); }
          else if (data.type === "timeout") { clearInterval(tick); es.close(); setWatch({ kind: "error", message: "timed out waiting for login (5 min)" }); }
          else if (data.type === "error") { clearInterval(tick); es.close(); setWatch({ kind: "error", message: data.message }); }
        } catch { /* ignore */ }
      };
      es.onerror = () => { clearInterval(tick); es.close(); setWatch({ kind: "error", message: "connection lost" }); };
    } catch (err) {
      setWatch({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const submitManual = async (): Promise<void> => {
    setManual({ kind: "validating" });
    try {
      const r = await api.authAccept(manualText);
      if (r.ok) { setAccepted(true); onNext(); }
      else { setManual({ kind: "error", message: r.error ?? "validation failed" }); }
    } catch (err) {
      setManual({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <span className="font-label text-primary text-xs font-bold tracking-widest uppercase">Step 2</span>
        <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Connect Your Plaud Account</h1>
        <p className="text-on-surface-variant text-base max-w-md leading-relaxed">
          Applaud authenticates by reading your existing Plaud session from Chrome.
        </p>
      </div>

      <div className="rounded-xl bg-surface-container-low p-6 space-y-4">
        {detect.kind === "detecting" && (
          <p className="text-sm text-on-surface-variant">Scanning browsers on this machine…</p>
        )}
        {detect.kind === "found" && (
          <div>
            <p className="text-sm text-on-surface">
              ✓ Found a Plaud session in{" "}
              <span className="font-medium">{detect.browser} / {detect.profile}</span>
              {detect.email && <>{" "}for <span className="font-medium">{detect.email}</span></>}
            </p>
            <div className="mt-4 flex gap-2">
              <button className="btn-primary" onClick={() => void accept(detect.token, detect.email)} disabled={accepted}>
                Use this session
              </button>
              <button className="btn-secondary" onClick={() => setDetect({ kind: "notfound" })}>
                Use a different account
              </button>
            </div>
          </div>
        )}
        {detect.kind === "notfound" && (
          <div className="space-y-4">
            <p className="text-sm text-on-surface-variant">
              No existing Plaud session found. Open the Plaud web app in your browser, log in, and we'll pick up the session automatically.
            </p>
            {watch.kind === "inactive" && (
              <button className="btn-primary" onClick={() => void startWatch()}>
                Open web.plaud.ai and watch for login
              </button>
            )}
            {watch.kind === "waiting" && (
              <p className="text-sm text-on-surface-variant">Waiting for you to log in… ({watch.elapsedSec}s)</p>
            )}
            {watch.kind === "error" && <p className="text-sm text-error">{watch.message}</p>}
            <details className="rounded-xl bg-surface-container p-4 text-sm">
              <summary className="cursor-pointer font-medium text-on-surface">Paste a token manually</summary>
              <div className="mt-4 space-y-3">
                <p className="text-xs text-on-surface-variant">
                  Open web.plaud.ai DevTools → Application → Local Storage → paste the value of <code>tokenstr</code> (starts with <code>bearer eyJ…</code>) or the raw JWT.
                </p>
                <label className="font-label text-xs text-on-surface-variant uppercase tracking-wider block">Token</label>
                <textarea
                  className="w-full bg-surface-container-highest/50 border-0 rounded-lg p-4 font-mono text-xs text-on-surface h-24 focus:ring-2 focus:ring-primary/40 focus:outline-none"
                  placeholder="bearer eyJhbGciOiJIUzI1NiIs..."
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                />
                <div className="flex items-center gap-2">
                  <button className="btn-primary" onClick={() => void submitManual()} disabled={manual.kind === "validating" || manualText.length < 20}>
                    {manual.kind === "validating" ? "Validating…" : "Use this token"}
                  </button>
                  {manual.kind === "error" && <span className="text-sm text-error">{manual.message}</span>}
                </div>
              </div>
            </details>
          </div>
        )}
        {detect.kind === "error" && (
          <div>
            <p className="text-sm text-error">Detect failed: {detect.message}</p>
            <button className="btn-secondary mt-2" onClick={() => setDetect({ kind: "notfound" })}>Try another method</button>
          </div>
        )}
      </div>

      <div className="flex justify-between pt-4">
        <button className="flex items-center gap-2 text-on-surface-variant font-semibold text-sm hover:text-on-surface transition-colors group" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:-translate-x-1 transition-transform"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          Back
        </button>
      </div>
    </div>
  );
}
