import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_SPEAKER_CONFIG,
  type SpeakerSettingsPatch,
  type SpeakerStatusResponse,
  type SpeakerThresholds,
} from "@applaud/shared";
import { api } from "../api.js";
import { useToast } from "./Toast.js";
import { formatRelative } from "../lib/format.js";

/** Poll quickly while something is happening, slowly otherwise. */
function refetchInterval(s: SpeakerStatusResponse | undefined): number {
  if (!s?.enabled) return 60_000;
  return s.state === "checking" || s.current || s.queued > 0 ? 3_000 : 30_000;
}

function StatusLine({ s, onRetry, retrying }: { s: SpeakerStatusResponse; onRetry: () => void; retrying: boolean }): JSX.Element {
  if (s.state === "checking") {
    return <p className="text-sm text-on-surface-variant">Checking that this host can run the speaker model…</p>;
  }
  if (s.state === "available") {
    const work = s.current
      ? `Analysing a recording${s.queued > 1 ? `, ${s.queued - 1} more waiting` : ""}.`
      : s.queued > 0
        ? `${s.queued} recording${s.queued === 1 ? "" : "s"} waiting.`
        : "Up to date.";
    return (
      <div className="space-y-1 text-sm">
        <p className="font-semibold text-secondary">Available</p>
        <p className="text-on-surface-variant">
          {work}
          {s.reembedding > 0 && ` Rebuilding voiceprints for a new model (${s.reembedding} left).`}
          {s.failed > 0 && <span className="text-error"> {s.failed} failed; Re-analyse on a recording retries it.</span>}
        </p>
        {s.lastRun && !s.lastRun.ok && (
          <p className="text-on-surface-variant">
            Last problem, {formatRelative(s.lastRun.at)}: {s.lastRun.error}
          </p>
        )}
        <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">Model {s.modelId}</p>
      </div>
    );
  }
  const unsupported = s.state === "unsupported";
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">
        {unsupported ? "Not supported on this host" : "Unavailable"}
        {s.reason ? `: ${s.reason}.` : "."} Everything else in Applaud carries on as normal.
      </p>
      <button
        type="button"
        className="px-4 py-2 rounded-lg border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/10 transition-colors"
        onClick={onRetry}
        disabled={retrying}
      >
        {retrying ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

const THRESHOLD_FIELDS: { key: keyof SpeakerThresholds; label: string; help: string; step: number; min: number; max: number }[] = [
  {
    key: "autoThreshold",
    label: "Name automatically at",
    help: "Similarity (0 to 1) a speaker needs to be named without asking.",
    step: 0.01,
    min: 0,
    max: 1,
  },
  {
    key: "autoMargin",
    label: "Lead over the next person",
    help: "How far ahead of the second-best match the best one must be.",
    step: 0.01,
    min: 0,
    max: 1,
  },
  {
    key: "minSpeechSec",
    label: "Speech needed (seconds)",
    help: "Less than this is only ever suggested, and doesn't become a voiceprint.",
    step: 1,
    min: 5,
    max: 300,
  },
  {
    key: "suggestThreshold",
    label: "Suggest at",
    help: "Similarity at which a name is offered for you to confirm.",
    step: 0.01,
    min: 0,
    max: 1,
  },
];

/** The matching bands, behind a disclosure: the defaults come from calibration and rarely need changing. */
function ThresholdSettings({
  saved,
  busy,
  onSave,
}: {
  saved: SpeakerThresholds;
  busy: boolean;
  onSave: (patch: SpeakerSettingsPatch) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState<Record<keyof SpeakerThresholds, string>>(() => ({
    autoThreshold: String(saved.autoThreshold),
    autoMargin: String(saved.autoMargin),
    minSpeechSec: String(saved.minSpeechSec),
    suggestThreshold: String(saved.suggestThreshold),
  }));
  const values: SpeakerThresholds = {
    autoThreshold: Number(draft.autoThreshold),
    autoMargin: Number(draft.autoMargin),
    minSpeechSec: Number(draft.minSpeechSec),
    suggestThreshold: Number(draft.suggestThreshold),
  };
  const invalid = THRESHOLD_FIELDS.some(
    (f) => draft[f.key].trim() === "" || !Number.isFinite(values[f.key]) || values[f.key] < f.min || values[f.key] > f.max,
  );
  const inverted = !invalid && values.suggestThreshold > values.autoThreshold;
  const dirty = THRESHOLD_FIELDS.some((f) => values[f.key] !== saved[f.key]);
  const defaults: SpeakerThresholds = {
    autoThreshold: DEFAULT_SPEAKER_CONFIG.autoThreshold,
    autoMargin: DEFAULT_SPEAKER_CONFIG.autoMargin,
    minSpeechSec: DEFAULT_SPEAKER_CONFIG.minSpeechSec,
    suggestThreshold: DEFAULT_SPEAKER_CONFIG.suggestThreshold,
  };
  const isDefault = THRESHOLD_FIELDS.every((f) => saved[f.key] === defaults[f.key]);

  return (
    <details className="group">
      <summary className="cursor-pointer text-sm font-semibold text-on-surface select-none">
        Matching thresholds{isDefault ? "" : " (changed)"}
      </summary>
      <div className="mt-4 space-y-4">
        <p className="text-xs text-on-surface-variant max-w-prose">
          The defaults were calibrated on real recordings. Changing them re-checks every recording straight away;
          names you confirmed are never changed.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {THRESHOLD_FIELDS.map((f) => (
            <label key={f.key} className="block space-y-1">
              <span className="block text-sm font-semibold text-on-surface">{f.label}</span>
              <input
                type="number"
                inputMode="decimal"
                step={f.step}
                min={f.min}
                max={f.max}
                className="w-32 bg-surface-container-highest/50 border-0 rounded-lg p-2 text-sm text-on-surface focus:ring-2 focus:ring-primary/40 focus:outline-none"
                value={draft[f.key]}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
              <span className="block text-xs text-on-surface-variant">{f.help}</span>
            </label>
          ))}
        </div>
        {invalid && <p className="text-sm text-error">Each value must be within its range.</p>}
        {inverted && <p className="text-sm text-error">&ldquo;Suggest at&rdquo; can&apos;t be above &ldquo;Name automatically at&rdquo;.</p>}
        <div className="flex gap-3">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || invalid || inverted || !dirty}
            onClick={() => void onSave(values)}
          >
            Save thresholds
          </button>
          <button
            type="button"
            className="px-4 py-2 rounded-lg border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/10 transition-colors disabled:opacity-50"
            disabled={busy || isDefault}
            onClick={() => void onSave(defaults)}
          >
            Restore defaults
          </button>
        </div>
      </div>
    </details>
  );
}

/** Settings → Speaker identification. Changes save immediately. */
export function SpeakerSettings(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const status = useQuery({
    queryKey: ["speaker-status"],
    queryFn: api.speakerStatus,
    refetchInterval: (q) => refetchInterval(q.state.data),
  });

  const save = async (patch: SpeakerSettingsPatch): Promise<void> => {
    setBusy(true);
    try {
      await api.updateSpeakerSettings(patch);
      await qc.invalidateQueries({ queryKey: ["speaker-status"] });
      await qc.invalidateQueries({ queryKey: ["config"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const retry = async (): Promise<void> => {
    setBusy(true);
    try {
      qc.setQueryData(["speaker-status"], await api.speakerCheck());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const s = status.data;
  const names = s?.plaudNames ?? [];
  // A saved owner name Plaud hasn't been seen using (yet) still has to be selectable.
  const ownerOptions = s?.ownerName && !names.some((n) => n.name === s.ownerName) ? [{ name: s.ownerName, recordings: 0 }, ...names] : names;

  return (
    <section className="card p-8 space-y-6">
      <div className="flex justify-between items-start gap-6">
        <div className="space-y-1">
          <h2 className="text-xl font-bold text-on-surface">Speaker identification</h2>
          <p className="text-sm text-on-surface-variant max-w-prose">
            Recognises the people in your recordings by their voices. The model runs inside Applaud on this host;
            audio and voiceprints never leave it. Turning this on analyses every downloaded recording once, in the
            background.
          </p>
        </div>
        <label className="flex items-center gap-2 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-outline-variant text-primary focus:ring-primary cursor-pointer"
            checked={s?.enabled ?? false}
            disabled={!s || busy}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
          <span className="text-sm font-semibold text-on-surface">{s?.enabled ? "On" : "Off"}</span>
        </label>
      </div>

      {status.error && <p className="text-sm text-error">Failed to load the speaker status.</p>}

      {s?.enabled && (
        <>
          <StatusLine s={s} onRetry={() => void retry()} retrying={busy} />

          <div className="space-y-2">
            <label htmlFor="speaker-owner" className="block text-sm font-semibold text-on-surface">
              Which name is you in Plaud&apos;s transcripts?
            </label>
            <p className="text-xs text-on-surface-variant max-w-prose">
              Plaud tags its account owner by name. Applaud uses those labels to learn your voice.
              {names.length === 0 && " Names appear here once recordings have been analysed."}
            </p>
            <select
              id="speaker-owner"
              className="w-full max-w-md bg-surface-container-highest/50 border-0 rounded-lg p-3 text-sm text-on-surface focus:ring-2 focus:ring-primary/40 focus:outline-none"
              value={s.ownerName ?? ""}
              disabled={busy}
              onChange={(e) => void save({ ownerName: e.target.value || null })}
            >
              <option value="">
                {s.plaudNickname ? `My Plaud account name (${s.plaudNickname})` : "My Plaud account name"}
              </option>
              {ownerOptions.map((n) => (
                <option key={n.name} value={n.name}>
                  {n.name}
                  {n.recordings > 0 ? ` (${n.recordings} recording${n.recordings === 1 ? "" : "s"})` : ""}
                </option>
              ))}
            </select>
          </div>

          <Link to="/settings/people" className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
            People and voiceprints →
          </Link>

          <ThresholdSettings key={JSON.stringify(s.thresholds)} saved={s.thresholds} busy={busy} onSave={save} />
        </>
      )}
    </section>
  );
}
