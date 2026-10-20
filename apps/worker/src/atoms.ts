import { buildAtoms, type Atom, type WordInput } from "@incubrix/engine";
import { clampWordsToSilence, type Interval } from "@incubrix/media";
import type { AsrWord } from "./asr.ts";

export interface AtomBuild {
  atoms: Atom[];
  warnings: string[];
  stats: { words_in: number; words_kept: number; dropped_zero_length: number; dropped_after_end: number; clamp_adjustments: number; inside_silence: number; low_confidence: number };
}

/**
 * ASR words + measured silences -> atoms. Steps: sort, clip to the video length, drop words with no length,
 * pull word edges out of detected silences (Whisper stretches words into pauses), remove overlaps between
 * neighbours, then engine buildAtoms (which derives ids from the file hash and the content).
 * Pure: the same inputs give the same atoms.
 */
export function atomsFromAsr(sha256: string, durationUs: number, asrWords: readonly AsrWord[], silences: readonly Interval[], o: { clampMinWordUs: number; lowConfidencePermille: number }): AtomBuild {
  const warnings: string[] = [];
  let droppedAfterEnd = 0;
  let droppedZero = 0;
  const timed = [...asrWords]
    .sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us)
    .flatMap((w) => {
      if (w.start_us >= durationUs) return (droppedAfterEnd++, []);
      return [{ ...w, startUs: Math.max(0, w.start_us), endUs: Math.min(durationUs, w.end_us) }];
    })
    .filter((w) => w.endUs > w.startUs || (droppedZero++, false));

  const clamped = clampWordsToSilence(timed, silences, { minWordUs: o.clampMinWordUs });
  // Neighbouring words must not overlap: the later word starts where the earlier one ends.
  const words: (typeof timed)[number][] = [];
  for (const w of clamped.words) {
    const prev = words[words.length - 1];
    const startUs = prev ? Math.max(w.startUs, prev.endUs) : w.startUs;
    if (w.endUs <= startUs) {
      droppedZero++;
      continue;
    }
    words.push({ ...w, startUs });
  }

  const inputs: WordInput[] = words.map((w) => ({
    text: w.text,
    startUs: w.startUs,
    endUs: w.endUs,
    speaker: w.speaker ?? null,
    confidencePermille: w.confidence_permille,
    ...(w.overlaps_speech != null ? { overlapsSpeech: w.overlaps_speech } : {}),
    ...(w.speaker_uncertain != null ? { speakerUncertain: w.speaker_uncertain } : {}),
  }));
  const atoms = buildAtoms(sha256, durationUs, inputs, { lowConfidencePermille: o.lowConfidencePermille });
  if (droppedAfterEnd > 0) warnings.push(`${droppedAfterEnd} word(s) from the speech-to-text started after the end of the video and were dropped.`);
  if (droppedZero > 0) warnings.push(`${droppedZero} word(s) had no length after cleaning and were dropped.`);
  if (clamped.insideSilence.length > 0) warnings.push(`${clamped.insideSilence.length} word(s) lie completely inside a detected silence (possibly invented by the speech-to-text); they were kept unchanged.`);
  const low = atoms.filter((a) => a.lowConfidence).length;
  return {
    atoms,
    warnings,
    stats: { words_in: asrWords.length, words_kept: inputs.length, dropped_zero_length: droppedZero, dropped_after_end: droppedAfterEnd, clamp_adjustments: clamped.adjustments.length, inside_silence: clamped.insideSilence.length, low_confidence: low },
  };
}
