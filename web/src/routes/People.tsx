import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SpeakerPeopleResponse, SpeakerPerson } from "@applaud/shared";
import { api } from "../api.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { useToast } from "../components/Toast.js";
import { formatDateTime } from "../lib/format.js";

function Voiceprints({ person, onChanged }: { person: SpeakerPerson; onChanged: (res: SpeakerPeopleResponse) => void }): JSX.Element {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: ["speaker-voiceprints", person.id],
    queryFn: () => api.personVoiceprints(person.id),
  });

  const remove = async (id: number, title: string): Promise<void> => {
    const ok = await confirm({
      title: "Delete this voiceprint?",
      message: `Applaud stops using ${person.name}'s voice from “${title}” for recognition. The label in that recording keeps its name.`,
      confirmLabel: "Delete voiceprint",
      destructive: true,
    });
    if (!ok) return;
    try {
      onChanged(await api.deleteVoiceprint(id));
      await q.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (q.isLoading) return <p className="text-sm text-on-surface-variant">Loading…</p>;
  const prints = q.data?.voiceprints ?? [];
  if (prints.length === 0) {
    return (
      <p className="text-sm text-on-surface-variant">
        No voiceprints yet. Confirm {person.name} on a recording where they speak for at least 20 seconds.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-outline-variant/30">
      {prints.map((v) => {
        const title = v.recordingTitle ?? v.recordingId;
        return (
          <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <div className="min-w-0">
              <Link to={`/recordings/${v.recordingId}`} className="text-primary hover:underline truncate block">
                {title}
              </Link>
              <p className="text-xs text-on-surface-variant">
                {v.recordingStart ? `${formatDateTime(v.recordingStart)} · ` : ""}
                {v.plaudLabel} · {Math.round(v.speechMs / 1000)} s
                {v.source === "plaud_owner" ? " · tagged by Plaud" : ""}
                {v.isAnchor ? " · first voiceprint, always kept" : ""}
              </p>
              {v.lowResemblance && (
                <p className="text-xs text-error">Doesn&apos;t sound like their other recordings. Check it was confirmed correctly.</p>
              )}
            </div>
            <button type="button" className="btn-ghost text-xs text-error" onClick={() => void remove(v.id, title)}>
              Delete
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PersonCard({
  person,
  people,
  onChanged,
}: {
  person: SpeakerPerson;
  people: SpeakerPerson[];
  onChanged: (res: SpeakerPeopleResponse) => void;
}): JSX.Element {
  const toast = useToast();
  const confirm = useConfirm();
  const [mode, setMode] = useState<"view" | "rename" | "merge">("view");
  const [name, setName] = useState(person.name);
  const [mergeInto, setMergeInto] = useState("");
  const [showPrints, setShowPrints] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<SpeakerPeopleResponse>): Promise<void> => {
    setBusy(true);
    try {
      onChanged(await action());
      setMode("view");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const merge = async (): Promise<void> => {
    const target = people.find((p) => p.id === Number(mergeInto));
    if (!target) return;
    const ok = await confirm({
      title: `Merge ${person.name} into ${target.name}?`,
      message: `Everything named ${person.name} becomes ${target.name}, and their voiceprints are combined. This can't be undone.`,
      confirmLabel: "Merge",
    });
    if (ok) await run(() => api.mergePerson(person.id, target.id));
  };

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${person.name}?`,
      message:
        "Their voiceprints are deleted and their labels in recordings go back to unknown. Plaud's own transcripts are not affected.",
      confirmLabel: "Delete person",
      destructive: true,
    });
    if (ok) await run(() => api.deletePerson(person.id));
  };

  const others = people.filter((p) => p.id !== person.id);

  return (
    <li className="card p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {mode === "rename" ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api.renamePerson(person.id, name));
              }}
            >
              <input
                autoFocus
                className="input py-1.5 text-sm"
                value={name}
                maxLength={100}
                aria-label="New name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setMode("view");
                }}
              />
              <button type="submit" className="btn-primary text-sm" disabled={busy || !name.trim()}>
                Save
              </button>
              <button type="button" className="btn-ghost text-sm" onClick={() => setMode("view")}>
                Cancel
              </button>
            </form>
          ) : (
            <p className="text-lg font-bold text-on-surface">
              {person.name}
              {person.isOwner && (
                <span className="ml-2 align-middle rounded-full bg-secondary/15 px-2 py-0.5 text-[11px] font-semibold text-secondary">
                  You
                </span>
              )}
            </p>
          )}
          <p className="text-sm text-on-surface-variant">
            {person.recordings} recording{person.recordings === 1 ? "" : "s"} · {person.voiceprints} voiceprint
            {person.voiceprints === 1 ? "" : "s"}
          </p>
          {person.lowResemblance > 0 && (
            <p className="text-sm text-error">
              {person.lowResemblance} voiceprint{person.lowResemblance === 1 ? " doesn't" : "s don't"} sound like the
              others.
            </p>
          )}
        </div>
        {mode === "view" && (
          <div className="flex flex-wrap gap-2">
            {!person.isOwner && (
              <button type="button" className="btn-ghost text-sm" onClick={() => { setName(person.name); setMode("rename"); }}>
                Rename
              </button>
            )}
            {!person.isOwner && others.length > 0 && (
              <button type="button" className="btn-ghost text-sm" onClick={() => setMode("merge")}>
                Merge…
              </button>
            )}
            {!person.isOwner && (
              <button type="button" className="btn-ghost text-sm text-error" disabled={busy} onClick={() => void remove()}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {mode === "merge" && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-on-surface" htmlFor={`merge-${person.id}`}>
            Same person as
          </label>
          <select
            id={`merge-${person.id}`}
            className="input py-1.5 text-sm"
            value={mergeInto}
            onChange={(e) => setMergeInto(e.target.value)}
          >
            <option value="">Choose…</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn-primary text-sm" disabled={busy || !mergeInto} onClick={() => void merge()}>
            Merge
          </button>
          <button type="button" className="btn-ghost text-sm" onClick={() => setMode("view")}>
            Cancel
          </button>
        </div>
      )}

      <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowPrints(!showPrints)}>
        {showPrints ? "Hide voiceprints" : "Voiceprints"}
      </button>
      {showPrints && <Voiceprints person={person} onChanged={onChanged} />}
    </li>
  );
}

/** Settings → People: everyone speaker identification knows. */
export function People(): JSX.Element {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["speaker-status"], queryFn: api.speakerStatus });
  const q = useQuery({ queryKey: ["speaker-people"], queryFn: api.speakerPeople });

  const changed = (res: SpeakerPeopleResponse): void => {
    qc.setQueryData(["speaker-people"], res);
    void qc.invalidateQueries({ queryKey: ["speaker-voiceprints"] });
    void qc.invalidateQueries({ queryKey: ["recording-speakers"] });
    void qc.invalidateQueries({ queryKey: ["speaker-review"] });
  };

  const people = q.data?.people ?? [];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <nav className="flex items-center gap-2 text-xs font-label uppercase tracking-widest text-on-surface-variant mb-4">
          <Link to="/settings" className="hover:text-on-surface transition-colors">Settings</Link>
          <span aria-hidden>›</span>
          <span className="text-primary">People</span>
        </nav>
        <h1 className="text-4xl font-black text-on-surface tracking-tight">People</h1>
        <p className="text-sm text-on-surface-variant mt-2 max-w-prose">
          Everyone speaker identification has been told about. Each person keeps up to 12 voiceprints, taken from
          recordings where you confirmed them; voiceprints stay in Applaud&apos;s database on this host.
        </p>
      </div>

      {status.data && !status.data.enabled ? (
        <p className="card p-6 text-sm text-on-surface-variant">
          Speaker identification is off. Turn it on in <Link to="/settings" className="text-primary hover:underline">Settings</Link>.
        </p>
      ) : q.isLoading ? (
        <div className="h-32 bg-surface-container rounded-xl animate-pulse" />
      ) : q.error ? (
        <p className="card p-6 text-sm text-error">Couldn&apos;t load people.</p>
      ) : people.length === 0 ? (
        <p className="card p-6 text-sm text-on-surface-variant">
          Nobody yet. Name a speaker on any recording&apos;s page and they appear here.
        </p>
      ) : (
        <ul className="space-y-4">
          {people.map((p) => (
            <PersonCard key={p.id} person={p} people={people} onChanged={changed} />
          ))}
        </ul>
      )}
    </div>
  );
}
