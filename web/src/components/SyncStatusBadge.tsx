import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { formatRelative } from "../lib/format.js";

/** Warn once the Plaud token is within this many days of expiring. */
const TOKEN_EXPIRY_WARNING_DAYS = 14;

export function SyncStatusBadge(): JSX.Element {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["sync-status"],
    queryFn: api.syncStatus,
    refetchInterval: 10_000,
  });
  const cfg = useQuery({ queryKey: ["config"], queryFn: api.config, staleTime: 60_000 });
  const [, force] = useState(0);
  // Re-render every 5s so the "xx ago" string stays fresh.
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);

  // Listen to sync events over SSE to update immediately. Reconnects on
  // error (e.g. a transient network blip) instead of going dark forever.
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      es = new EventSource("/api/sync/events");
      es.onmessage = () => {
        qc.invalidateQueries({ queryKey: ["sync-status"] });
        qc.invalidateQueries({ queryKey: ["recordings"] });
      };
      es.onerror = () => {
        es?.close();
        if (!closed) reconnectTimer = setTimeout(connect, 5_000);
      };
    };
    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [qc]);

  const s = status.data;
  if (!s) return <span className="pill bg-surface-container text-on-surface-variant">loading</span>;
  if (s.authRequired) {
    return (
      <span className="pill bg-error/15 text-error" title="Reconnect your Plaud account on the Settings page.">
        auth required
      </span>
    );
  }
  if (s.lastError) {
    // Surface the actual message: truncated inline, full text on hover.
    const msg = s.lastError.length > 60 ? `${s.lastError.slice(0, 57)}…` : s.lastError;
    return (
      <span className="pill bg-error/15 text-error max-w-xs truncate" title={s.lastError}>
        error: {msg}
      </span>
    );
  }

  const tokenExp = cfg.data?.config.tokenExp;
  const daysUntilExpiry = tokenExp ? Math.ceil((tokenExp * 1000 - Date.now()) / 86_400_000) : null;
  const tokenExpiringSoon = daysUntilExpiry !== null && daysUntilExpiry <= TOKEN_EXPIRY_WARNING_DAYS;

  if (s.polling) {
    return (
      <span className="pill border border-primary/40 bg-primary/15 text-primary">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        syncing
      </span>
    );
  }
  if (tokenExpiringSoon) {
    return (
      <span
        className="pill bg-tertiary/15 text-tertiary"
        title="Reconnect your Plaud account on the Settings page before it expires."
      >
        token expires in {Math.max(0, daysUntilExpiry)}d
      </span>
    );
  }
  const nextInMs = s.nextPollAt ? s.nextPollAt - Date.now() : null;
  const nextIn =
    nextInMs !== null && nextInMs > 0
      ? nextInMs < 60_000
        ? `${Math.ceil(nextInMs / 1000)}s`
        : `${Math.ceil(nextInMs / 60_000)}m`
      : null;
  return (
    <span
      className="pill border border-outline-variant/40 bg-surface-container-low text-on-surface-variant"
      title={nextIn ? `Next sync in about ${nextIn}` : undefined}
    >
      synced {formatRelative(s.lastPollAt)}
      {nextIn ? <span className="opacity-60"> · next in {nextIn}</span> : null}
    </span>
  );
}
