import { atomAt } from "./atoms";
import type { EngineContext } from "./context";
import { usToCursor, type Interval } from "./cursor";
import { EngineError } from "./errors";
import { divRound, snapToFrameUs } from "./frames";
import { timelinePieces } from "./timemap";
import type { Effect, Micros, Span, Timeline } from "./types";

/** m:ss.mmm, for answers and warnings. */
export function formatTime(us: Micros): string {
  const totalMs = Math.round(us / 1000);
  const ms = totalMs % 1000;
  const totalS = (totalMs - ms) / 1000;
  const s = totalS % 60;
  const m = (totalS - s) / 60;
  return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export interface SnapResult {
  us: Micros;
  warning?: string;
}

/**
 * The cut rule (CLAUDE.md): a cut point inside a silence is exact (snapped to the
 * frame grid); a cut point inside a word moves to the edge of a nearby silence
 * and the user is warned. Cutting through a word would leave a clipped syllable.
 * A point that is already an atom boundary is left alone.
 */
export function snapPoint(ctx: EngineContext, t: Micros): SnapResult {
  const idx = ctx.index;
  if (t <= 0) return { us: 0 };
  if (t >= idx.durationUs) return { us: idx.durationUs };
  const atom = atomAt(idx, t);
  if (t === atom.startUs) return { us: t };

  if (atom.kind === "silence") {
    const snapped = ctx.fps ? snapToFrameUs(t, ctx.fps) : t;
    return { us: Math.min(atom.endUs, Math.max(atom.startUs, snapped)) };
  }

  const pos = idx.byId.get(atom.id)!;
  const prev = idx.atoms[pos - 1];
  const next = idx.atoms[pos + 1];
  const edges = [
    { us: atom.startUs, silence: prev?.kind === "silence" },
    { us: atom.endUs, silence: next?.kind === "silence" },
  ];
  const nearSilence = edges.filter((e) => e.silence);
  const pool = nearSilence.length > 0 ? nearSilence : edges;
  const best = pool.reduce((a, b) => (Math.abs(a.us - t) <= Math.abs(b.us - t) ? a : b));
  const why = nearSilence.length > 0 ? "the nearest silence" : "the nearest word edge (no silence nearby)";
  return {
    us: best.us,
    warning: `${formatTime(t)} is inside the word "${atom.text}", so the cut point moved to ${formatTime(best.us)}, ${why}.`,
  };
}

export interface ResolvedRange {
  /** One span per stretch of source; more than one when the edited range straddles removed material. */
  spans: Span[];
  warnings: string[];
}

/**
 * Time policy "current": turn an EDITED-timeline range into source spans.
 * The edited range [startUs, endUs) is walked piece by piece, so a range that
 * covers a removed gap comes back as two spans (the gap itself is not included).
 * Only the two outer ends can fall inside a word; they follow the cut rule.
 */
export function resolveEditedRange(ctx: EngineContext, tl: Timeline, startUs: Micros, endUs: Micros): ResolvedRange {
  if (!Number.isInteger(startUs) || !Number.isInteger(endUs)) throw new EngineError("INVALID_SPAN", "times must be whole microseconds");
  if (startUs < 0 || endUs > tl.durationUs) {
    throw new EngineError("INVALID_SPAN", `${formatTime(startUs)}-${formatTime(endUs)} is outside the edited video, which lasts ${formatTime(tl.durationUs)}`);
  }
  if (endUs <= startUs) throw new EngineError("INVALID_SPAN", `the range ${formatTime(startUs)}-${formatTime(endUs)} is empty`);

  const warnings: string[] = [];
  const ivs: Interval[] = [];
  let interiorStart = false;
  let interiorEnd = false;
  for (const p of timelinePieces(ctx, tl)) {
    if (p.outE <= startUs || p.outS >= endUs) continue;
    const lo = Math.max(startUs, p.outS);
    const hi = Math.min(endUs, p.outE);
    const s = lo === p.outS ? p.srcS : Math.min(p.srcE, p.srcS + divRound((lo - p.outS) * p.rate.num, p.rate.den));
    const e = hi === p.outE ? p.srcE : Math.min(p.srcE, p.srcS + divRound((hi - p.outS) * p.rate.num, p.rate.den));
    if (ivs.length === 0) interiorStart = lo > p.outS;
    interiorEnd = hi < p.outE;
    const last = ivs[ivs.length - 1];
    if (last && last.e === s) last.e = e;
    else ivs.push({ s, e });
  }
  if (ivs.length === 0) throw new EngineError("INVALID_SPAN", "nothing of the edited video falls in that range");

  if (interiorStart) {
    const r = snapPoint(ctx, ivs[0]!.s);
    ivs[0]!.s = r.us;
    if (r.warning) warnings.push(r.warning);
  }
  if (interiorEnd) {
    const r = snapPoint(ctx, ivs[ivs.length - 1]!.e);
    ivs[ivs.length - 1]!.e = r.us;
    if (r.warning) warnings.push(r.warning);
  }
  const good = ivs.filter((iv) => iv.e > iv.s);
  if (good.length === 0) throw new EngineError("INVALID_SPAN", "after moving the cut points off the words, nothing is left in that range");
  return { spans: good.map((iv) => ({ start: usToCursor(ctx.index, iv.s, ctx.fps), end: usToCursor(ctx.index, iv.e, ctx.fps) })), warnings };
}

/** Time policy "original": times refer to the untouched source. */
export function resolveOriginalRange(ctx: EngineContext, startUs: Micros, endUs: Micros): ResolvedRange {
  if (!Number.isInteger(startUs) || !Number.isInteger(endUs)) throw new EngineError("INVALID_SPAN", "times must be whole microseconds");
  if (startUs < 0 || endUs > ctx.source.durationUs) {
    throw new EngineError("INVALID_SPAN", `${formatTime(startUs)}-${formatTime(endUs)} is outside the original video, which lasts ${formatTime(ctx.source.durationUs)}`);
  }
  if (endUs <= startUs) throw new EngineError("INVALID_SPAN", `the range ${formatTime(startUs)}-${formatTime(endUs)} is empty`);
  const a = snapPoint(ctx, startUs);
  const b = snapPoint(ctx, endUs);
  const warnings = [a.warning, b.warning].filter((w): w is string => w !== undefined);
  if (b.us <= a.us) throw new EngineError("INVALID_SPAN", "after moving the cut points off the words, nothing is left in that range");
  return { spans: [{ start: usToCursor(ctx.index, a.us, ctx.fps), end: usToCursor(ctx.index, b.us, ctx.fps) }], warnings };
}

/**
 * "that caption", "the caption": resolve a reference to an effect of one kind.
 *  - exactly one active effect of that kind -> it is the answer;
 *  - none -> `none` (the caller rejects, e.g. "make it bigger" with no caption);
 *  - several -> `ambiguous`, and the caller must ask which (never guess).
 * Inactive effects (all words cut) are not candidates.
 */
export type EffectLookup = { kind: "one"; effect: Effect } | { kind: "none" } | { kind: "ambiguous"; candidates: Effect[] };

export function findEffect(tl: Timeline, effectKind: Effect["params"]["kind"]): EffectLookup {
  const found = tl.effects.filter((e) => e.state === "active" && e.params.kind === effectKind);
  if (found.length === 0) return { kind: "none" };
  if (found.length === 1) return { kind: "one", effect: found[0]! };
  return { kind: "ambiguous", candidates: found };
}
