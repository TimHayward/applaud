// Placeholders Plaud and other diarisers give an unidentified voice: "Speaker 1",
// "SPEAKER_00", "S1", "Spk 2", a bare number, Plaud's Chinese "说话人 1", and
// "Speaker" / "Unknown" / "UU" on their own.
const NUMBERED = /^(?:speaker|spk|s|说话人)?[\s_-]*\d+$/i;
const BARE = /^(?:speaker|unknown|unk|uu)$/i;

/**
 * Whether a speaker label is a placeholder rather than a person's name.
 * Generic labels are never stored as people or offered as match targets:
 * an unidentified cluster is not a person.
 */
export function isGenericSpeakerLabel(label: string | null | undefined): boolean {
  const s = (label ?? "").trim();
  return s === "" || NUMBERED.test(s) || BARE.test(s);
}
