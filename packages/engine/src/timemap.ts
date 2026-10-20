import { atomPos } from "./atoms";
import type { EngineContext } from "./context";
import { spanToInterval, type Interval } from "./cursor";
import { divRound, frameStartUs, snapToFrameUs, type Fps } from "./frames";
import type { Atom, Effect, Micros, Rate, Timeline } from "./types";

/**
 * Time mapping between ORIGINAL (source) time and EDITED (output) time.
 *
 * The edited timeline is a list of pieces, in output order. Each piece is a
 * stretch of source played at one constant rate. Within a piece, output time
 * is linear in source time, so mapping is one multiply/divide.
 *
 * Rounding (frame accuracy). The output is a whole number of frames. A piece's
 * exact output length is usually a fraction of a frame (31 frames at 2x = 15.5),
 * so pieces get frames by CUMULATIVE rounding:
 *   frames_k = round(exact frames up to piece k) - round(exact frames up to piece k-1)
 * The total therefore equals round(exact total) (within 0.5 frame of exact) and
 * each piece is within 1 frame of its own exact length. Fractions are kept exact
 * with BigInt, so no float error creeps in. Piece start/end times are frame starts
 * (rounded to a microsecond), so the sum of pieces IS timeline.durationUs.
 * Without an fps (audio only) the same rule is applied in microseconds.
 */
export interface SpeedInterval extends Interval {
  rate: Rate;
}

export interface Piece {
  srcS: Micros;
  srcE: Micros;
  outS: Micros;
  outE: Micros;
  rate: Rate;
  /** Whole output frames this piece occupies (null without an fps). */
  outFrames: number | null;
}

const ONE: Rate = { num: 1, den: 1 };
const US = 1_000_000n;

