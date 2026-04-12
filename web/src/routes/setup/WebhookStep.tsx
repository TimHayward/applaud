import { useState } from "react";
import { api } from "../../api.js";

export function WebhookStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}): JSX.Element {
  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | {
    ok: boolean;
    statusCode?: number;
    bodySnippet?: string;
    error?: string;
  }>(null);

  const test = async (): Promise<void> => {
    if (!url) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testWebhook(url);
      setTestResult(r);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const saveAndContinue = async (): Promise<void> => {
    if (url.trim() === "") {
      await api.updateConfig({ webhook: null });
    } else {
      await api.updateConfig({ webhook: { url: url.trim(), enabled: true } });
    }
    onNext();
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <span className="font-label text-primary text-xs font-bold tracking-widest uppercase">Step 4</span>
        <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Webhook Configuration</h1>
        <p className="text-on-surface-variant text-base max-w-md leading-relaxed">
          Provide a URL to receive updates when transcription is complete. We'll send a POST request with the payload.
        </p>
      </div>

      <div className="space-y-4">
        <label className="font-label text-xs text-on-surface-variant uppercase tracking-wider block">Target Endpoint URL</label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary/60">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <input
            className="w-full bg-surface-container-highest/50 border-0 rounded-lg py-4 pl-12 pr-4 text-on-surface placeholder:text-on-surface-variant/30 focus:ring-2 focus:ring-primary/40 focus:outline-none font-label tracking-wide"
            type="url"
            placeholder="https://api.yourdomain.com/webhooks/applaud"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setTestResult(null); }}
          />
        </div>

        {/* Info box */}
        <div className="bg-surface-container-highest/30 p-4 rounded-lg flex items-start gap-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-secondary mt-0.5 flex-shrink-0">
            <circle cx="12" cy="12" r="10" opacity="0.2" /><circle cx="12" cy="12" r="4" />
          </svg>
          <div className="space-y-1">
            <p className="text-xs font-medium text-on-surface">Test payload will be sent upon completion.</p>
            <p className="text-[11px] text-on-surface-variant leading-relaxed">Ensure your server is configured to return a 200 OK status to acknowledge receipt.</p>
          </div>
        </div>
      </div>

      {url && (
        <button className="btn-primary px-6 py-3" onClick={() => void test()} disabled={testing}>
          {testing ? "Testing…" : "Test Connection"}
        </button>
      )}

      {testResult && (
        <div className={`rounded-lg p-4 flex items-center gap-3 ${
          testResult.ok ? "bg-secondary/10 border border-secondary/20" : "bg-error/10 border border-error/20"
        }`}>
          {testResult.ok ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-secondary flex-shrink-0"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-error flex-shrink-0"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
          )}
          <div>
            <p className={`font-bold text-sm ${testResult.ok ? "text-secondary" : "text-error"}`}>
              {testResult.ok ? "Connection Success" : "Connection Failed"}
            </p>
            <p className={`text-xs ${testResult.ok ? "text-secondary/70" : "text-error/70"}`}>
              {testResult.ok
                ? `HTTP ${testResult.statusCode ?? "?"} OK${testResult.bodySnippet ? ` — ${testResult.bodySnippet.slice(0, 100)}` : ""}`
                : testResult.statusCode ? `HTTP ${testResult.statusCode}` : testResult.error}
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-4">
        <button className="flex items-center gap-2 text-on-surface-variant font-semibold text-sm hover:text-on-surface transition-colors group" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:-translate-x-1 transition-transform"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          Back
        </button>
        <button className="btn-primary px-8 py-3 flex items-center gap-3 shadow-lg shadow-primary/10" onClick={() => void saveAndContinue()}>
          {url ? "Next" : "Skip"}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>
        </button>
      </div>
    </div>
  );
}
