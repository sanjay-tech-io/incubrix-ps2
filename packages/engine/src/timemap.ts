import { atomPos } from "./atoms";
import type { EngineContext } from "./context";
import { spanToInterval, type Interval } from "./cursor";
import { divRound } from "./frames";
import type { Atom, Effect, Micros, Rate, Timeline } from "./types";

/**
 * Time mapping between ORIGINAL (source) time and EDITED (output) time.
 *
 * The edited timeline is a list of pieces, in output order. Each piece is a
 * stretch of source played at one constant rate. Within a piece, output time
 * is linear in source time, so mapping is one multiply/divide.
 * Rounding: every piece's output length is rounded to the nearest microsecond
 * (error at most 0.5 us per piece, far below a frame); the same rounding is
 * used for the total, so the sum of pieces IS timeline.durationUs.
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
}

const ONE: Rate = { num: 1, den: 1 };

/** segs and speed must each be sorted and non-overlapping (replay guarantees this). */
export function buildPieces(segs: readonly Interval[], speed: readonly SpeedInterval[]): Piece[] {
  const pieces: Piece[] = [];
  let out = 0;
  const push = (srcS: number, srcE: number, rate: Rate): void => {
    const outLen = divRound((srcE - srcS) * rate.den, rate.num);
    pieces.push({ srcS, srcE, outS: out, outE: out + outLen, rate });
    out += outLen;
  };
  for (const seg of segs) {
    let at = seg.s;
    for (const sp of speed) {
      if (sp.e <= seg.s || sp.s >= seg.e) continue;
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
  return buildPieces(segs, speed);
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