function gcdBig(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * A source time as an exact number of frames (a fraction). A time that sits on the
 * frame grid stands for that exact frame (the microsecond value is only the frame
 * start rounded to the nearest microsecond), so 31 frames really are 31 frames and
 * not 30.99999. A time off the grid (a boundary between two touching words) is
 * kept as the exact fraction it is.
 */
function framePos(t: number, fps: Fps): [bigint, bigint] {
  if (snapToFrameUs(t, fps) === t) return [BigInt(divRound(t * fps.num, fps.den * 1_000_000)), 1n];
  return [BigInt(t) * BigInt(fps.num), BigInt(fps.den) * US];
}

function firstSpeedEndingAfter(speed: readonly SpeedInterval[], x: number): number {
  let lo = 0;
  let hi = speed.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (speed[mid]!.e > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** segs are in output order; speed is sorted by source time and non-overlapping. Linear in pieces. */
export function buildPieces(segs: readonly Interval[], speed: readonly SpeedInterval[], fps: Fps | null = null): Piece[] {
  const pieces: Piece[] = [];
  // exact cumulative output length so far, in frames (or microseconds without fps): cumN / cumD
  let cumN = 0n;
  let cumD = 1n;
  let prevR = 0n; // round(cumulative) after the previous piece

  const push = (srcS: number, srcE: number, rate: Rate): void => {
    // exact output length of this piece = (source length) / rate, in frames (or microseconds)
    let n: bigint;
    let d: bigint;
    if (fps) {
      const [sn, sd] = framePos(srcS, fps);
      const [en, ed] = framePos(srcE, fps);
      n = (en * sd - sn * ed) * BigInt(rate.den);
      d = ed * sd * BigInt(rate.num);
    } else {
      n = BigInt(srcE - srcS) * BigInt(rate.den);
      d = BigInt(rate.num);
    }
    const l = (cumD / gcdBig(cumD, d)) * d; // lcm
    cumN = cumN * (l / cumD) + n * (l / d);
    cumD = l;
    const r = (2n * cumN + cumD) / (2n * cumD); // round half up (all values are non-negative)
    const frames = Number(r - prevR);
    const outS = fps ? frameStartUs(Number(prevR), fps) : Number(prevR);
    const outE = fps ? frameStartUs(Number(r), fps) : Number(r);
    pieces.push({ srcS, srcE, outS, outE, rate, outFrames: fps ? frames : null });
    prevR = r;
  };

  // Segments are in OUTPUT order (a reorder makes that differ from source order); speed regions are sorted by
  // SOURCE time and stay attached to their source atoms, so each segment finds its regions by binary search.
  for (const seg of segs) {
    let at = seg.s;
    for (let k = firstSpeedEndingAfter(speed, seg.s); k < speed.length && speed[k]!.s < seg.e; k++) {
      const sp = speed[k]!;
      const a = Math.max(sp.s, seg.s);
      const b = Math.min(sp.e, seg.e);
      if (at < a) push(at, a, ONE);
      push(a, b, sp.rate);
      at = b;
    }
    if (at < seg.e) push(at, seg.e, ONE);
  }
  return pieces;
}

/** Pieces of a materialized timeline (converts its cursors to absolute times). */
export function timelinePieces(ctx: EngineContext, tl: Timeline): Piece[] {
  const hit = pieceCache.get(tl);
  if (hit) return hit;
  const pieces = computeTimelinePieces(ctx, tl);
  pieceCache.set(tl, pieces);
  return pieces;
}

// A Timeline object is never mutated, so its pieces can be remembered (effects, answers and lookups all need them).
const pieceCache = new WeakMap<Timeline, Piece[]>();

/** Let finalize hand over the pieces it already built for the duration. */
export function primePieces(tl: Timeline, pieces: Piece[]): void {
  pieceCache.set(tl, pieces);
}

function computeTimelinePieces(ctx: EngineContext, tl: Timeline): Piece[] {
  const segs = tl.segments.map((s) => spanToInterval(ctx.index, s.span, ctx.fps));
  const speed = tl.speedRegions.map((r) => ({ ...spanToInterval(ctx.index, r.span, ctx.fps), rate: r.rate }));
  return buildPieces(segs, speed, ctx.fps);
}

// ---------------------------------------------------------------------------
// Two indexes over the pieces
//
//  * OUTPUT index: the pieces array itself, in output order, outS strictly non-decreasing.
//    Used by editedToSource (binary search on outS).
//  * SOURCE index: piece positions sorted by srcS. Pieces never overlap in source time, so this is a
//    total order. Used by sourceToEdited, atomOutSpan and the effect runs (binary search on srcS).
//    When no reorder has happened the two orders coincide and the source index is the identity (null).
//
// A reorder only changes the output order; source positions of atoms, speed regions and effects do not
// move, which is why they stay attached (see docs/DESIGN.md, "Reorder").
// ---------------------------------------------------------------------------

const srcOrderCache = new WeakMap<readonly Piece[], Int32Array | null>();

function srcOrder(pieces: readonly Piece[]): Int32Array | null {
  const hit = srcOrderCache.get(pieces);
  if (hit !== undefined) return hit;
  let sorted = true;
  for (let i = 1; i < pieces.length; i++) {
    if (pieces[i]!.srcS < pieces[i - 1]!.srcS) {
      sorted = false;
      break;
    }
  }
  let order: Int32Array | null = null;
  if (!sorted) {
    order = Int32Array.from({ length: pieces.length }, (_, i) => i).sort((x, y) => pieces[x]!.srcS - pieces[y]!.srcS);
  }
  srcOrderCache.set(pieces, order);
  return order;
}

/** Output position of the piece with the given source rank. */
function outPos(order: Int32Array | null, rank: number): number {
  return order ? order[rank]! : rank;
}

/** Source rank of the last piece with srcS <= t, or -1. */
function lastRankStartingAtOrBefore(pieces: readonly Piece[], order: Int32Array | null, t: Micros): number {
  let lo = 0;
  let hi = pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pieces[outPos(order, mid)]!.srcS <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Source rank of the first piece with srcE > t (pieces.length if none). */
function firstRankEndingAfter(pieces: readonly Piece[], order: Int32Array | null, t: Micros): number {
  let lo = 0;
  let hi = pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pieces[outPos(order, mid)]!.srcE > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function outOf(p: Piece, t: Micros): Micros {
  return p.outS + divRound((t - p.srcS) * p.rate.den, p.rate.num);
}

/** Source time -> edited time. null when that moment was cut. A boundary belongs to the piece that starts there. */
export function sourceToEdited(pieces: readonly Piece[], t: Micros): Micros | null {
  const order = srcOrder(pieces);
  const r = lastRankStartingAtOrBefore(pieces, order, t);
  const p = r >= 0 ? pieces[outPos(order, r)] : undefined;
  if (p && t >= p.srcS && t < p.srcE) return outOf(p, t);
  return null;
}

/** Like sourceToEdited but for the END of something: a boundary belongs to the piece that ends there. */
export function sourceToEditedEnd(pieces: readonly Piece[], t: Micros): Micros | null {
  const order = srcOrder(pieces);
  const r = firstRankEndingAfter(pieces, order, t - 1); // first piece with srcE >= t
  const p = r < pieces.length ? pieces[outPos(order, r)] : undefined;
  if (p && t > p.srcS && t <= p.srcE) return outOf(p, t);
  return null;
}

/** Edited time -> source time. Times at or after the end map to the end of the last piece (in output order). */
export function editedToSource(pieces: readonly Piece[], o: Micros): Micros {
  if (pieces.length === 0) return 0;
  let lo = 0;
  let hi = pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pieces[mid]!.outS <= o) lo = mid + 1;
    else hi = mid;
  }
  const p = pieces[lo - 1]; // last piece starting at or before o
  if (p && o < p.outE) return Math.min(p.srcE, p.srcS + divRound((o - p.outS) * p.rate.num, p.rate.den));
  return pieces[pieces.length - 1]!.srcE;
}

export interface AtomOut {
  startUs: Micros;
  endUs: Micros;
  /** Output positions (indexes into the pieces array) of the first and last piece the atom plays in. */
  firstPiece: number;
  lastPiece: number;
}

/** Where an atom plays in the output, or null if it is entirely cut. (Words are never split across pieces that are apart.) */
export function atomOutSpan(pieces: readonly Piece[], atom: Atom): AtomOut | null {
  const order = srcOrder(pieces);
  let out: AtomOut | null = null;
  for (let r = firstRankEndingAfter(pieces, order, atom.startUs); r < pieces.length; r++) {
    const pos = outPos(order, r);
    const p = pieces[pos]!;
    if (p.srcS >= atom.endUs) break;
    const a = Math.max(atom.startUs, p.srcS);
    const b = Math.min(atom.endUs, p.srcE);
    if (out === null) out = { startUs: outOf(p, a), endUs: outOf(p, b), firstPiece: pos, lastPiece: pos };
    else {
      out.endUs = outOf(p, b);
      out.lastPiece = pos;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Effects after a reorder: runs
// ---------------------------------------------------------------------------

export interface OutSpan {
  startUs: Micros;
  endUs: Micros;
}

/** Atoms that decide where an effect shows: its words if it has any, otherwise all its atoms. */
function anchorAtoms(ctx: EngineContext, range: { from: string; to: string }): Atom[] {
  const a = atomPos(ctx.index, range.from);
  const b = atomPos(ctx.index, range.to);
  const all = ctx.index.atoms.slice(a, b + 1);
  const words = all.filter((x) => x.kind === "word");
  return words.length > 0 ? words : all;
}

/**
 * The RUNS of an effect: groups of its surviving anchor words that play back to back in the output.
 * Rule (one rule, documented in DESIGN.md): walking its surviving words in SOURCE order, a word continues the
 * current run if it plays after the previous word AND everything that plays between them in the output
 * comes from inside the effect's own source range. Otherwise it starts a new run.
 *  - captions and text overlays are shown on the FIRST run only (the run holding the first surviving word)
 *    and the answer warns that the effect is fragmented;
 *  - mute and bleep apply to every run (they are about specific words, wherever those words now are).
 * Without a reorder there is exactly one run, so this is the old behaviour.
 */
export function effectRunsFromPieces(ctx: EngineContext, pieces: readonly Piece[], range: { from: string; to: string }): OutSpan[] {
  const words = anchorAtoms(ctx, range);
  if (words.length === 0) return [];
  const windowS = ctx.index.atoms[atomPos(ctx.index, range.from)]!.startUs;
  const windowE = ctx.index.atoms[atomPos(ctx.index, range.to)]!.endUs;
  const runs: OutSpan[] = [];
  let prev: AtomOut | null = null;
  for (const w of words) {
    const o = atomOutSpan(pieces, w);
    if (!o) continue;
    let joins = false;
    if (prev && runs.length > 0 && o.firstPiece >= prev.lastPiece && o.startUs >= prev.endUs) {
      joins = true;
      for (let k = prev.lastPiece + 1; k < o.firstPiece; k++) {
        const p = pieces[k]!;
        if (p.srcS < windowS || p.srcE > windowE) {
          joins = false;
          break;
        }
      }
    }
    if (joins) runs[runs.length - 1]!.endUs = o.endUs;
    else runs.push({ startUs: o.startUs, endUs: o.endUs });
    prev = o;
  }
  return runs;
}

/** Captions and text overlays never flash by faster than this, however much the video is sped up. */
export const MIN_CAPTION_VISIBLE_US = 700_000;

export interface EffectDisplay {
  startUs: Micros;
  endUs: Micros;
  /** The visible time was lengthened to reach the minimum. The answer must warn about it. */
  extended: boolean;
  /** Every run of the effect, in source order of their first words. runs[0] is the one a caption shows on. */
  runs: OutSpan[];
}

/** Edited-time window of an effect; null if inactive (all words cut). Captions: first run. Mute/bleep: see `runs`. */
export function effectDisplay(ctx: EngineContext, tl: Timeline, e: Effect): EffectDisplay | null {
  const runs = effectRunsFromPieces(ctx, timelinePieces(ctx, tl), e.range);
  if (runs.length === 0) return null;
  const first = runs[0]!;
  const startUs = first.startUs;
  let endUs = first.endUs;
  let extended = false;
  const visual = e.params.kind === "caption" || e.params.kind === "text_overlay";
  if (visual && endUs - startUs < MIN_CAPTION_VISIBLE_US) {
    const target = Math.min(startUs + MIN_CAPTION_VISIBLE_US, tl.durationUs);
    if (target > endUs) {
      endUs = target;
      extended = true;
    }
  }
  return { startUs, endUs, extended, runs };
}

// ---------------------------------------------------------------------------
// Auto-caption cues
// ---------------------------------------------------------------------------

export interface CaptionCue {
  text: string;
  startUs: Micros;
  endUs: Micros;
}

export const CUE_MAX_WORDS = 6;
export const CUE_BREAK_GAP_US = 500_000;

/**
 * Auto-caption cues are DERIVED from the words that survive, in OUTPUT order, every time, so they can never
 * show text for a word that was cut and they follow a reorder. Deterministic chunking rule: a cue ends after
 * CUE_MAX_WORDS (6) words, at a word ending in . ! or ?, or when the next word starts 0.5 s or more after the
 * previous word ended in the output (a pause, or material that was cut or moved away between them).
 */
export function autoCaptionCues(ctx: EngineContext, tl: Timeline): CaptionCue[] {
  const pieces = timelinePieces(ctx, tl);
  const atoms = ctx.index.atoms;
  const cues: CaptionCue[] = [];
  let cur: { words: string[]; startUs: Micros; endUs: Micros } | null = null;
  const flush = (): void => {
    if (cur) cues.push({ text: cur.words.join(" "), startUs: cur.startUs, endUs: cur.endUs });
    cur = null;
  };
  for (const p of pieces) {
    // first atom that ends after the piece starts, then walk while atoms start before the piece ends
    let lo = 0;
    let hi = atoms.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (atoms[mid]!.endUs > p.srcS) hi = mid;
      else lo = mid + 1;
    }
    for (let i = lo; i < atoms.length && atoms[i]!.startUs < p.srcE; i++) {
      const a = atoms[i]!;
      if (a.kind !== "word" || a.startUs < p.srcS || a.endUs > p.srcE) continue; // words are never split by a piece
      const startUs = outOf(p, a.startUs);
      const endUs = outOf(p, a.endUs);
      if (cur && (cur.words.length >= CUE_MAX_WORDS || startUs - cur.endUs >= CUE_BREAK_GAP_US)) flush();
      if (!cur) cur = { words: [], startUs, endUs };
      cur.words.push(a.text);
      cur.endUs = endUs;
      if (/[.!?]$/.test(a.text)) flush();
    }
  }
  flush();
  return cues;
}
