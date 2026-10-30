import { describe, it, expect } from "vitest";
import type { SpeakerTranscriptSegment } from "@applaud/shared";
import {
  blocksFromSegments,
  blocksToText,
  formatTranscriptTimestamp,
  parseTranscript,
  parseTimestamp,
  formatTimeCompact,
} from "./transcript.js";

describe("blocks from named segments", () => {
  const seg = (key: string, startMs: number, speaker: string): SpeakerTranscriptSegment => ({
    key,
    startMs,
    endMs: startMs + 1_000,
    text: `text ${key}`,
    speaker,
    speakerId: null,
    plaudSpeaker: "Speaker 1",
    plaudLabel: "Speaker 1",
    status: "unknown",
    suggestedSpeaker: null,
    override: false,
  });

  it("formats timestamps like transcript.txt", () => {
    expect(formatTranscriptTimestamp(65_400)).toBe("01:05");
    expect(formatTranscriptTimestamp(3_723_000)).toBe("1:02:03");
  });

  it("round-trips through the transcript text format", () => {
    const blocks = blocksFromSegments([seg("a", 0, "Ann"), seg("b", 65_000, "Bob")]);
    expect(blocks.map((b) => [b.timestamp, b.seconds, b.speaker])).toEqual([
      ["00:00", 0, "Ann"],
      ["01:05", 65, "Bob"],
    ]);
    const text = blocksToText(blocks);
    expect(text).toBe("[00:00] Ann: text a\n\n[01:05] Bob: text b");
    expect(parseTranscript(text).map((b) => b.speaker)).toEqual(["Ann", "Bob"]);
  });
});

describe("parseTimestamp", () => {
  it("parses MM:SS", () => {
    expect(parseTimestamp("02:30")).toBe(150);
  });

  it("parses HH:MM:SS", () => {
    expect(parseTimestamp("01:02:03")).toBe(3723);
  });

  it("parses 0:00", () => {
    expect(parseTimestamp("0:00")).toBe(0);
  });
});

describe("parseTranscript", () => {
  it("parses a single speaker block", () => {
    const raw = "[00:01] Speaker 1: Hello there.";
    const blocks = parseTranscript(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      timestamp: "00:01",
      seconds: 1,
      speaker: "Speaker 1",
      text: "Hello there.",
    });
  });

  it("parses multiple blocks separated by a blank line", () => {
    const raw = "[00:01] Alice: Hi.\n\n[00:05] Bob: Hey there.";
    const blocks = parseTranscript(raw);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.speaker).toBe("Alice");
    expect(blocks[1]?.speaker).toBe("Bob");
    expect(blocks[1]?.seconds).toBe(5);
  });

  it("matches real flattenTranscript output: single-line blocks joined by a blank line", () => {
    // server/src/plaud/transcript.ts's flattenTranscript() joins blocks with
    // "\n\n" and never embeds a raw newline inside a single block's content —
    // this is the actual shape the parser is fed in production.
    const raw = "[00:01] Alice: Hello there, how are you?\n\n[00:10] Bob: Doing well, thanks.";
    const blocks = parseTranscript(raw);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toBe("Hello there, how are you?");
    expect(blocks[1]?.text).toBe("Doing well, thanks.");
  });

  it("supports HH:MM:SS timestamps", () => {
    const raw = "[01:02:03] Alice: Long meeting.";
    const blocks = parseTranscript(raw);
    expect(blocks[0]?.seconds).toBe(3723);
  });

  it("returns an empty array for unparseable text (fallback to raw display)", () => {
    expect(parseTranscript("just some plain text with no speaker markers")).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseTranscript("")).toEqual([]);
  });
});

describe("formatTimeCompact", () => {
  it("formats seconds under a minute as m:ss", () => {
    expect(formatTimeCompact(5)).toBe("0:05");
  });

  it("formats seconds over an hour as h:mm:ss", () => {
    expect(formatTimeCompact(3723)).toBe("1:02:03");
  });

  it("returns a placeholder for Infinity instead of 'Infinity:NaN'", () => {
    expect(formatTimeCompact(Infinity)).toBe("--:--");
  });

  it("returns a placeholder for NaN", () => {
    expect(formatTimeCompact(NaN)).toBe("--:--");
  });

  it("returns a placeholder for negative values", () => {
    expect(formatTimeCompact(-5)).toBe("--:--");
  });
});
