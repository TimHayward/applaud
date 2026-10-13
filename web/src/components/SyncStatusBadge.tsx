import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ticketedUrl } from "../api.js";
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
  // EventSource can't send the LAN-token header, so each connection carries a
  // fresh signed ticket instead (a no-op when no token is configured).
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const retry = (): void => {
      if (!closed) reconnectTimer = setTimeout(() => void connect(), 5_000);
    };

    const connect = async (): Promise<void> => {
      if (closed) return;
      let url: string;
      try {
        url = await ticketedUrl("/api/sync/events");
      } catch {
        retry();
        return;
      }
      if (closed) return;
      es = new EventSource(url);
      es.onmessage = () => {
        qc.invalidateQueries({ queryKey: ["sync-status"] });
        qc.invalidateQueries({ queryKey: ["recordings"] });
      };
      es.onerror = () => {
        es?.close();
        retry();
      };
    };
    void connect();

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
      <Link
        to="/settings"
        className="pill bg-error/15 text-error hover:bg-error/25 transition-colors"
        title="Syncing is paused. Click to reconnect your Plaud account in Settings."
      >
        auth required — reconnect
      </Link>
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
      <Link
        to="/settings"
        className="pill bg-tertiary/15 text-tertiary hover:bg-tertiary/25 transition-colors"
        title="Click to reconnect your Plaud account in Settings before it expires."
      >
        token expires in {Math.max(0, daysUntilExpiry)}d
      </Link>
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
