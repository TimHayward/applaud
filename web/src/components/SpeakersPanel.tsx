import { useId, useState } from "react";
import type {
  RecordingSpeakerLabel,
  RecordingSpeakersResponse,
  SetSpeakerLabelRequest,
  SpeakerClip,
  SpeakerPerson,
} from "@applaud/shared";
import { formatTranscriptTimestamp } from "../lib/transcript.js";

/** Labels that need the user first, then automatic, confirmed and ignored ones. */
const ORDER: Record<RecordingSpeakerLabel["status"], number> = {
  suggested: 0,
  unknown: 1,
  auto: 2,
  confirmed: 3,
  ignored: 4,
};

const pct = (score: number | null): string => (score === null ? "" : `${Math.round(score * 100)}%`);

function speechLabel(ms: number | null): string {
  if (!ms) return "little speech";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s of speech` : `${Math.floor(s / 60)} min ${s % 60} s of speech`;
}

function StatusBadge({ label }: { label: RecordingSpeakerLabel }): JSX.Element {
  const base = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold";
  switch (label.status) {
    case "confirmed":
      return (
        <span className={`${base} bg-secondary/15 text-secondary`}>
          {label.assignedBy === "plaud_owner" ? "You, tagged by Plaud" : "Confirmed"}
        </span>
      );
    case "auto":
      return <span className={`${base} bg-primary/15 text-primary`}>Named automatically · {pct(label.confidence)}</span>;
    case "suggested":
      return <span className={`${base} bg-tertiary/15 text-tertiary`}>Suggestion · {pct(label.confidence)}</span>;
    case "ignored":
      return <span className={`${base} bg-surface-container-highest text-on-surface-variant`}>Ignored</span>;
    default:
      return <span className={`${base} bg-surface-container-highest text-on-surface-variant`}>Unknown</span>;
  }
}

function ClipButton({
  clip,
  playing,
  onPlay,
}: {
  clip: SpeakerClip;
  playing: boolean;
  onPlay: (clip: SpeakerClip) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`flex items-start gap-2 w-full text-left rounded-lg px-2 py-1.5 text-sm transition-colors ${
        playing ? "bg-primary/10" : "hover:bg-surface-container"
      }`}
      onClick={() => onPlay(clip)}
      aria-label={`Play ${formatTranscriptTimestamp(clip.startMs)}: ${clip.text}`}
    >
      <span className="shrink-0 mt-0.5 text-primary" aria-hidden>
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
        )}
      </span>
      <span className="shrink-0 font-label text-xs text-on-surface-variant mt-0.5">
        {formatTranscriptTimestamp(clip.startMs)}
      </span>
      <span className="text-on-surface line-clamp-2">{clip.text || "…"}</span>
    </button>
  );
}

function LabelCard({
  label,
  people,
  playingKey,
  onPlay,
  onSet,
  busy,
}: {
  label: RecordingSpeakerLabel;
  people: SpeakerPerson[];
  playingKey: string | null;
  onPlay: (clip: SpeakerClip) => void;
  onSet: (label: string, body: SetSpeakerLabelRequest) => Promise<boolean>;
  busy: boolean;
}): JSX.Element {
  const listId = useId();
  const [name, setName] = useState("");
  const [showAllClips, setShowAllClips] = useState(false);
  const [editing, setEditing] = useState(false);
  const decided = label.status === "confirmed" || label.status === "ignored";
  const open = !decided || editing;
  const title =
    label.speakerName && (label.status === "confirmed" || label.status === "auto")
      ? label.speakerName
      : (label.plaudName ?? label.plaudLabel);
  const clips = showAllClips ? label.clips : label.clips.slice(0, 3);
  const suggestion = label.status === "suggested" || label.status === "auto" ? label.speakerName : null;

  const confirm = async (body: SetSpeakerLabelRequest): Promise<void> => {
    if (await onSet(label.plaudLabel, body)) {
      setName("");
      setEditing(false);
    }
  };
  const confirmTyped = (): void => {
    const typed = name.trim();
    if (!typed) return;
    const existing = people.find((p) => p.name.toLowerCase() === typed.toLowerCase());
    void confirm({ status: "confirmed", person: existing ? { speakerId: existing.id } : { name: typed } });
  };

  return (
    <li className="rounded-xl border border-outline-variant/40 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-on-surface truncate">{title}</p>
          <p className="text-xs text-on-surface-variant">
            Plaud&apos;s {label.plaudLabel}
            {label.plaudName && label.plaudName !== label.plaudLabel ? ` (“${label.plaudName}”)` : ""} ·{" "}
            {label.segments} line{label.segments === 1 ? "" : "s"} · {speechLabel(label.speechMs)}
          </p>
        </div>
        <StatusBadge label={label} />
      </div>

      {open && clips.length > 0 && (
        <div className="space-y-0.5">
          {clips.map((c) => (
            <ClipButton key={c.segmentKey} clip={c} playing={playingKey === c.segmentKey} onPlay={onPlay} />
          ))}
          {label.clips.length > 3 && (
            <button
              type="button"
              className="text-xs text-primary hover:underline px-2"
              onClick={() => setShowAllClips(!showAllClips)}
            >
              {showAllClips ? "Fewer clips" : `${label.clips.length - 3} more clip${label.clips.length - 3 === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      )}

      {open ? (
        <div className="space-y-3">
          {suggestion && label.speakerId !== null && (
            <button
              type="button"
              className="btn-primary text-sm"
              disabled={busy}
              onClick={() => void confirm({ status: "confirmed", person: { speakerId: label.speakerId! } })}
            >
              Yes, it&apos;s {suggestion}
            </button>
          )}
          {label.candidates.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-on-surface-variant">Sounds like</span>
              {label.candidates
                .filter((c) => c.speakerId !== label.speakerId || !suggestion)
                .map((c) => (
                  <button
                    key={c.speakerId}
                    type="button"
                    className="rounded-full border border-outline-variant/50 px-2.5 py-1 text-on-surface hover:bg-surface-container disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void confirm({ status: "confirmed", person: { speakerId: c.speakerId } })}
                    title={`Confirm as ${c.name}`}
                  >
                    {c.name} <span className="text-on-surface-variant">{pct(c.score)}</span>
                  </button>
                ))}
            </div>
          )}
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              confirmTyped();
            }}
          >
            <input
              className="input py-1.5 text-sm flex-1 min-w-[10rem]"
              list={listId}
              placeholder={suggestion ? "Someone else…" : "Who is this?"}
              aria-label={`Name for ${label.plaudLabel}`}
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
            <datalist id={listId}>
              {people.map((p) => (
                <option key={p.id} value={p.name} />
              ))}
            </datalist>
            <button type="submit" className="btn-secondary text-sm" disabled={busy || !name.trim()}>
              Confirm
            </button>
            {label.status !== "ignored" && (
              <button
                type="button"
                className="btn-ghost text-sm"
                disabled={busy}
                onClick={() => void confirm({ status: "ignored" })}
                title="Not a person worth naming: background voices, a TV, a mis-split"
              >
                Ignore
              </button>
            )}
            {decided && label.assignedBy === "user" && (
              <button
                type="button"
                className="btn-ghost text-sm"
                disabled={busy}
                onClick={() => void confirm({ status: "unknown" })}
                title="Forget this choice and let Applaud match it again"
              >
                Reset
              </button>
            )}
            {editing && (
              <button type="button" className="btn-ghost text-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </form>
        </div>
      ) : (
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => setEditing(true)}>
          Change
        </button>
      )}
    </li>
  );
}

