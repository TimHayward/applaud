export interface TranscriptBlock {
  timestamp: string;
  seconds: number;
  speaker: string;
  text: string;
}

export function parseTimestamp(ts: string): number {
  const parts = ts.split(":").map((p) => parseInt(p, 10));
  if (parts.length === 3) {
    return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  }
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}

export function parseTranscript(raw: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const regex = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+(.+?):\s+([\s\S]*?)(?=\n\n\[|\s*$)/gm;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const ts = match[1] ?? "";
    blocks.push({
      timestamp: ts,
      seconds: parseTimestamp(ts),
      speaker: (match[2] ?? "").trim(),
      text: (match[3] ?? "").trim(),
    });
  }
  return blocks;
}

export function formatTimeCompact(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
