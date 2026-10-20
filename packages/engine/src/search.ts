import { atomAt, atomPos, normalizeWord } from "./atoms";
import { gridWarnings } from "./resolve";
import type { EngineContext } from "./context";
import { snapBoundaryUs, usToCursor } from "./cursor";
import { atomOutSpan, timelinePieces } from "./timemap";
import type { AtomRange, Micros, Span, Timeline } from "./types";

/**
 * Pure search helpers over the atoms. No LLM: instruction parsing is not part of the
 * engine; these answer "where is this phrase?" and "which parts are about this topic?".
 */

/** All places where the words of `phrase` occur back to back (silence atoms between them are skipped). Case and punctuation are ignored. */
export function phraseRanges(ctx: EngineContext, phrase: string): AtomRange[] {
  const want = phrase.split(/\s+/).map(normalizeWord).filter((w) => w.length > 0);
  if (want.length === 0) return [];
  const words = ctx.index.atoms.filter((a) => a.kind === "word");
  const norm = words.map((w) => normalizeWord(w.text));
  const found: AtomRange[] = [];
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((w, k) => norm[i + k] === w)) found.push({ from: words[i]!.id, to: words[i + want.length - 1]!.id });
  }
  return found;
}

/**
 * Tiny built-in topic groups so "cost" finds "pricing". This is a stand-in:
 * real meaning-based search is an Advanced-level item (M4), behind an adapter.
 */
const TOPIC_GROUPS: ReadonlyArray<readonly string[]> = [["pricing", "price", "prices", "priced", "cost", "costs", "costing", "fee", "fees"]];

function topicTerms(topic: string): Set<string> {
  const t = normalizeWord(topic);
  const group = TOPIC_GROUPS.find((g) => g.includes(t));
  return new Set(group ?? [t]);
}

/** Pause long enough to end a "sentence" even without punctuation. */
const SENTENCE_GAP_US = 1_000_000;

interface Sentence {
  firstPos: number; // position of first word atom
  lastPos: number; // position of last word atom
}

function sentences(ctx: EngineContext): Sentence[] {
  const atoms = ctx.index.atoms;
  const out: Sentence[] = [];
  let first = -1;
  let last = -1;
  const close = (): void => {
    if (first >= 0) out.push({ firstPos: first, lastPos: last });
    first = -1;
  };
  atoms.forEach((a, i) => {
    if (a.kind === "silence") {
      if (a.endUs - a.startUs >= SENTENCE_GAP_US) close();
      return;
    }
    if (first < 0) first = i;
    last = i;
    if (/[.!?]$/.test(a.text)) close();
  });
  close();
  return out;
}

export interface TopicPart {
  /** 1-based, in edited-timeline order. This is the number a clarification option shows ("the second one"). */
  index: number;
  snippet: string;
  /** The words of the sentence. */
  range: AtomRange;
  /** What removing "this part" cuts: the sentence plus the silence right after it, so no double pause is left. */
  span: Span;
  /** Grid warnings for the span ends (two touching words cannot be put on a frame boundary). Pass them on with the answer. */
  warnings: string[];
  originalStartUs: Micros;
  editedStartUs: Micros;
}

/** Parts of the CURRENT edited timeline that mention the topic (parts already cut are not offered). */
export function findTopicParts(ctx: EngineContext, tl: Timeline, topic: string): TopicPart[] {
  const terms = topicTerms(topic);
  const atoms = ctx.index.atoms;
  const pieces = timelinePieces(ctx, tl);
  const parts: Omit<TopicPart, "index">[] = [];
  for (const s of sentences(ctx)) {
    const words = atoms.slice(s.firstPos, s.lastPos + 1).filter((a) => a.kind === "word");
    if (!words.some((w) => terms.has(normalizeWord(w.text)))) continue;
    const alive = words.map((w) => atomOutSpan(pieces, w)).filter((x) => x !== null);
    if (alive.length === 0) continue;
    const firstWord = atoms[s.firstPos]!;
    const lastWord = atoms[s.lastPos]!;
    const next = atoms[s.lastPos + 1];
    const endUs = next && next.kind === "silence" ? next.endUs : lastWord.endUs;
    const startSnapped = snapBoundaryUs(ctx.index, firstWord.startUs, ctx.fps);
    const endSnapped = snapBoundaryUs(ctx.index, endUs, ctx.fps);
    parts.push({
      snippet: words.map((w) => w.text).join(" "),
      range: { from: firstWord.id, to: lastWord.id },
      span: { start: usToCursor(ctx.index, startSnapped, ctx.fps), end: usToCursor(ctx.index, endSnapped, ctx.fps) },
      warnings: gridWarnings(ctx, [startSnapped, endSnapped]),
      originalStartUs: firstWord.startUs,
      editedStartUs: alive[0]!.startUs,
    });
  }
  parts.sort((a, b) => a.editedStartUs - b.editedStartUs);
  return parts.map((p, i) => ({ index: i + 1, ...p }));
}

/** Atoms whose time overlaps [s, e) in source time. Used to find which words an edit touches. */
export function atomsOverlapping(ctx: EngineContext, s: Micros, e: Micros): number[] {
  const out: number[] = [];
  if (e <= s || s >= ctx.index.durationUs) return out;
  const first = atomPos(ctx.index, atomAt(ctx.index, Math.max(0, s)).id); // binary search, then walk
  for (let i = first; i < ctx.index.atoms.length && ctx.index.atoms[i]!.startUs < e; i++) out.push(i);
  return out;
}

export function rangeAtoms(ctx: EngineContext, r: AtomRange): number[] {
  const a = atomPos(ctx.index, r.from);
  const b = atomPos(ctx.index, r.to);
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
