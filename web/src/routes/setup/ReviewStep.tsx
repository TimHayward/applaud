import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.js";

export function ReviewStep({
  onFinish,
  onBack,
}: {
  onFinish: () => Promise<void>;
  onBack: () => void;
}): JSX.Element {
  const cfg = useQuery({ queryKey: ["config"], queryFn: api.config });

  if (cfg.isLoading) return <p className="text-on-surface-variant">loading…</p>;
  const c = cfg.data?.config;
  if (!c) return <p>failed to load</p>;

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <span className="font-label text-primary text-xs font-bold tracking-widest uppercase">Step 5</span>
        <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Review &amp; Launch</h1>
        <p className="text-on-surface-variant text-base max-w-md leading-relaxed">
          Confirm these settings, then we'll start syncing.
        </p>
      </div>

      <dl className="divide-y divide-outline-variant/20 rounded-xl bg-surface-container-low overflow-hidden">
        <Row label="Plaud account">
          {c.tokenEmail ?? <span className="text-on-surface-variant">unknown</span>}
        </Row>
        <Row label="Recordings folder">
          <code className="font-mono text-xs text-primary">{c.recordingsDir ?? "(not set)"}</code>
        </Row>
        <Row label="Webhook">
          {c.webhook?.url ? (
            <code className="font-mono text-xs text-primary">{c.webhook.url}</code>
          ) : (
            <span className="text-on-surface-variant">none</span>
          )}
        </Row>
        <Row label="Poll interval">every {c.pollIntervalMinutes} min</Row>
        <Row label="Listening on">
          <code className="font-mono text-xs text-on-surface">
            {c.bind.host}:{c.bind.port}
          </code>
        </Row>
      </dl>

      <div className="flex items-center justify-between pt-4">
        <button className="flex items-center gap-2 text-on-surface-variant font-semibold text-sm hover:text-on-surface transition-colors group" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:-translate-x-1 transition-transform"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          Back
        </button>
        <button className="btn-primary px-8 py-3 flex items-center gap-3 shadow-lg shadow-primary/10" onClick={() => void onFinish()}>
          Save &amp; start syncing
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between px-6 py-4 text-sm">
      <dt className="font-label text-xs text-on-surface-variant uppercase tracking-wider">{label}</dt>
      <dd className="text-on-surface">{children}</dd>
    </div>
  );
}
