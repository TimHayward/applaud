import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

export function Settings(): JSX.Element {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["config"], queryFn: api.config });
  const syncStatus = useQuery({
    queryKey: ["sync-status"],
    queryFn: api.syncStatus,
    refetchInterval: 5000,
  });

  const [webhookUrl, setWebhookUrl] = useState("");
  const [pollMinutes, setPollMinutes] = useState(10);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: boolean; message: string }>(null);

  useEffect(() => {
    if (!cfg.data) return;
    const c = cfg.data.config;
    setWebhookUrl(c.webhook?.url ?? "");
    setPollMinutes(c.pollIntervalMinutes);
    setDirty(false);
  }, [cfg.data]);

  if (cfg.isLoading) return <p className="text-ink-500">loading…</p>;
  const c = cfg.data?.config;
  if (!c) return <p>failed to load</p>;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.updateConfig({
        webhook: webhookUrl.trim()
          ? { url: webhookUrl.trim(), enabled: true }
          : null,
        pollIntervalMinutes: pollMinutes,
      });
      await qc.invalidateQueries({ queryKey: ["config"] });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    setTestResult(null);
    try {
      const r = await api.testWebhook(webhookUrl.trim());
      const snippet = r.bodySnippet?.slice(0, 400).trim();
      let message: string;
      if (r.error) {
        message = snippet ? `${r.error} — ${snippet}` : r.error;
      } else {
        message = `HTTP ${r.statusCode ?? "?"}`;
        if (snippet) message += ` — ${snippet}`;
      }
      setTestResult({ ok: r.ok, message });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Settings</h1>
      </div>

      <section className="card p-6">
        <h2 className="font-semibold text-ink-900">Sync status</h2>
        <dl className="mt-4 grid grid-cols-2 gap-y-3 text-sm">
          <dt className="text-ink-500">Last poll</dt>
          <dd className="text-ink-900">
            {syncStatus.data?.lastPollAt
              ? new Date(syncStatus.data.lastPollAt).toLocaleString()
              : "never"}
          </dd>
          <dt className="text-ink-500">Pending transcripts</dt>
          <dd className="text-ink-900">{syncStatus.data?.pendingTranscripts ?? 0}</dd>
          <dt className="text-ink-500">Errors (24h)</dt>
          <dd className="text-ink-900">{syncStatus.data?.errorsLast24h ?? 0}</dd>
          {syncStatus.data?.lastError && (
            <>
              <dt className="text-ink-500">Last error</dt>
              <dd className="text-red-700">{syncStatus.data.lastError}</dd>
            </>
          )}
          {syncStatus.data?.authRequired && (
            <>
              <dt className="text-ink-500">Auth</dt>
              <dd className="text-red-700">Token expired or revoked — re-authenticate</dd>
            </>
          )}
        </dl>
      </section>

      <section className="card p-6">
        <h2 className="font-semibold text-ink-900">Account</h2>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-500">Signed in as</dt>
            <dd className="text-ink-900">{c.tokenEmail ?? "unknown"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Token expires</dt>
            <dd className="text-ink-900">
              {c.tokenExp ? new Date(c.tokenExp * 1000).toLocaleDateString() : "—"}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Recordings folder</dt>
            <dd className="font-mono text-xs text-ink-900">{c.recordingsDir}</dd>
          </div>
        </dl>
      </section>

      <section className="card p-6">
        <h2 className="font-semibold text-ink-900">Webhook</h2>
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-ink-700">URL</label>
          <div className="flex gap-2">
            <input
              className="input"
              type="url"
              placeholder="https://n8n.example.com/webhook/plaud"
              value={webhookUrl}
              onChange={(e) => {
                setWebhookUrl(e.target.value);
                setDirty(true);
                setTestResult(null);
              }}
            />
            <button className="btn-secondary" onClick={() => void test()} disabled={!webhookUrl}>
              Test
            </button>
          </div>
          {testResult && (
            <div
              className={`rounded-md p-2 text-xs ${
                testResult.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"
              }`}
            >
              {testResult.message}
            </div>
          )}
        </div>
      </section>

      <section className="card p-6">
        <h2 className="font-semibold text-ink-900">Poll interval</h2>
        <div className="mt-4 flex items-center gap-4">
          <input
            type="range"
            min={1}
            max={60}
            value={pollMinutes}
            onChange={(e) => {
              setPollMinutes(Number(e.target.value));
              setDirty(true);
            }}
            className="flex-1"
          />
          <span className="w-20 text-right font-mono text-sm">
            {pollMinutes} min
          </span>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          className="btn-primary"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
