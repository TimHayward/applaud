import { describe, expect, it } from "vitest";
import type { PlaudWritebackPendingResponse, SpeakerReviewResponse } from "@applaud/shared";
import { speakerStatus, speakerStatusText } from "./speakerStatus.js";

const review = (over: Partial<SpeakerReviewResponse> = {}): SpeakerReviewResponse => ({
  enabled: true,
  recordings: {},
  toConfirm: {},
  confirmed: {},
  ...over,
});

const pending = (state: "to_send" | "sent" | "in_plaud", enabled = true): PlaudWritebackPendingResponse => ({
  enabled,
  protocol: 1,
  recordings: [
    {
      recordingId: "r1",
      title: "t",
      startTime: 0,
      pendingSegments: 3,
      changes: [
        { plaudLabel: "Speaker 1", from: "Speaker 1", to: "Ann", segments: 2, segment: null },
        { plaudLabel: "Speaker 1", from: "Bob", to: "Ann", segments: 1, segment: null },
        { plaudLabel: "Speaker 2", from: "Speaker 2", to: "Ben", segments: 1, segment: null },
      ],
      state,
      lastAttemptAt: null,
      lastError: null,
    },
  ],
});

describe("speakerStatus", () => {
  it("shows nothing while speaker identification is off or nothing is named", () => {
    expect(speakerStatus("r1", undefined, undefined)).toBeNull();
    expect(speakerStatus("r1", review({ enabled: false, recordings: { r1: 2 } }), undefined)).toBeNull();
    expect(speakerStatus("r1", review(), undefined)).toBeNull();
  });

  it("puts the most urgent state first", () => {
    const all = review({ recordings: { r1: 1 }, toConfirm: { r1: 2 }, confirmed: { r1: 1 } });
    expect(speakerStatus("r1", all, pending("to_send"))).toEqual({ kind: "label", count: 1 });
    const confirm = review({ toConfirm: { r1: 2 }, confirmed: { r1: 1 } });
    expect(speakerStatus("r1", confirm, pending("to_send"))).toEqual({ kind: "confirm", count: 2 });
  });

  it("counts speakers to sync by Plaud label, only while sending to Plaud is on", () => {
    const done = review({ confirmed: { r1: 2 } });
    expect(speakerStatus("r1", done, pending("to_send"))).toEqual({ kind: "sync", count: 2 });
    expect(speakerStatus("r1", done, pending("sent"))).toEqual({ kind: "sync", count: 2 });
    expect(speakerStatus("r1", done, pending("to_send", false))).toEqual({ kind: "synced", count: 0 });
    expect(speakerStatus("r1", done, pending("in_plaud"))).toEqual({ kind: "synced", count: 0 });
  });

  it("words each state", () => {
    expect(speakerStatusText({ kind: "label", count: 1 })).toBe("1 speaker to label");
    expect(speakerStatusText({ kind: "confirm", count: 2 })).toBe("2 speakers to confirm");
    expect(speakerStatusText({ kind: "sync", count: 3 })).toBe("3 speakers to sync");
    expect(speakerStatusText({ kind: "synced", count: 0 })).toBe("synced");
  });
});
