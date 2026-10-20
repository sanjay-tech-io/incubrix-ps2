import { atomPos } from "./atoms";
import type { EngineContext } from "./context";
import { cursorToUs, spanToInterval, usToCursorUnchecked, type Interval } from "./cursor";
import { EngineError } from "./errors";
import { analyzeLog, type Log } from "./log";
import { buildPieces, effectRunsFromPieces, primePieces, type SpeedInterval } from "./timemap";
import type { AtomRange, CaptionStyle, Effect, EffectId, EffectParams, MusicParams, Operation, Rate, SpeedLimits, Timeline } from "./types";

/**
 * replay: timeline = f(source, atoms, log). Nothing else goes in.
 *
 * "Raw" is the working state while applying operations: plain source-time
 * intervals (easy to cut and compare). `finalize` turns it into the Timeline
 * that is stored/hashed, with positions written back as cursors.
 * Raw keeps speed regions UNCLIPPED; clipping to surviving segments happens in
 * finalize, so a restored cut brings its speed change back with it.
 *
 * Output order and source order are independent (reorder): `segs` is in OUTPUT order, each entry a
 * source interval; `speed` and effects are anchored to SOURCE positions and never move.
 */
export interface RawEffect {
  id: EffectId;
  range: AtomRange;
  params: EffectParams;
  createdInGroup: number;
}

export interface Raw {
  segs: Interval[]; // OUTPUT order; disjoint in source time
  /** segs is also sorted by source time (true until a move reorders it): enables binary search. */
  ordered: boolean;
  speed: SpeedInterval[]; // sorted by source time, non-overlapping
  effects: RawEffect[];
  pauses: AtomRange[];
  music: MusicParams | null;
  autoCaption: CaptionStyle | null;
}

export function emptyRaw(ctx: EngineContext): Raw {
  return { segs: [{ s: 0, e: ctx.source.durationUs }], ordered: true, speed: [], effects: [], pauses: [], music: null, autoCaption: null };
}

// ---------------------------------------------------------------------------
// interval helpers
// ---------------------------------------------------------------------------

/**
 * Lists sorted by source time and non-overlapping: the first interval that ends after x is found by
 * binary search. Used for the speed list always, and for segs while raw.ordered is true.
 */
function firstEndingAfter(xs: readonly Interval[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]!.e > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Remove iv from a sorted, disjoint list: O(log n) to find, O(n) to copy. */
function removeFromSorted(segs: readonly Interval[], iv: Interval): Interval[] {
  const i = firstEndingAfter(segs, iv.s);
  let j = i;
  while (j < segs.length && segs[j]!.s < iv.e) j++;
  if (i === j) return segs as Interval[];
  const first = segs[i]!;
  const last = segs[j - 1]!;
  const mid: Interval[] = [];
  if (first.s < iv.s) mid.push({ s: first.s, e: iv.s });
  if (last.e > iv.e) mid.push({ s: iv.e, e: last.e });
  return [...segs.slice(0, i), ...mid, ...segs.slice(j)];
}

/** Speed overlap rule: the new region wins; regions it overlaps are trimmed around it. rate null = back to 1x. */
function replaceSpeed(speed: readonly SpeedInterval[], iv: Interval, rate: Rate | null): SpeedInterval[] {
  const i = firstEndingAfter(speed, iv.s);
  let j = i;
  while (j < speed.length && speed[j]!.s < iv.e) j++;
  if (i === j && rate === null) return speed as SpeedInterval[];
  const mid: SpeedInterval[] = [];
  if (i < j) {
    const first = speed[i]!;
    if (first.s < iv.s) mid.push({ s: first.s, e: iv.s, rate: first.rate });
  }
  if (rate !== null) mid.push({ s: iv.s, e: iv.e, rate });
  if (i < j) {
    const last = speed[j - 1]!;
    if (last.e > iv.e) mid.push({ s: iv.e, e: last.e, rate: last.rate });
  }
  return [...speed.slice(0, i), ...mid, ...speed.slice(j)];
}

/** Cut iv out of segments in any order: linear scan (used once a reorder has made segs unordered). */
function removeLinear(segs: readonly Interval[], iv: Interval): Interval[] {
  const out: Interval[] = [];
  for (const s of segs) {
    if (iv.e <= s.s || iv.s >= s.e) out.push(s);
    else {
      if (s.s < iv.s) out.push({ s: s.s, e: iv.s });
      if (iv.e < s.e) out.push({ s: iv.e, e: s.e });
    }
  }
  return out;
}

/** Neighbours that are also contiguous in the source are one segment (canonical form: a move and its inverse cancel). */
function mergeAdjacent(segs: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.e === s.s) out[out.length - 1] = { s: last.s, e: s.e };
    else out.push(s);
  }
  return out;
}

