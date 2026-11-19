import { useQuery } from "@tanstack/react-query";
import { SPEAKER_FILTERS, type SpeakerFilter } from "@applaud/shared";
import { api } from "../api.js";
import {
  SPEAKER_DOT,
  SPEAKER_TEXT,
  speakerStatus,
  speakerStatusText,
  speakerStatusTitle,
  type SpeakerStatus,
} from "../lib/speakerStatus.js";

/** Speaker status by recording id, from the same queries the pages already share. */
export function useSpeakerStatuses(): (id: string) => SpeakerStatus | null {
  const review = useQuery({ queryKey: ["speaker-review"], queryFn: api.speakerReview, staleTime: 30_000 });
  const pending = useQuery({
    queryKey: ["plaud-writeback", "pending"],
    queryFn: api.plaudWritebackPending,
    staleTime: 30_000,
    enabled: review.data?.enabled === true,
  });
  return (id) => speakerStatus(id, review.data, pending.data);
}

const FILTER_LABELS: Record<SpeakerFilter, string> = {
  label: "To label",
  confirm: "To confirm",
  sync: "To sync",
  synced: "Synced",
  unanalysed: "Not analysed",
};

/**
 * The speaker filters that apply now, or null while speaker identification is
 * off. "To sync" only counts while sending names to Plaud is on.
 */
export function useSpeakerFilterOptions(): SpeakerFilter[] | null {
  const review = useQuery({ queryKey: ["speaker-review"], queryFn: api.speakerReview, staleTime: 30_000 });
  const pending = useQuery({
    queryKey: ["plaud-writeback", "pending"],
    queryFn: api.plaudWritebackPending,
    staleTime: 30_000,
    enabled: review.data?.enabled === true,
  });
  if (!review.data?.enabled) return null;
  return SPEAKER_FILTERS.filter((f) => f !== "sync" || pending.data?.enabled === true);
}

/** A select of speaker filters: All, then those that apply. */
export function SpeakerFilterSelect({
  value,
  options,
  onChange,
  className = "",
}: {
  value: SpeakerFilter | null;
  options: SpeakerFilter[];
  onChange: (value: SpeakerFilter | null) => void;
  className?: string;
}): JSX.Element {
  return (
    <select
      className={className}
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || null) as SpeakerFilter | null)}
      aria-label="Filter by speakers"
    >
      <option value="">All</option>
      {options.map((f) => (
        <option key={f} value={f}>
          {FILTER_LABELS[f]}
        </option>
      ))}
    </select>
  );
}

/** A pill in the style of the audio, transcript and summary pills. */
export function SpeakerStatusPill({ status }: { status: SpeakerStatus }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 bg-surface-container-highest ${SPEAKER_TEXT[status.kind]}`}
      title={speakerStatusTitle(status)}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${SPEAKER_DOT[status.kind]}`} />
      {speakerStatusText(status)}
    </span>
  );
}

/** Just the dot, for the recordings sidebar. */
export function SpeakerStatusDot({ status }: { status: SpeakerStatus | null }): JSX.Element {
  if (!status) return <span className="inline-block h-2 w-2 shrink-0" aria-hidden />;
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${SPEAKER_DOT[status.kind]}`}
      title={`${speakerStatusText(status)}. ${speakerStatusTitle(status)}`}
      role="img"
      aria-label={speakerStatusText(status)}
    />
  );
}
