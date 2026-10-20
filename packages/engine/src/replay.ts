import { atomPos } from "./atoms";
import type { EngineContext } from "./context";
import { spanToInterval, usToCursor, type Interval } from "./cursor";
import { EngineError } from "./errors";
import { analyzeLog, type Log } from "./log";
import { buildPieces, type SpeedInterval } from "./timemap";
import type { AtomRange, CaptionStyle, Effect, EffectId, EffectParams, MusicParams, Operation, Rate, SpeedLimits, Timeline } from "./types";

/**
 * replay: timeline = f(source, atoms, log). Nothing else goes in.
 *
 * "Raw" is the working state while applying operations: plain source-time
 * intervals (easy to cut and compare). `finalize` turns it into the Timeline
 * that is stored/hashed, with positions written back as cursors.
 * Raw keeps speed regions UNCLIPPED; clipping to surviving segments happens in
 * finalize, so a restored cut brings its speed change back with it.
 */
export interface RawEffect {
  id: EffectId;
  range: AtomRange;
  params: EffectParams;
  createdInGroup: number;
}

export interface Raw {
  segs: Interval[]; // output order == source order until `move` exists (M4)
  speed: SpeedInterval[]; // sorted, non-overlapping
  effects: RawEffect[];
  pauses: AtomRange[];
  music: MusicParams | null;
  autoCaption: CaptionStyle | null;
}

export function emptyRaw(ctx: EngineContext): Raw {
  return { segs: [{ s: 0, e: ctx.source.durationUs }], speed: [], effects: [], pauses: [], music: null, autoCaption: null };
}

// ---------------------------------------------------------------------------
// interval helpers
// ---------------------------------------------------------------------------

