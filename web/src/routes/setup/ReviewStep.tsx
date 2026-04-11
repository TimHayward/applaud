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

  if (cfg.isLoading) return <p>loading…</p>;
  const c = cfg.data?.config;
  if (!c) return <p>failed to load</p>;

  return (
    <div>
      <h2 className="text-2xl font-semibold text-ink-900">Review</h2>
      <p className="mt-2 text-ink-600">
        Confirm these settings, then we'll start syncing.
      </p>
      <dl className="mt-6 divide-y divide-ink-200 rounded-md border border-ink-200 bg-white">
        <Row label="Plaud account">
          {c.tokenEmail ?? <span className="text-ink-400">unknown</span>}
        </Row>
        <Row label="Recordings folder">
          <code className="text-xs">{c.recordingsDir ?? "(not set)"}</code>
        </Row>
        <Row label="Webhook">
          {c.webhook?.url ? (
            <code className="text-xs">{c.webhook.url}</code>
          ) : (
            <span className="text-ink-400">none</span>
          )}
        </Row>
        <Row label="Poll interval">every {c.pollIntervalMinutes} min</Row>
        <Row label="Listening on">
          <code className="text-xs">
            {c.bind.host}:{c.bind.port}
          </code>
        </Row>
      </dl>
      <div className="mt-8 flex justify-between">
        <button className="btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <button className="btn-primary" onClick={() => void onFinish()}>
          Save &amp; start syncing
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-sm">
      <dt className="font-medium text-ink-700">{label}</dt>
      <dd className="text-ink-900">{children}</dd>
    </div>
  );
}
