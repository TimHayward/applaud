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
    <div>
      <h2 className="text-2xl font-semibold text-ink-900">Webhook (optional)</h2>
      <p className="mt-2 text-ink-600">
        We'll POST to this URL whenever a new recording or transcript is downloaded. Leave
        blank to skip.
      </p>
      <div className="mt-6 space-y-3">
        <label className="block text-sm font-medium text-ink-700">Webhook URL</label>
        <div className="flex gap-2">
          <input
            className="input"
            type="url"
            placeholder="https://n8n.example.com/webhook/plaud"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setTestResult(null);
            }}
          />
          <button
            className="btn-secondary"
            onClick={() => void test()}
            disabled={testing || !url}
          >
            {testing ? "Testing…" : "Test"}
          </button>
        </div>
        <p className="text-xs text-ink-500">
          We'll POST a small <code>{`{"event": "applaud.test"}`}</code> payload to
          verify reachability.
        </p>
      </div>
      {testResult && (
        <div
          className={`mt-4 rounded-md p-3 text-sm ${
            testResult.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"
          }`}
        >
          {testResult.ok ? (
            <>
              <div>✓ HTTP {testResult.statusCode}</div>
              {testResult.bodySnippet && (
                <pre className="mt-1 overflow-x-auto text-xs">
                  {testResult.bodySnippet}
                </pre>
              )}
            </>
          ) : (
            <>
              <div>
                ✗{" "}
                {testResult.statusCode
                  ? `HTTP ${testResult.statusCode}`
                  : testResult.error}
              </div>
              {testResult.bodySnippet && (
                <pre className="mt-1 overflow-x-auto text-xs">
                  {testResult.bodySnippet}
                </pre>
              )}
            </>
          )}
        </div>
      )}
      <div className="mt-8 flex justify-between">
        <button className="btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <button className="btn-primary" onClick={() => void saveAndContinue()}>
          {url ? "Next →" : "Skip →"}
        </button>
      </div>
    </div>
  );
}