/** a minus b, as 0, 1 or 2 intervals. */
function subtract(a: Interval, b: Interval): Interval[] {
  if (b.e <= a.s || b.s >= a.e) return [a];
  const out: Interval[] = [];
  if (b.s > a.s) out.push({ s: a.s, e: b.s });
  if (b.e < a.e) out.push({ s: b.e, e: a.e });
  return out;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function reduce(r: Rate): Rate {
  const g = gcd(r.num, r.den);
  return { num: r.num / g, den: r.den / g };
}

/** Compare rates exactly by cross-multiplying (no floats). */
function cmpRate(a: Rate, b: Rate): number {
  return a.num * b.den - b.num * a.den;
}

export function formatRate(r: Rate): string {
  const v = r.num / r.den; // display only, never stored
  return `${Number.isInteger(v) ? v : Number(v.toFixed(3))}x`;
}

export function checkSpeed(rate: Rate, limits: SpeedLimits): Rate {
  if (!Number.isInteger(rate.num) || !Number.isInteger(rate.den) || rate.num < 1 || rate.den < 1) {
    throw new EngineError("SPEED_OUT_OF_RANGE", `speed ${rate.num}/${rate.den} is not a positive rational`);
  }
  if (cmpRate(rate, limits.min) < 0 || cmpRate(rate, limits.max) > 0) {
    throw new EngineError(
      "SPEED_OUT_OF_RANGE",
      `speed ${formatRate(rate)} is outside the allowed range ${formatRate(limits.min)} to ${formatRate(limits.max)}`,
    );
  }
  return reduce(rate);
}

function checkRange(ctx: EngineContext, r: AtomRange): [number, number] {
  const a = atomPos(ctx.index, r.from);
  const b = atomPos(ctx.index, r.to);
  if (a > b) throw new EngineError("INVALID_RANGE", `range ${r.from}..${r.to} is backwards`);
  return [a, b];
}

function sameRange(a: AtomRange, b: AtomRange): boolean {
  return a.from === b.from && a.to === b.to;
}

// ---------------------------------------------------------------------------
// applying one operation
// ---------------------------------------------------------------------------

/**
 * Apply one operation to a raw state (returns a new state; the input is untouched).
 * strict=true is used when VALIDATING a new instruction (unknown effect ids are errors).
 * strict=false is used for replay: an op that refers to an effect which a
 * restored/undone group never created is skipped, so one restore cannot break
 * later groups. Cursor and range checks apply in both modes.
 */
export function applyOp(ctx: EngineContext, raw: Raw, op: Operation, group: number, strict: boolean): Raw {
  switch (op.type) {
    case "cut": {
      const iv = spanToInterval(ctx.index, op.span, ctx.fps);
      return { ...raw, segs: raw.segs.flatMap((s) => subtract(s, iv)) };
    }
    case "keep_only": {
      const iv = spanToInterval(ctx.index, op.span, ctx.fps);
      const segs = raw.segs
        .map((s) => ({ s: Math.max(s.s, iv.s), e: Math.min(s.e, iv.e) }))
        .filter((s) => s.e > s.s);
      return { ...raw, segs };
    }
    case "set_speed": {
      const iv = spanToInterval(ctx.index, op.span, ctx.fps);
      const rate = checkSpeed(op.rate, ctx.limits);
      // Overlap rule: the new region wins; existing regions are trimmed around it.
      const kept = raw.speed.flatMap((r) => subtract(r, iv).map((p) => ({ ...p, rate: r.rate })));
      const speed = cmpRate(rate, { num: 1, den: 1 }) === 0 ? kept : [...kept, { ...iv, rate }];
      return { ...raw, speed: speed.sort((x, y) => x.s - y.s) };
    }
    case "add_effect": {
      checkRange(ctx, op.range);
      if (raw.effects.some((e) => e.id === op.effectId)) {
        if (strict) throw new EngineError("INVALID_RANGE", `effect ${op.effectId} already exists`);
        return raw;
      }
      return { ...raw, effects: [...raw.effects, { id: op.effectId, range: op.range, params: op.params, createdInGroup: group }] };
    }
    case "update_effect": {
      const cur = raw.effects.find((e) => e.id === op.effectId);
      if (!cur) {
        if (strict) throw new EngineError("UNKNOWN_EFFECT", `there is no effect ${op.effectId}`);
        return raw;
      }
      if (cur.params.kind !== op.params.kind) {
        throw new EngineError("UNKNOWN_EFFECT", `effect ${op.effectId} is a ${cur.params.kind}; it cannot become a ${op.params.kind}`);
      }
      return { ...raw, effects: raw.effects.map((e) => (e.id === op.effectId ? { ...e, params: op.params } : e)) };
    }
    case "remove_effect": {
      if (!raw.effects.some((e) => e.id === op.effectId)) {
        if (strict) throw new EngineError("UNKNOWN_EFFECT", `there is no effect ${op.effectId}`);
        return raw;
      }
      return { ...raw, effects: raw.effects.filter((e) => e.id !== op.effectId) };
    }
    case "protect_pause": {
      const [a, b] = checkRange(ctx, op.range);
      if (ctx.index.atoms.slice(a, b + 1).some((x) => x.kind !== "silence")) {
        throw new EngineError("INVALID_RANGE", "only silence atoms can be protected as a pause");
      }
      return raw.pauses.some((p) => sameRange(p, op.range)) ? raw : { ...raw, pauses: [...raw.pauses, op.range] };
    }
    case "unprotect_pause":
      checkRange(ctx, op.range);
      return { ...raw, pauses: raw.pauses.filter((p) => !sameRange(p, op.range)) };
    case "auto_caption":
      return { ...raw, autoCaption: op.style };
    case "set_music":
      return { ...raw, music: op.music };
    case "clear_music":
      return { ...raw, music: null };
    case "restore":
      // Realized by excluding the target group when the log is replayed (see analyzeLog); nothing to apply.
      return raw;
    case "move":
      throw new EngineError("NOT_IMPLEMENTED", "reordering sections is not implemented yet (planned for M4)");
  }
}

// ---------------------------------------------------------------------------
// raw -> Timeline
// ---------------------------------------------------------------------------

function overlapsAny(segs: readonly Interval[], s: number, e: number): boolean {
  return segs.some((x) => x.s < e && x.e > s);
}

export function finalize(ctx: EngineContext, raw: Raw): Timeline {
  const idx = ctx.index;
  const toSpan = (iv: Interval) => ({ start: usToCursor(idx, iv.s, ctx.fps), end: usToCursor(idx, iv.e, ctx.fps) });

  // Clip speed regions to what survives; merge touching regions with the same rate so the
  // stored form does not depend on how the edits happened to be split.
  const clipped: SpeedInterval[] = [];
  for (const r of raw.speed) {
    for (const seg of raw.segs) {
      const s = Math.max(r.s, seg.s);
      const e = Math.min(r.e, seg.e);
      if (e > s) clipped.push({ s, e, rate: r.rate });
    }
  }
  clipped.sort((a, b) => a.s - b.s);
  const merged: SpeedInterval[] = [];
  for (const r of clipped) {
    const last = merged[merged.length - 1];
    if (last && last.e === r.s && cmpRate(last.rate, r.rate) === 0) last.e = r.e;
    else merged.push({ ...r });
  }

  const pieces = buildPieces(raw.segs, merged, ctx.fps);
  const durationUs = pieces.length === 0 ? 0 : pieces[pieces.length - 1]!.outE;

  const effects: Effect[] = raw.effects.map((e) => {
    const [a, b] = checkRange(ctx, e.range);
    const inRange = idx.atoms.slice(a, b + 1);
    const words = inRange.filter((x) => x.kind === "word");
    const deciding = words.length > 0 ? words : inRange;
    const alive = deciding.filter((x) => overlapsAny(raw.segs, x.startUs, x.endUs)).length;
    return {
      id: e.id,
      range: e.range,
      params: e.params,
      state: alive > 0 ? "active" : "inactive",
      partial: alive > 0 && alive < deciding.length,
      createdInGroup: e.createdInGroup,
    };
  });

  const pauses = [...raw.pauses].sort((x, y) => atomPos(idx, x.from) - atomPos(idx, y.from));

  return {
    sourceSha256: ctx.source.sha256,
    segments: raw.segs.map((s, i) => ({ id: `seg_${i}`, span: toSpan(s) })),
    speedRegions: merged.map((r) => ({ span: toSpan(r), rate: r.rate })),
    effects,
    protectedPauses: pauses,
    music: raw.music,
    autoCaption: raw.autoCaption,
    durationUs,
  };
}

// ---------------------------------------------------------------------------
// whole-log replay
// ---------------------------------------------------------------------------

/** Raw state after replaying a log from scratch: groups in effect, minus restored ones, in log order. */
export function rawFromLog(ctx: EngineContext, log: Log): Raw {
  const { active, opsByGroup, neutralized } = analyzeLog(log);
  let raw = emptyRaw(ctx);
  for (const g of active) {
    if (neutralized.has(g)) continue;
    for (const op of opsByGroup.get(g)!) raw = applyOp(ctx, raw, op, g, false);
  }
  return raw;
}

/** The full replay. This is the definition of "the timeline"; everything else is an optimisation of it. */
export function materialize(ctx: EngineContext, log: Log): Timeline {
  return finalize(ctx, rawFromLog(ctx, log));
}
