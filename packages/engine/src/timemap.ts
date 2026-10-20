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

/** segs and speed must each be sorted and non-overlapping (replay guarantees this). Linear in pieces. */
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

  let j = 0; // first speed region that can still touch the current or a later segment
  for (const seg of segs) {
    while (j < speed.length && speed[j]!.e <= seg.s) j++;
    let at = seg.s;
    for (let k = j; k < speed.length && speed[k]!.s < seg.e; k++) {
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
  const segs = tl.segments.map((s) => spanToInterval(ctx.index, s.span, ctx.fps));
  const speed = tl.speedRegions.map((r) => ({ ...spanToInterval(ctx.index, r.span, ctx.fps), rate: r.rate }));
  return buildPieces(segs, speed, ctx.fps);
}

/** Source time -> edited time. null when that moment was cut. A boundary belongs to the piece that starts there. */
export function sourceToEdited(pieces: readonly Piece[], t: Micros): Micros | null {
  for (const p of pieces) {
    if (t >= p.srcS && t < p.srcE) return p.outS + divRound((t - p.srcS) * p.rate.den, p.rate.num);
  }
  return null;
}

/** Like sourceToEdited but for the END of something: a boundary belongs to the piece that ends there. */
export function sourceToEditedEnd(pieces: readonly Piece[], t: Micros): Micros | null {
  for (const p of pieces) {
    if (t > p.srcS && t <= p.srcE) return p.outS + divRound((t - p.srcS) * p.rate.den, p.rate.num);
  }
  return null;
}

/** Edited time -> source time. Times at or after the end map to the end of the last piece. */
export function editedToSource(pieces: readonly Piece[], o: Micros): Micros {
  if (pieces.length === 0) return 0;
  for (const p of pieces) {
    if (o >= p.outS && o < p.outE) return Math.min(p.srcE, p.srcS + divRound((o - p.outS) * p.rate.num, p.rate.den));
  }
  return pieces[pieces.length - 1]!.srcE;
}

/** Where an atom plays in the output, or null if it is entirely cut. */
export function atomOutSpan(pieces: readonly Piece[], atom: Atom): { startUs: Micros; endUs: Micros } | null {
  let startUs: Micros | null = null;
  let endUs: Micros | null = null;
  for (const p of pieces) {
    if (p.srcE <= atom.startUs || p.srcS >= atom.endUs) continue;
    const a = Math.max(atom.startUs, p.srcS);
    const b = Math.min(atom.endUs, p.srcE);
    if (startUs === null) startUs = p.outS + divRound((a - p.srcS) * p.rate.den, p.rate.num);
    endUs = p.outS + divRound((b - p.srcS) * p.rate.den, p.rate.num);
  }
  return startUs === null || endUs === null ? null : { startUs, endUs };
}

/** Captions and text overlays never flash by faster than this, however much the video is sped up. */
export const MIN_CAPTION_VISIBLE_US = 700_000;

export interface EffectDisplay {
  startUs: Micros;
  endUs: Micros;
  /** The visible time was lengthened to reach the minimum. The answer must warn about it. */
  extended: boolean;
}

/** Atoms that decide where an effect shows: its words if it has any, otherwise all its atoms. */
function anchorAtoms(ctx: EngineContext, e: Effect): Atom[] {
  const a = atomPos(ctx.index, e.range.from);
  const b = atomPos(ctx.index, e.range.to);
  const all = ctx.index.atoms.slice(a, b + 1);
  const words = all.filter((x) => x.kind === "word");
  return words.length > 0 ? words : all;
}

/** Edited-time window of an effect, over its surviving words; null if inactive (all words cut). */
export function effectDisplay(ctx: EngineContext, tl: Timeline, e: Effect): EffectDisplay | null {
  const pieces = timelinePieces(ctx, tl);
  const spans = anchorAtoms(ctx, e)
    .map((a) => atomOutSpan(pieces, a))
    .filter((s): s is { startUs: Micros; endUs: Micros } => s !== null);
  if (spans.length === 0) return null;
  const startUs = Math.min(...spans.map((s) => s.startUs));
  let endUs = Math.max(...spans.map((s) => s.endUs));
  let extended = false;
  const visual = e.params.kind === "caption" || e.params.kind === "text_overlay";
  if (visual && endUs - startUs < MIN_CAPTION_VISIBLE_US) {
    const target = Math.min(startUs + MIN_CAPTION_VISIBLE_US, tl.durationUs);
    if (target > endUs) {
      endUs = target;
      extended = true;
    }
  }
  return { startUs, endUs, extended };
}

export interface CaptionCue {
  text: string;
  startUs: Micros;
  endUs: Micros;
}

const CUE_MAX_WORDS = 6;
const CUE_BREAK_GAP_US = 500_000;

/**
 * Auto-caption cues are DERIVED from the words that survive, every time, so they
 * can never show text for a word that was cut. A cue ends after 6 words, at
 * sentence-ending punctuation, or at a pause of 0.5 s or more in the output.
 */
export function autoCaptionCues(ctx: EngineContext, tl: Timeline): CaptionCue[] {
  const pieces = timelinePieces(ctx, tl);
  const cues: CaptionCue[] = [];
  let cur: { words: string[]; startUs: Micros; endUs: Micros } | null = null;
  const flush = (): void => {
    if (cur) cues.push({ text: cur.words.join(" "), startUs: cur.startUs, endUs: cur.endUs });
    cur = null;
  };
  for (const a of ctx.index.atoms) {
    if (a.kind !== "word") continue;
    const out = atomOutSpan(pieces, a);
    if (!out) continue;
    if (cur && (cur.words.length >= CUE_MAX_WORDS || out.startUs - cur.endUs >= CUE_BREAK_GAP_US)) flush();
    if (!cur) cur = { words: [], startUs: out.startUs, endUs: out.endUs };
    cur.words.push(a.text);
    cur.endUs = out.endUs;
    if (/[.!?]$/.test(a.text)) flush();
  }
  flush();
  return cues;
}
