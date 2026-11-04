import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlaudWritebackPairingCodeResponse, SpeakerSettingsPatch } from "@applaud/shared";
import { api } from "../api.js";
import { useToast } from "./Toast.js";
import { formatRelative } from "../lib/format.js";

/**
 * Settings → Speaker identification → Send names to Plaud: the switch that
 * allows a paired browser extension to write (off by default), and pairing.
 * See docs/plans/plaud-write-back-extension.md.
 */
export function PlaudWritebackSettings({
  enabled,
  webhookWhenNamed,
  busy,
  onSave,
}: {
  enabled: boolean;
  webhookWhenNamed: boolean;
  busy: boolean;
  onSave: (patch: SpeakerSettingsPatch) => Promise<void>;
}): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState<PlaudWritebackPairingCodeResponse | null>(null);
  const [working, setWorking] = useState(false);
  const clients = useQuery({
    queryKey: ["plaud-writeback-clients"],
    queryFn: api.plaudWritebackClients,
  });

  const newCode = async (): Promise<void> => {
    setWorking(true);
    try {
      setCode(await api.plaudWritebackPairingCode());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const revoke = async (id: number): Promise<void> => {
    setWorking(true);
    try {
      qc.setQueryData(["plaud-writeback-clients"], await api.revokePlaudWritebackClient(id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const list = clients.data?.clients ?? [];

  return (
    <div className="space-y-4 border-t border-outline-variant/30 pt-6">
      <div className="flex justify-between items-start gap-6">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-on-surface">Send names to Plaud</h3>
          <p className="text-xs text-on-surface-variant max-w-prose">
            Lets the Applaud browser extension write the names you have confirmed into Plaud, so
            Plaud AI uses them. It works through your own Plaud sign-in in the browser, shows you
            every change first, and can undo it. This is not a Plaud feature and Plaud does not
            support it. Each recording&apos;s page lists the names to send, so you can also enter
            them in Plaud yourself.
          </p>
        </div>
        <label className="flex items-center gap-2 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-outline-variant text-primary focus:ring-primary cursor-pointer"
            checked={enabled}
            disabled={busy}
            onChange={(e) => void onSave({ sendToPlaud: e.target.checked })}
          />
          <span className="text-sm font-semibold text-on-surface">{enabled ? "On" : "Off"}</span>
        </label>
      </div>

      <p className="text-xs text-on-surface-variant max-w-prose">
        Get the extension from the{" "}
        <a
          className="font-semibold text-primary hover:underline"
          href="https://github.com/TimHayward/applaud/releases"
          target="_blank"
          rel="noreferrer"
        >
          Applaud release
        </a>{" "}
        that matches this Applaud (applaud-extension-&lt;version&gt;.zip), and load it in Edge or
        Chrome with Developer mode on. Then pair it here.
      </p>

      <label className="flex items-start gap-3 cursor-pointer max-w-prose">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary cursor-pointer"
          checked={webhookWhenNamed}
          disabled={busy}
          onChange={(e) => void onSave({ webhookWhenNamed: e.target.checked })}
        />
        <span className="text-xs text-on-surface-variant">
          <span className="block text-sm font-semibold text-on-surface">
            Send the webhook again once names are in Plaud
          </span>
          After a send, when Applaud confirms Plaud has every name, it fires{" "}
          <code>transcript_ready</code> again so receivers such as n8n get the named transcript and
          summary. The receiver gets the recording twice; the second replaces the first if it saves
          by file name.
        </span>
      </label>

      <div className="space-y-3">
        <p className="text-sm font-semibold text-on-surface">Paired extensions</p>
        {clients.error && <p className="text-sm text-error">Failed to load paired extensions.</p>}
        {list.length === 0 && !clients.isLoading && (
          <p className="text-xs text-on-surface-variant">None yet.</p>
        )}
        {list.length > 0 && (
          <ul className="space-y-2">
            {list.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-4 text-sm">
                <span className="text-on-surface">
                  {c.name}
                  <span className="text-on-surface-variant">
                    {" "}
                    · paired {formatRelative(c.createdAt)}
                    {c.lastUsedAt ? ` · last used ${formatRelative(c.lastUsedAt)}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  className="text-sm font-semibold text-error hover:underline disabled:opacity-50"
                  disabled={working}
                  onClick={() => void revoke(c.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            className="px-4 py-2 rounded-lg border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/10 transition-colors disabled:opacity-50"
            disabled={working}
            onClick={() => void newCode()}
          >
            {code ? "New pairing code" : "Pair an extension"}
          </button>
          {code && (
            <p className="text-sm text-on-surface-variant">
              Enter{" "}
              <span className="font-mono text-base font-semibold text-on-surface tracking-widest">
                {code.code}
              </span>{" "}
              in the extension. It works once, until {new Date(code.expiresAt).toLocaleTimeString()}
              .
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
