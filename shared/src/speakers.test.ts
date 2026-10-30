import { describe, it, expect } from "vitest";
import { isGenericSpeakerLabel } from "./speakers.js";

describe("isGenericSpeakerLabel", () => {
  it.each([
    "Speaker 1",
    "speaker 12",
    "Speaker1",
    "SPEAKER_00",
    "Speaker-3",
    "S1",
    "s 2",
    "Spk 4",
    "7",
    "说话人 1",
    "说话人2",
    "Speaker",
    "Unknown",
    "UNK",
    "UU",
    "",
    "   ",
  ])("treats %j as a placeholder", (label) => {
    expect(isGenericSpeakerLabel(label)).toBe(true);
  });

  it("treats null and undefined as placeholders", () => {
    expect(isGenericSpeakerLabel(null)).toBe(true);
    expect(isGenericSpeakerLabel(undefined)).toBe(true);
  });

  it.each(["Tim Hayward", "Sam", "Sarah 2", "Speaker Jones", "Uma", "S. Smith", "Speakers"])(
    "treats %j as a name",
    (label) => {
      expect(isGenericSpeakerLabel(label)).toBe(false);
    },
  );
});