function isSourceSorted(segs: readonly Interval[]): boolean {
  for (let i = 1; i < segs.length; i++) if (segs[i]!.s < segs[i - 1]!.s) return false;
  return true;
}

/**
 * Reorder rule (documented in DESIGN.md):
 *  - the moved material is every surviving piece inside the source span iv, as one block, KEEPING the output
 *    order those pieces currently have (so a span that covers already-moved material moves them together);
 *  - it is re-inserted immediately before the surviving material at source position `before`: if `before` falls
 *    inside a surviving segment that segment is split there; if it falls in cut material, the block goes
 *    before the next surviving material in SOURCE order; null (or nothing later survives) means the end;
 *  - `before` strictly inside the span itself is an error (a section cannot be moved into itself).
 */
function moveSpan(raw: Raw, iv: Interval, before: number | null): Raw {
  const moved: Interval[] = [];
  const rest: Interval[] = [];
  for (const seg of raw.segs) {
    const a = Math.max(seg.s, iv.s);
    const b = Math.min(seg.e, iv.e);
    if (b <= a) {
      rest.push(seg);
      continue;
    }
    if (seg.s < a) rest.push({ s: seg.s, e: a });
    moved.push({ s: a, e: b });
    if (b < seg.e) rest.push({ s: b, e: seg.e });
  }
  if (moved.length === 0) throw new EngineError("INVALID_SPAN", "nothing of that section is in the video, so there is nothing to move");
  let at = rest.length;
  if (before !== null) {
    let bestS = Number.POSITIVE_INFINITY;
    let splitAt = -1;
    for (let i = 0; i < rest.length; i++) {
      const r = rest[i]!;
      if (r.s < before && before < r.e) {
        splitAt = i;
        break;
      }
      if (r.s >= before && r.s < bestS) {
        bestS = r.s;
        at = i;
      }
    }
    if (splitAt >= 0) {
      const r = rest[splitAt]!;
      rest.splice(splitAt, 1, { s: r.s, e: before }, { s: before, e: r.e });
      at = splitAt + 1;
    }
  }
  const segs = mergeAdjacent([...rest.slice(0, at), ...moved, ...rest.slice(at)]);
  return { ...raw, segs, ordered: isSourceSorted(segs) };
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
      return { ...raw, segs: raw.ordered ? removeFromSorted(raw.segs, iv) : removeLinear(raw.segs, iv) };
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
      return { ...raw, speed: replaceSpeed(raw.speed, iv, cmpRate(rate, { num: 1, den: 1 }) === 0 ? null : rate) };
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
    case "clear_auto_caption":
      return { ...raw, autoCaption: null };
    case "set_music":
      return { ...raw, music: op.music };
    case "clear_music":
      return { ...raw, music: null };
    case "restore":
      // Realized by excluding the target group when the log is replayed (see analyzeLog); nothing to apply.
      return raw;
    case "move": {
      const iv = spanToInterval(ctx.index, op.span, ctx.fps);
      const before = op.before === null ? null : cursorToUs(ctx.index, op.before, ctx.fps, "start");
      if (before !== null && before > iv.s && before < iv.e) {
        throw new EngineError("INVALID_SPAN", "a section cannot be moved into itself: the target point is inside the section");
      }
      return moveSpan(raw, iv, before);
    }
  }
}

// ---------------------------------------------------------------------------
// raw -> Timeline
// ---------------------------------------------------------------------------

function overlapsAny(segs: readonly Interval[], s: number, e: number): boolean {
  const i = firstEndingAfter(segs, s);
  return i < segs.length && segs[i]!.s < e;
}

