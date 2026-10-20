import type { Interval } from "./silence.ts";

export interface TimedWord {
  text: string;
  startUs: number;
  endUs: number;
}
export interface Adjustment {
  index: number;
  field: "startUs" | "endUs";
  from: number;
  to: number;
}
export interface ClampResult<W extends TimedWord> {
  words: W[];
  adjustments: Adjustment[];
  /** Words that lie completely inside a detected silence: probably hallucinated, left untouched. */
  insideSilence: number[];
}

/**
 * Whisper word times often stretch into the pause after (or before) a word. The audio says where
 * the pause really is, so a word end that runs into a silence is pulled back to the silence start,
 * and a word start that begins inside a silence is pushed to the silence end. A word is never
 * shrunk below minWordUs. Pure function: input is not modified.
 */
export function clampWordsToSilence<W extends TimedWord>(words: readonly W[], silences: readonly Interval[], opts: { minWordUs?: number } = {}): ClampResult<W> {
  const minWordUs = opts.minWordUs ?? 20_000;
  const adjustments: Adjustment[] = [];
  const insideSilence: number[] = [];
  const out = words.map((w, index) => {
    let { startUs, endUs } = w;
    const covering = silences.find((s) => s.startUs <= startUs && s.endUs >= endUs);
    if (covering) {
      insideSilence.push(index);
      return { ...w };
    }
    for (const s of silences) {
      // word start inside a silence, word continues past it
      if (s.startUs <= startUs && s.endUs > startUs && s.endUs < endUs && endUs - s.endUs >= minWordUs) {
        adjustments.push({ index, field: "startUs", from: startUs, to: s.endUs });
        startUs = s.endUs;
      }
      // word end stretches into a silence that starts after the word start
      if (s.startUs > startUs && s.startUs < endUs && s.endUs >= endUs && s.startUs - startUs >= minWordUs) {
        adjustments.push({ index, field: "endUs", from: endUs, to: s.startUs });
        endUs = s.startUs;
      }
    }
    return { ...w, startUs, endUs };
  });
  return { words: out, adjustments, insideSilence };
}
