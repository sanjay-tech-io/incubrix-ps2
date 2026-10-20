import { EngineError } from "./errors";
import { sha256Hex } from "./hash";
import type { Atom, AtomId, Micros } from "./types";

/** A word as it comes from transcription/diarization, before it becomes an atom. */
export interface WordInput {
  text: string;
  startUs: Micros;
  endUs: Micros;
  speaker?: string | null;
  confidencePermille?: number;
  /** Set explicitly for a filler "like"; um/uh are detected from the text when omitted. */
  filler?: boolean;
  overlapsSpeech?: boolean;
  speakerUncertain?: boolean;
}

export interface BuildAtomsOptions {
  /** Words below this confidence (permille) are flagged lowConfidence. */
  lowConfidencePermille?: number;
}

const DEFAULT_CONFIDENCE = 950;
const DEFAULT_LOW_CONFIDENCE = 600;
// Why only these: "like" cannot be judged from its text alone, so it is never filler unless the caller says so.
const FILLER_TEXT = /^(um+|uh+|uhm+|erm|er|hmm+)$/;

export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/**
 * Atom ids are derived from content: sha256(source hash, position, kind, text, start).
 * Same source + same transcript => same ids on every run, with no counters or randomness.
 */
function atomIdOf(sourceSha256: string, index: number, kind: string, text: string, startUs: number): AtomId {
  return "a_" + sha256Hex(`${sourceSha256}|${index}|${kind}|${text}|${startUs}`).slice(0, 12);
}

/** Turn timed words into atoms that tile [0, durationUs]: gaps (including leading/trailing) become silence atoms. */
export function buildAtoms(sourceSha256: string, durationUs: Micros, words: readonly WordInput[], options: BuildAtomsOptions = {}): Atom[] {
  const lowBelow = options.lowConfidencePermille ?? DEFAULT_LOW_CONFIDENCE;
  const atoms: Atom[] = [];
  let cursor = 0;

  const push = (a: Omit<Atom, "id">): void => {
    atoms.push({ id: atomIdOf(sourceSha256, atoms.length, a.kind, a.text, a.startUs), ...a });
  };
  const pushSilence = (startUs: number, endUs: number): void => {
    if (endUs > startUs) {
      push({ kind: "silence", startUs, endUs, text: "", speaker: null, confidencePermille: 1000, lowConfidence: false, filler: false, overlapsSpeech: false, speakerUncertain: false });
    }
  };

  for (const w of words) {
    if (!Number.isInteger(w.startUs) || !Number.isInteger(w.endUs)) throw new Error(`word "${w.text}" has non-integer times`);
    if (w.endUs <= w.startUs) throw new Error(`word "${w.text}" has zero or negative length`);
    if (w.startUs < cursor) throw new Error(`word "${w.text}" overlaps the previous word or starts before 0`);
    if (w.endUs > durationUs) throw new Error(`word "${w.text}" ends after the source duration`);
    pushSilence(cursor, w.startUs);
    const confidence = w.confidencePermille ?? DEFAULT_CONFIDENCE;
    push({
      kind: "word",
      startUs: w.startUs,
      endUs: w.endUs,
      text: w.text,
      speaker: w.speaker ?? null,
      confidencePermille: confidence,
      lowConfidence: confidence < lowBelow,
      filler: w.filler ?? FILLER_TEXT.test(normalizeWord(w.text)),
      overlapsSpeech: w.overlapsSpeech ?? false,
      speakerUncertain: w.speakerUncertain ?? false,
    });
    cursor = w.endUs;
  }
  pushSilence(cursor, durationUs);
  return atoms;
}

/** Atoms plus a lookup by id. Built once per session; validates the tiling invariant. */
export interface AtomIndex {
  readonly atoms: readonly Atom[];
  readonly byId: ReadonlyMap<AtomId, number>;
  readonly durationUs: Micros;
}

export function indexAtoms(atoms: readonly Atom[], durationUs: Micros): AtomIndex {
  const byId = new Map<AtomId, number>();
  let expectedStart = 0;
  atoms.forEach((a, i) => {
    if (a.startUs !== expectedStart) throw new Error(`atoms do not tile the source: atom ${i} starts at ${a.startUs}, expected ${expectedStart}`);
    if (a.endUs <= a.startUs) throw new Error(`atom ${i} has zero or negative length`);
    if (byId.has(a.id)) throw new Error(`duplicate atom id ${a.id}`);
    byId.set(a.id, i);
    expectedStart = a.endUs;
  });
  if (expectedStart !== durationUs) throw new Error(`atoms end at ${expectedStart} but the source lasts ${durationUs}`);
  return { atoms, byId, durationUs };
}

/** Position of an atom in source order. */
export function atomPos(idx: AtomIndex, id: AtomId): number {
  const i = idx.byId.get(id);
  if (i === undefined) throw new EngineError("INVALID_RANGE", `unknown atom ${id}`);
  return i;
}

/** The atom containing time t, for 0 <= t < duration. A boundary belongs to the atom that starts there. */
export function atomAt(idx: AtomIndex, t: Micros): Atom {
  if (t < 0 || t >= idx.durationUs) throw new EngineError("INVALID_CURSOR", `time ${t} is outside the source`);
  let lo = 0;
  let hi = idx.atoms.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx.atoms[mid]!.startUs <= t) lo = mid;
    else hi = mid - 1;
  }
  return idx.atoms[lo]!;
}
