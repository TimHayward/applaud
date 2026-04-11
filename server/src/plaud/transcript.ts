import { plaudJson } from "./client.js";

export interface TranscriptSegment {
  start_time: number;
  end_time: number;
  content: string;
  speaker: string;
  original_speaker: string;
}

export interface OutlineItem {
  start_time: number;
  end_time: number;
  topic: string;
}

export interface SummaryContent {
  content?:
    | {
        markdown?: string;
        [k: string]: unknown;
      }
    | string;
}

/**
 * The combined transcript + summary endpoint. Despite the name, this returns
 * BOTH the transcript (data_result) and the AI summary (data_result_summ).
 *
 * `data_result_summ` is inconsistent: Plaud returns it as a JSON-encoded string
 * for normal recordings and as a structured object for very short recordings.
 * Normalize via `extractSummaryMarkdown` below.
 */
export interface TranssummResponse {
  status: number;
  msg: string;
  request_id?: string;
  data_result: TranscriptSegment[] | null;
  data_result_summ: SummaryContent | string | null;
  data_result_summ_mul: unknown;
  outline_result: OutlineItem[] | null;
  outline_task_status?: number;
  task_id_info?: unknown;
  data_source_result?: unknown;
  data_note_result?: unknown;
  download_link_map?: Record<string, string>;
  file_version?: number;
  auto_save?: unknown;
  ppc_status?: number;
  err_code?: string;
  err_msg?: string;
}

export async function getTranscriptAndSummary(id: string): Promise<TranssummResponse> {
  return plaudJson<TranssummResponse>(`/ai/transsumm/${id}`, {
    method: "POST",
    body: "{}",
  });
}

export function flattenTranscript(segments: TranscriptSegment[] | null): string {
  if (!segments || segments.length === 0) return "";
  const lines: string[] = [];
  for (const s of segments) {
    const speaker = s.speaker || s.original_speaker || "Speaker";
    const ts = formatTimestamp(s.start_time);
    lines.push(`[${ts}] ${speaker}: ${s.content}`);
  }
  return lines.join("\n\n");
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function extractSummaryMarkdown(resp: TranssummResponse): string | null {
  const raw = resp.data_result_summ;
  if (!raw) return null;

  // Plaud returns this field as either a structured object OR a JSON-encoded string.
  let obj: SummaryContent | null = null;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as SummaryContent;
    } catch {
      // Not JSON — fall back to treating the raw string as markdown itself.
      return raw.trim().length > 0 ? raw : null;
    }
  } else {
    obj = raw;
  }

  const content = obj?.content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : null;
  }
  if (content && typeof content === "object") {
    const md = (content as { markdown?: unknown }).markdown;
    if (typeof md === "string" && md.trim().length > 0) return md;
  }
  return null;
}