export function finalize(ctx: EngineContext, raw: Raw): Timeline {
  const idx = ctx.index;
  const toSpan = (iv: Interval) => ({ start: usToCursorUnchecked(idx, iv.s), end: usToCursorUnchecked(idx, iv.e) });

  // Clip speed regions to what survives; merge touching regions with the same rate so the
  // stored form does not depend on how the edits happened to be split.
  // A source-ordered view of the segments (the stored list is in output order after a reorder).
  const srcSegs = raw.ordered ? raw.segs : [...raw.segs].sort((x, y) => x.s - y.s);
  const clipped: SpeedInterval[] = [];
  let k = 0; // first speed region that can still touch this or a later segment (both lists are source-sorted)
  for (const seg of srcSegs) {
    while (k < raw.speed.length && raw.speed[k]!.e <= seg.s) k++;
    for (let m = k; m < raw.speed.length && raw.speed[m]!.s < seg.e; m++) {
      const r = raw.speed[m]!;
      const s = Math.max(r.s, seg.s);
      const e = Math.min(r.e, seg.e);
      if (e > s) clipped.push({ s, e, rate: r.rate });
    }
  }
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
    const alive = deciding.filter((x) => overlapsAny(srcSegs, x.startUs, x.endUs)).length;
    return {
      id: e.id,
      range: e.range,
      params: e.params,
      state: alive > 0 ? "active" : "inactive",
      partial: alive > 0 && alive < deciding.length,
      fragmented: alive > 0 && effectRunsFromPieces(ctx, pieces, e.range).length > 1,
      createdInGroup: e.createdInGroup,
    };
  });

  const pauses = [...raw.pauses].sort((x, y) => atomPos(idx, x.from) - atomPos(idx, y.from));

  const timeline: Timeline = {
    sourceSha256: ctx.source.sha256,
    segments: raw.segs.map((s, i) => ({ id: `seg_${i}`, span: toSpan(s) })),
    speedRegions: merged.map((r) => ({ span: toSpan(r), rate: r.rate })),
    effects,
    protectedPauses: pauses,
    music: raw.music,
    autoCaption: raw.autoCaption,
    durationUs,
  };
  primePieces(timeline, pieces);
  return timeline;
}

// ---------------------------------------------------------------------------
// whole-log replay
// ---------------------------------------------------------------------------

// Caches, keyed by the (immutable) log object. A log is never mutated: appending makes a new array.
const rawCache = new WeakMap<EngineContext, WeakMap<Log, Raw>>();
const timelineCache = new WeakMap<EngineContext, WeakMap<Log, Timeline>>();

function cacheFor<V extends object>(all: WeakMap<EngineContext, WeakMap<Log, V>>, ctx: EngineContext): WeakMap<Log, V> {
  let m = all.get(ctx);
  if (!m) {
    m = new WeakMap();
    all.set(ctx, m);
  }
  return m;
}

/** Raw state after replaying a log from scratch: groups in effect, minus restored ones, in log order. */
export function rawFromLog(ctx: EngineContext, log: Log): Raw {
  const cache = cacheFor(rawCache, ctx);
  const hit = cache.get(log);
  if (hit) return hit;
  const { active, opsByGroup, neutralized } = analyzeLog(log);
  let raw = emptyRaw(ctx);
  for (const g of active) {
    if (neutralized.has(g)) continue;
    for (const op of opsByGroup.get(g)!) raw = applyOp(ctx, raw, op, g, false);
  }
  cache.set(log, raw);
  return raw;
}

/**
 * Tell the cache what the raw state of a log is when the caller has already computed it
 * incrementally (the previous log's state plus one new group, no restore involved).
 * A property test ("session path equals fresh replay") guards that this equals rawFromLog.
 */
export function primeRaw(ctx: EngineContext, log: Log, raw: Raw): void {
  cacheFor(rawCache, ctx).set(log, raw);
}

/** The full replay (memoized per log). This is the definition of "the timeline"; everything else is an optimisation of it. */
export function materialize(ctx: EngineContext, log: Log): Timeline {
  const cache = cacheFor(timelineCache, ctx);
  const hit = cache.get(log);
  if (hit) return hit;
  const tl = finalize(ctx, rawFromLog(ctx, log));
  cache.set(log, tl);
  return tl;
}
