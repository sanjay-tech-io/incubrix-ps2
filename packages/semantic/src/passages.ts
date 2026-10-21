import type { Atom } from "@incubrix/engine";

/** A sentence-sized stretch of the transcript: the unit that is embedded and shown to the user as a match. */
export interface Passage {
  startUs: number;
  endUs: number;
  text: string;
  speaker: string | null;
}

export const MAX_PASSAGE_WORDS = 30;
export const MAX_PASSAGE_GAP_US = 1_500_000;

/**
 * Deterministic chunking of the words into passages: a passage ends at a word ending in . ? !, after 30 words, before a
 * pause of 1.5 s or more, or when the speaker changes. Same atoms => same passages, always.
 */
export function buildPassages(atoms: readonly Atom[]): Passage[] {
  const out: Passage[] = [];
  let cur: Atom[] = [];
  const flush = (): void => {
    if (cur.length > 0) {
      out.push({ startUs: cur[0]!.startUs, endUs: cur[cur.length - 1]!.endUs, text: cur.map((w) => w.text).join(" "), speaker: cur[0]!.speaker });
    }
    cur = [];
  };
  for (const a of atoms) {
    if (a.kind !== "word") continue;
    const prev = cur[cur.length - 1];
    if (prev && (a.startUs - prev.endUs >= MAX_PASSAGE_GAP_US || a.speaker !== prev.speaker || cur.length >= MAX_PASSAGE_WORDS)) flush();
    cur.push(a);
    if (/[.!?]$/.test(a.text)) flush();
  }
  flush();
  return out;
}