/**
 * The recording's speakers (Phase 3 of speaker identification): one card per
 * Plaud label with clips to listen to, the best matches, and a name picker.
 * Two labels that are the same person are merged by giving both the same name.
 */
export function SpeakersPanel({
  data,
  busy,
  playingKey,
  onPlay,
  onSet,
  onReanalyse,
}: {
  data: RecordingSpeakersResponse;
  busy: boolean;
  playingKey: string | null;
  onPlay: (clip: SpeakerClip) => void;
  onSet: (label: string, body: SetSpeakerLabelRequest) => Promise<boolean>;
  onReanalyse: () => void;
}): JSX.Element {
  const [showIgnored, setShowIgnored] = useState(false);
  const labels = [...data.labels].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.plaudLabel.localeCompare(b.plaudLabel, undefined, { numeric: true }),
  );
  const ignored = labels.filter((l) => l.status === "ignored");
  const shown = showIgnored ? labels : labels.filter((l) => l.status !== "ignored");
  const toReview = labels.filter((l) => l.status === "suggested" || l.status === "unknown").length;

  return (
    <section className="card p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-widest text-on-surface-variant font-label">Speakers</h2>
          {data.analysed && (
            <p className="text-xs text-on-surface-variant mt-1">
              {toReview > 0
                ? `${toReview} to name. Listen to a clip, then confirm who it is; confirmed voices are recognised in other recordings.`
                : "Everyone here is named or ignored."}
            </p>
          )}
        </div>
        <button type="button" className="btn-ghost text-xs" onClick={onReanalyse} disabled={busy}>
          Re-analyse
        </button>
      </div>

      {!data.analysed ? (
        <p className="text-sm text-on-surface-variant">
          Not analysed yet. Recordings are analysed in the background once their audio and transcript are downloaded.
        </p>
      ) : labels.length === 0 ? (
        <p className="text-sm text-on-surface-variant">Plaud found no speakers in this recording.</p>
      ) : (
        <ul className="space-y-3">
          {shown.map((l) => (
            <LabelCard
              key={l.plaudLabel}
              label={l}
              people={data.people}
              playingKey={playingKey}
              onPlay={onPlay}
              onSet={onSet}
              busy={busy}
            />
          ))}
        </ul>
      )}
      {ignored.length > 0 && (
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowIgnored(!showIgnored)}>
          {showIgnored ? "Hide ignored" : `Show ${ignored.length} ignored`}
        </button>
      )}
    </section>
  );
}
