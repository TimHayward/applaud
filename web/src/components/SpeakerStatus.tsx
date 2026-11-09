import { useQuery } from "@tanstack/react-query";
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
