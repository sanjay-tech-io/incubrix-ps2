import { atomAt, atomPos } from "./atoms";
import type { EngineContext } from "./context";
import { snapBoundaryUs, spanToInterval, usToCursor, type Interval } from "./cursor";
import { EngineError } from "./errors";
import { ceilToFrameUs, floorToFrameUs } from "./frames";
import { nextEffectId, type Log } from "./log";
import { formatTime, gridWarnings, resolveEditedRange, snapPoint } from "./resolve";
import { atomOutSpan, editedToSource, timelinePieces } from "./timemap";
import type { AtomRange, Cursor, Effect, Operation, Timeline } from "./types";

/**
 * Planners: pure functions that turn a request ("remove the fillers", "remove silences longer than 2 s",
 * "move this section to the end") into the structured operations to log, plus the warnings that go into the
 * answer. They never change anything themselves; the session layer validates and logs the operations.
 * Every planner that builds spans returns the same grid warnings as snapPoint.
 */
export interface Plan {
  operations: Operation[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

const survivingCache = new WeakMap<Timeline, Interval[]>();

/** Surviving source intervals, sorted by source time (output order can differ after a reorder). */
export function survivingIntervals(ctx: EngineContext, tl: Timeline): Interval[] {
  const hit = survivingCache.get(tl);
  if (hit) return hit;
  const ivs = tl.segments.map((s) => spanToInterval(ctx.index, s.span, ctx.fps)).sort((a, b) => a.s - b.s);
  survivingCache.set(tl, ivs);
  return ivs;
}

/** Index of the first interval (sorted, disjoint) that ends after x. */
function firstEndingAfter(ivs: readonly Interval[], x: number): number {
  let lo = 0;
  let hi = ivs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ivs[mid]!.e > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Is [s, e) entirely inside surviving material? */
function covers(ivs: readonly Interval[], s: number, e: number): boolean {
  const iv = ivs[firstEndingAfter(ivs, s)];
  return iv !== undefined && iv.s <= s && iv.e >= e;
}

function protectedPositions(ctx: EngineContext, tl: Timeline): Set<number> {
  const set = new Set<number>();
  for (const r of tl.protectedPauses) {
    const b = atomPos(ctx.index, r.to);
    for (let i = atomPos(ctx.index, r.from); i <= b; i++) set.add(i);
  }
  return set;
}

function cursorOf(ctx: EngineContext, us: number): Cursor {
  return usToCursor(ctx.index, us, ctx.fps);
}

function cutOp(ctx: EngineContext, s: number, e: number, reason: "filler" | "silence"): Operation {
  return { type: "cut", reason, span: { start: cursorOf(ctx, s), end: cursorOf(ctx, e) } };
}

// ---------------------------------------------------------------------------
// remove fillers
// ---------------------------------------------------------------------------

export interface FillerOptions {
  /** A silence right after a removed filler is removed with it if it is at most this long (default 0.5 s), so no double pause is left. */
  tailMaxUs?: number;
}
export const DEFAULT_FILLER_TAIL_MAX_US = 500_000;

/**
 * Remove filler words (the atoms flagged \`filler\`: um, uh, and a "like" judged to be a filler by isFillerLike).
 *  - a filler that carries a mute or bleep (it is inside the range of an active mute/bleep effect) is KEPT and the
 *    answer says so: the user explicitly marked those words, filler removal must not silently undo that;
 *  - a filler inside pinned (protected) material is not touched either; only silence atoms can be pinned, so in
 *    practice this protects the pause right after a filler from being swallowed with it;
 *  - cuts are whole words (never inside one), boundaries snapped into the neighbouring silence on the frame grid;
 *  - consecutive fillers become one cut.
 */
export function planRemoveFillers(ctx: EngineContext, tl: Timeline, options: FillerOptions = {}): Plan {
  const tailMax = options.tailMaxUs ?? DEFAULT_FILLER_TAIL_MAX_US;
  const atoms = ctx.index.atoms;
  const pieces = timelinePieces(ctx, tl);
  const alive = survivingIntervals(ctx, tl);
  const pinned = protectedPositions(ctx, tl);
  const masks = tl.effects
    .filter((e) => e.state === "active" && (e.params.kind === "mute" || e.params.kind === "bleep"))
    .map((e) => ({ kind: e.params.kind, a: atomPos(ctx.index, e.range.from), b: atomPos(ctx.index, e.range.to) }));

  const warnings: string[] = [];
  const ivs: Interval[] = [];
  atoms.forEach((a, i) => {
    if (a.kind !== "word" || !a.filler) return;
    const out = atomOutSpan(pieces, a);
    if (!out) return;
    const mask = masks.find((m) => i >= m.a && i <= m.b);
    if (mask) {
      warnings.push(`Kept the filler "${a.text}" at ${formatTime(out.startUs)}: it is inside a ${mask.kind} you added, so it was not removed.`);
      return;
    }
    let end = a.endUs;
    const next = atoms[i + 1];
    if (next && next.kind === "silence" && next.endUs - next.startUs <= tailMax && !pinned.has(i + 1) && covers(alive, next.startUs, next.endUs)) end = next.endUs;
    const last = ivs[ivs.length - 1];
    if (last && last.e === a.startUs) last.e = end;
    else ivs.push({ s: a.startUs, e: end });
  });

  const bounds = ivs.map((iv) => ({ s: snapBoundaryUs(ctx.index, iv.s, ctx.fps), e: snapBoundaryUs(ctx.index, iv.e, ctx.fps) }));
  warnings.push(...gridWarnings(ctx, bounds.flatMap((b) => [b.s, b.e])));
  return { operations: bounds.map((b) => cutOp(ctx, b.s, b.e, "filler")), warnings };
}

// ---------------------------------------------------------------------------
// remove silences
// ---------------------------------------------------------------------------

export interface SilenceOptions {
  /** Remove silences LONGER than this (the user's N seconds), in microseconds. */
  minUs: number;
  /** Silence kept next to speech on each side so cuts do not sound abrupt. Documented setting; default 0.15 s. */
  padUs?: number;
}
export const DEFAULT_SILENCE_PAD_US = 150_000;

/**
 * Remove silences longer than N. For each surviving stretch of a silence atom longer than N, cut it down to
 * \`pad\` on each side that touches speech (sides that touch a cut, or the start/end of the video, keep none).
 * Pinned pauses (protect_pause) are never touched; the answer counts how many were kept. Cut ends are put on the
 * frame grid inside the silence, so the pad is never shorter than requested. The pad is decided from the
 * neighbours in the SOURCE (a reorder can put other material next to a pause).
 */
export function planRemoveSilences(ctx: EngineContext, tl: Timeline, options: SilenceOptions): Plan {
  if (!Number.isInteger(options.minUs) || options.minUs <= 0) throw new EngineError("INVALID_RANGE", "the minimum silence length must be a positive number of microseconds");
  const pad = options.padUs ?? DEFAULT_SILENCE_PAD_US;
  const atoms = ctx.index.atoms;
  const alive = survivingIntervals(ctx, tl);
  const pinned = protectedPositions(ctx, tl);
  const duration = ctx.index.durationUs;
  const ops: Operation[] = [];
  let keptPinned = 0;

  atoms.forEach((a, i) => {
    if (a.kind !== "silence") return;
    // surviving pieces of this atom
    for (let k = firstEndingAfter(alive, a.startUs); k < alive.length && alive[k]!.s < a.endUs; k++) {
      const seg = alive[k]!;
      const s0 = Math.max(seg.s, a.startUs);
      const e0 = Math.min(seg.e, a.endUs);
      if (e0 <= s0 || e0 - s0 <= options.minUs) continue;
      if (pinned.has(i)) {
        keptPinned++;
        continue;
      }
      const padS = s0 === a.startUs && atoms[i - 1]?.kind === "word" ? pad : 0;
      const padE = e0 === a.endUs && atoms[i + 1]?.kind === "word" ? pad : 0;
      let s = s0 + padS;
      let e = e0 - padE;
      if (ctx.fps) {
        if (s !== 0) s = ceilToFrameUs(s, ctx.fps);
        if (e !== duration) e = floorToFrameUs(e, ctx.fps);
      }
      if (e > s) ops.push(cutOp(ctx, s, e, "silence"));
    }
  });
  const warnings: string[] = [];
  if (keptPinned > 0) warnings.push(`Kept ${keptPinned} long pause${keptPinned === 1 ? "" : "s"} because ${keptPinned === 1 ? "it is" : "they are"} pinned.`);
  return { operations: ops, warnings };
}

// ---------------------------------------------------------------------------
// reorder
// ---------------------------------------------------------------------------

/**
 * "Move edited 1:00-1:30 to the end / before edited 2:00." Times are in the CURRENT edited timeline.
 * An edited range that straddles removed material becomes one move per stretch, all inserted before the same
 * target, so they keep their order. Boundary snapping and its warnings are the same as for a cut.
 * targetUs = null means "to the end".
 */
export function planMoveEdited(ctx: EngineContext, tl: Timeline, startUs: number, endUs: number, targetUs: number | null): Plan {
  const range = resolveEditedRange(ctx, tl, startUs, endUs);
  const warnings = [...range.warnings];
  let before: Cursor | null = null;
  if (targetUs !== null && targetUs < tl.durationUs) {
    if (targetUs < 0) throw new EngineError("INVALID_SPAN", `${formatTime(targetUs)} is before the start of the video`);
    if (targetUs > startUs && targetUs < endUs) throw new EngineError("INVALID_SPAN", "a section cannot be moved into itself: the target is inside the section");
    const src = editedToSource(timelinePieces(ctx, tl), targetUs);
    const snapped = snapPoint(ctx, src);
    if (snapped.warning) warnings.push(snapped.warning);
    before = cursorOf(ctx, snapped.us);
  } else if (targetUs !== null && targetUs > tl.durationUs) {
    throw new EngineError("INVALID_SPAN", `${formatTime(targetUs)} is after the end of the edited video, which lasts ${formatTime(tl.durationUs)}`);
  }
  return { operations: range.spans.map((span) => ({ type: "move", span, before })), warnings };
}

// ---------------------------------------------------------------------------
// effects: mute, bleep, caption edits, pinned pauses
// ---------------------------------------------------------------------------

/** Mute or bleep the words of a range. Low-confidence words in the range are reported by the session layer's warning. */
export function planMuteOrBleep(log: Log, range: AtomRange, kind: "mute" | "bleep"): Operation {
  return { type: "add_effect", effectId: nextEffectId(log), range, params: { kind } };
}

export interface CaptionPatch {
  text?: string;
  /** "#rrggbb", lowercase. */
  color?: string;
  sizePt?: number;
  bold?: boolean;
  position?: "top" | "center" | "bottom";
}

/** "Make that caption red / bigger / move it to the top / change its text": one update_effect carrying the new look. */
export function planUpdateCaption(effect: Effect, patch: CaptionPatch): Operation {
  const p = effect.params;
  if (p.kind !== "caption" && p.kind !== "text_overlay") throw new EngineError("UNKNOWN_EFFECT", `effect ${effect.id} is a ${p.kind}, not a caption`);
  if (patch.color !== undefined && !/^#[0-9a-f]{6}$/.test(patch.color)) throw new EngineError("INVALID_RANGE", `colour ${patch.color} must look like #rrggbb`);
  if (patch.sizePt !== undefined && (!Number.isInteger(patch.sizePt) || patch.sizePt < 1 || patch.sizePt > 400)) throw new EngineError("INVALID_RANGE", `size ${patch.sizePt} must be a whole number from 1 to 400`);
  const style = {
    color: patch.color ?? p.style.color,
    sizePt: patch.sizePt ?? p.style.sizePt,
    bold: patch.bold ?? p.style.bold,
  };
  return {
    type: "update_effect",
    effectId: effect.id,
    params: { kind: p.kind, text: patch.text ?? p.text, style, position: patch.position ?? p.position },
  };
}

/** Pin the pause playing at an EDITED time so silence removal leaves it alone. Rejects times inside speech. */
export function planProtectPause(ctx: EngineContext, tl: Timeline, atEditedUs: number): Operation {
  if (atEditedUs < 0 || atEditedUs >= tl.durationUs) {
    throw new EngineError("INVALID_SPAN", `${formatTime(atEditedUs)} is outside the edited video, which lasts ${formatTime(tl.durationUs)}`);
  }
  const src = editedToSource(timelinePieces(ctx, tl), atEditedUs);
  const atom = src < ctx.index.durationUs ? atomAt(ctx.index, src) : undefined;
  if (!atom || atom.kind !== "silence") throw new EngineError("INVALID_RANGE", `${formatTime(atEditedUs)} is inside speech, not a pause`);
  return { type: "protect_pause", range: { from: atom.id, to: atom.id } };
}
