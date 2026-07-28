import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setLanToken as persistLanToken } from "../api.js";
import { useToast } from "../components/Toast.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { ResultCard } from "../components/ResultCard.js";
import { WebhookDeliveries } from "../components/WebhookDeliveries.js";
import { formatRelative, daysUntil } from "../lib/format.js";

export function Settings(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const cfg = useQuery({ queryKey: ["config"], queryFn: api.config });
  // No refetchInterval here: the always-mounted SyncStatusBadge polls this
  // same query key (10s + SSE invalidation), so Settings just observes the
  // shared cache instead of adding a second, faster poll loop.
  const syncStatus = useQuery({
    queryKey: ["sync-status"],
    queryFn: api.syncStatus,
  });

  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [secretExists, setSecretExists] = useState(false);
  const [secretTouched, setSecretTouched] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [pollMinutes, setPollMinutes] = useState(10);
  const [importPlaudDeleted, setImportPlaudDeleted] = useState(false);
  const [lanTokenInput, setLanTokenInput] = useState("");
  const [lanTokenExists, setLanTokenExists] = useState(false);
  const [lanTokenTouched, setLanTokenTouched] = useState(false);
  const [showLanToken, setShowLanToken] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: boolean; message: string }>(null);
  const [clearIgnoreBusy, setClearIgnoreBusy] = useState(false);
  const [clearIgnoreMsg, setClearIgnoreMsg] = useState<null | { ok: boolean; text: string }>(null);

  // Sync the form from the server config — but never on top of unsaved edits.
  // The `["config"]` query is kept alive by the always-mounted sync badge and
  // is invalidated by several mutations, so a background refetch lands at
  // arbitrary times; without the `dirty` guard it silently wipes whatever the
  // user is typing. Saving clears `dirty`, which re-runs this and picks up the
  // freshly persisted values.
  useEffect(() => {
    if (!cfg.data || dirty) return;
    const c = cfg.data.config;
    setWebhookUrl(c.webhook?.url ?? "");
    setSecretExists(Boolean(c.webhook?.secret));
    setWebhookSecret("");
    setSecretTouched(false);
    setShowSecret(false);
    setPollMinutes(c.pollIntervalMinutes);
    setImportPlaudDeleted(c.importPlaudDeleted ?? false);
    setLanTokenExists(Boolean(c.lanToken));
    setLanTokenInput("");
    setLanTokenTouched(false);
    setShowLanToken(false);
  }, [cfg.data, dirty]);

  if (cfg.isLoading) return <p className="text-on-surface-variant">loading…</p>;
  const c = cfg.data?.config;
  if (!c) return <p>failed to load</p>;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const url = webhookUrl.trim();
      const webhook = url
        ? {
            url,
            enabled: true,
            // Sent value: new secret if user typed one, sentinel to preserve existing, empty to clear.
            secret: webhookSecret.length > 0 ? webhookSecret : secretExists ? "***REDACTED***" : "",
          }
        : null;
      await api.updateConfig({
        webhook,
        pollIntervalMinutes: pollMinutes,
        importPlaudDeleted,
        ...(lanTokenTouched ? { lanToken: lanTokenInput } : {}),
      });
      if (lanTokenTouched) {
        // Keep this browser working immediately — once set, the server
        // requires the token on every request, including the next reload.
        persistLanToken(lanTokenInput.length > 0 ? lanTokenInput : null);
      }
      await qc.invalidateQueries({ queryKey: ["config"] });
      await qc.invalidateQueries({ queryKey: ["recordings"] });
      await qc.invalidateQueries({ queryKey: ["sync-status"] });
      setDirty(false);
      toast.success("Settings saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const generateSecret = (): void => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    setWebhookSecret(hex);
    setShowSecret(true);
    setSecretTouched(true);
    setDirty(true);
  };

  const clearSecret = (): void => {
    setWebhookSecret("");
    setSecretExists(false);
    setSecretTouched(true);
    setDirty(true);
  };

  const generateLanToken = (): void => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    setLanTokenInput(hex);
    setShowLanToken(true);
    setLanTokenTouched(true);
    setDirty(true);
  };

  const clearLanToken = (): void => {
    setLanTokenInput("");
    setLanTokenExists(false);
    setLanTokenTouched(true);
    setDirty(true);
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

  const s = syncStatus.data;
  const isHealthy = s && !s.authRequired && !s.lastError;

  return (
    <div className="max-w-[48rem] mx-auto space-y-8">
      {/* Page Header */}
      <div className="space-y-2 mb-12">
        <h1 className="text-5xl font-extrabold tracking-tighter text-on-surface">Configuration</h1>
        <p className="text-on-surface-variant">Manage your local ingestion engine and cloud synchronization.</p>
      </div>

      {/* Sync Status */}
      <section className="bg-surface-container-low rounded-xl p-8 transition-all hover:bg-surface-container">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div className="space-y-3">
            {/* Icon + label, not just a colored dot: the shape carries the
                state for anyone who can't distinguish the green/red fill. */}
            <div className="flex items-center gap-2">
              {isHealthy ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-secondary shrink-0" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="8 12.5 11 15.5 16 9" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-error shrink-0" aria-hidden="true">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              )}
              <span className={`font-label text-xs font-bold tracking-widest uppercase ${isHealthy ? "text-secondary" : "text-error"}`}>
                {isHealthy ? "All systems operational" : s?.authRequired ? "Auth required" : "Error detected"}
              </span>
            </div>
            <div>
              <h2 className="text-3xl font-bold tracking-tight text-on-surface">Sync Status</h2>
              <p className="text-on-surface-variant text-sm mt-1">Real-time health of your local applaud instance.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 w-full md:w-auto">
            <div className="bg-surface-container-highest/50 border border-outline-variant/20 p-4 rounded-lg">
              <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">Last poll</p>
              <p className="font-bold text-lg text-on-surface">{formatRelative(s?.lastPollAt ?? null)}</p>
            </div>
            <div className="bg-surface-container-highest/50 border border-outline-variant/20 p-4 rounded-lg">
              <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">Pending</p>
              <p className="font-bold text-lg text-tertiary">
                {s?.pendingTranscripts ?? 0} transcript{(s?.pendingTranscripts ?? 0) !== 1 ? "s" : ""}
                {(s?.pendingSummaries ?? 0) > 0 ? (
                  <span className="block text-sm font-semibold mt-1 text-on-surface-variant">
                    {s?.pendingSummaries} summary pending
                  </span>
                ) : null}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Sync maintenance */}
      <section className="card p-8 space-y-4">
        <h2 className="text-xl font-bold text-on-surface">Sync maintenance</h2>
        <p className="text-sm text-on-surface-variant max-w-prose">
          After a recording spends 7 days in Trash, Applaud deletes its local files and adds the Plaud id to an internal
          blocklist so it is not downloaded again. If you need to pull those recordings from Plaud again, clear the
          blocklist here. This does not delete any files currently in your library.
        </p>
        {clearIgnoreMsg && (
          <p className={`text-sm ${clearIgnoreMsg.ok ? "text-secondary" : "text-error"}`}>{clearIgnoreMsg.text}</p>
        )}
        <button
          type="button"
          className="px-4 py-2 rounded-lg border border-error/30 text-error text-sm font-semibold hover:bg-error/10 transition-colors"
          disabled={clearIgnoreBusy}
          onClick={() => {
            void (async () => {
              const ok = await confirm({
                title: "Clear the purged-recording blocklist?",
                message: "Previously purged Plaud ids may be downloaded again on the next sync.",
                confirmLabel: "Clear blocklist",
                destructive: true,
              });
              if (!ok) return;
              setClearIgnoreBusy(true);
              setClearIgnoreMsg(null);
              try {
                const r = await api.clearSyncIgnore();
                setClearIgnoreMsg({ ok: true, text: `Cleared ${r.cleared} blocked id(s).` });
                await qc.invalidateQueries({ queryKey: ["sync-blocklist"] });
              } catch (err) {
                setClearIgnoreMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
              } finally {
                setClearIgnoreBusy(false);
              }
            })();
          }}
        >
          {clearIgnoreBusy ? "Clearing…" : "Clear purged recording blocklist"}
        </button>
      </section>

      {/* Account Details */}
      <section className="card p-8 space-y-6">
        <div className="flex items-center gap-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          <h2 className="text-xl font-bold text-on-surface">Account Details</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="font-label text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Email Address</label>
            <div className="bg-surface-container-low rounded-lg p-4 text-on-surface text-sm">
              {c.tokenEmail ?? "unknown"}
            </div>
          </div>
          <div className="space-y-2">
            <label className="font-label text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Token Expiration</label>
            <div className="bg-surface-container-highest/50 border border-outline-variant/20 rounded-lg p-4 flex items-center justify-between">
              <span className="text-sm text-on-surface">
                {c.tokenExp ? `Expires in ${daysUntil(c.tokenExp)} days` : "—"}
              </span>
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <label className="font-label text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Local Storage Path</label>
          <div className="relative">
            <div className="bg-surface-container-low rounded-lg p-4 font-mono text-sm text-primary pr-12">
              {c.recordingsDir ?? "(not set)"}
            </div>
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
          </div>
        </div>
      </section>

      {/* LAN access token */}
      <section className="card p-8 space-y-6">
        <div className="flex items-center gap-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <h2 className="text-xl font-bold text-on-surface">LAN Access</h2>
        </div>
        <p className="text-sm text-on-surface-variant max-w-prose">
          By default Applaud only listens on this machine. If you access it from other devices on your network (or run it
          in Docker, which listens on all interfaces), set a token here to require it on every request. Leave blank to
          keep the current setup unauthenticated.
        </p>
        <div className="space-y-2">
          <label className="font-label text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
            Access token (optional)
          </label>
          <div className="flex gap-3">
            <input
              className="input py-3 border-transparent font-mono"
              type={showLanToken ? "text" : "password"}
              placeholder={lanTokenExists ? "Leave empty to keep current token" : "Paste a token or click Generate"}
              value={lanTokenInput}
              onChange={(e) => {
                setLanTokenInput(e.target.value);
                setLanTokenTouched(true);
                setDirty(true);
              }}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="px-4 py-3 rounded-lg border border-outline-variant/30 text-on-surface text-sm font-semibold hover:bg-surface-container-highest transition-colors"
              onClick={() => setShowLanToken((v) => !v)}
              disabled={!lanTokenInput}
            >
              {showLanToken ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              className="px-4 py-3 rounded-lg border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/10 transition-colors"
              onClick={generateLanToken}
            >
              Generate
            </button>
            {lanTokenExists && lanTokenInput.length === 0 && (
              <button
                type="button"
                className="px-4 py-3 rounded-lg border border-error/30 text-error text-sm font-semibold hover:bg-error/10 transition-colors"
                onClick={clearLanToken}
              >
                Clear
              </button>
            )}
          </div>
          {lanTokenTouched && lanTokenInput.length > 0 && (
            <p className="text-xs font-semibold text-tertiary bg-tertiary/10 border border-tertiary/30 rounded-lg px-3 py-2">
              Click <strong>Save Settings</strong> to apply. Then share{" "}
              <span className="font-mono break-all">{`${window.location.origin}/?token=${lanTokenInput}`}</span> with
              other devices — opening that link saves the token in their browser automatically.
            </p>
          )}
          {lanTokenTouched && lanTokenInput.length === 0 && (
            <p className="text-xs font-semibold text-tertiary bg-tertiary/10 border border-tertiary/30 rounded-lg px-3 py-2">
              Click <strong>Save Settings</strong> to apply — this will remove the access requirement.
            </p>
          )}
        </div>
      </section>

      {/* Webhook Outbound */}
      <section className="card p-8 space-y-6">
        <div className="flex items-center gap-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <h2 className="text-xl font-bold text-on-surface">Webhook Outbound</h2>
        </div>
        <div className="space-y-4">
          <div className="flex gap-3">
            <input
              className="input py-3 border-transparent"
              type="url"
              placeholder="https://api.yourdomain.com/v1/ingest"
              value={webhookUrl}
              onChange={(e) => {
                setWebhookUrl(e.target.value);
                setDirty(true);
                setTestResult(null);
              }}
            />
            <button
              className="btn-primary px-6 py-3"
              onClick={() => void test()}
              disabled={!webhookUrl}
            >
              Test
            </button>
          </div>
          <div className="space-y-2">
            <label className="font-label text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
              Signing secret (optional)
            </label>
            <div className="flex gap-3">
              <input
                className="input py-3 border-transparent font-mono"
                type={showSecret ? "text" : "password"}
                placeholder={
                  secretExists
                    ? "Leave empty to keep current secret"
                    : "Paste a secret or click Generate"
                }
                value={webhookSecret}
                onChange={(e) => {
                  setWebhookSecret(e.target.value);
                  setSecretTouched(true);
                  setDirty(true);
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="px-4 py-3 rounded-lg border border-outline-variant/30 text-on-surface text-sm font-semibold hover:bg-surface-container-highest transition-colors"
                onClick={() => setShowSecret((v) => !v)}
                disabled={!webhookSecret}
              >
                {showSecret ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                className="px-4 py-3 rounded-lg border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/10 transition-colors"
                onClick={generateSecret}
              >
                Generate
              </button>
              {secretExists && webhookSecret.length === 0 && (
                <button
                  type="button"
                  className="px-4 py-3 rounded-lg border border-error/30 text-error text-sm font-semibold hover:bg-error/10 transition-colors"
                  onClick={clearSecret}
                >
                  Clear
                </button>
              )}
            </div>
            {secretTouched && (
              <p className="text-xs font-semibold text-tertiary bg-tertiary/10 border border-tertiary/30 rounded-lg px-3 py-2">
                Click <strong>Save Settings</strong> at the bottom of the page before using <strong>Test</strong> — the new secret is not active until saved.
              </p>
            )}
            <p className="text-xs text-on-surface-variant">
              When set, outgoing webhooks include <span className="font-mono">X-Applaud-Signature: sha256=&lt;hex&gt;</span>{" "}
              (HMAC-SHA256 of the raw body). See the README for receiver verification snippets.
            </p>
          </div>
          {testResult && (
            <ResultCard
              ok={testResult.ok}
              title={testResult.ok ? "Connection Success" : "Connection Failed"}
              detail={testResult.message}
            />
          )}
        </div>
      </section>

      {/* Webhook delivery log */}
      <WebhookDeliveries />

      {/* Poll Interval */}
      <section className="card p-8 space-y-6">
        <div className="flex justify-between items-end">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <h2 className="text-xl font-bold text-on-surface">Poll Interval</h2>
            </div>
            <p className="text-on-surface-variant text-sm">Frequency of transcript synchronization cycles.</p>
          </div>
          <div className="text-right">
            <span className="text-5xl font-black text-primary tracking-tighter">{pollMinutes}</span>
            <span className="font-label text-sm font-bold text-on-surface-variant uppercase ml-2">minutes</span>
          </div>
        </div>
        <div className="space-y-3">
          <input
            type="range"
            min={1}
            max={60}
            value={pollMinutes}
            onChange={(e) => {
              setPollMinutes(Number(e.target.value));
              setDirty(true);
            }}
            className="w-full accent-primary"
          />
          <div className="flex justify-between font-label text-[10px] text-on-surface-variant font-bold tracking-widest uppercase">
            <span>1 min</span>
            <span>30 mins</span>
            <span>60 mins</span>
          </div>
        </div>
      </section>

      {/* Plaud import option (saved with Save Settings) */}
      <section className="card p-8 space-y-4">
        <h2 className="text-xl font-bold text-on-surface">Plaud library</h2>
        <p className="text-sm text-on-surface-variant max-w-prose">
          By default only files that are still active in Plaud are listed and synced. Enable the option below to also
          download and show items you deleted in the Plaud app (they appear with the trash badge on the recordings list).
        </p>
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary shrink-0"
            checked={importPlaudDeleted}
            onChange={(e) => {
              setImportPlaudDeleted(e.target.checked);
              setDirty(true);
            }}
          />
          <span className="text-sm font-medium text-on-surface">Import recordings deleted in Plaud</span>
        </label>
      </section>

      {/* Save Footer */}
      <footer className="pt-4 flex flex-col items-center">
        <button
          className="w-full max-w-md btn-primary py-4 text-base font-black shadow-lg shadow-primary/10"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : "Save Settings"}
        </button>
        <p className="mt-4 font-label text-[10px] text-on-surface-variant uppercase tracking-[0.15em]">
          Changes take effect immediately on local engine.
        </p>
      </footer>
    </div>
  );
}
