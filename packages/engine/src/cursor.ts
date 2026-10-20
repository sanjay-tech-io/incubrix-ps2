import { atomAt, atomPos, type AtomIndex } from "./atoms";
import { EngineError } from "./errors";
import { snapToFrameUs, type Fps } from "./frames";
import type { Cursor, Micros, Span } from "./types";

/** A region of the source in absolute microseconds, [s, e). Internal working form; the log stores Spans. */
export interface Interval {
  s: Micros;
  e: Micros;
}

export type CursorRole = "start" | "end";

/**
 * Cursor rules (decision recorded in CLAUDE.md):
 *  - offset is an integer with 0 <= offset < atom length;
 *  - a word atom only allows offset 0 (a cut never lands inside a word);
 *  - an offset > 0 inside a silence atom must sit on the frame grid;
 *  - the end of the source is written as (last atom, its length) and is allowed
 *    only as an END cursor, because a half-open span needs some way to say "to the end".
 * Offset 0 is a content boundary and is exempt from the grid: it is anchored to
 * the atom, and the renderer does the final rounding (tolerance 1 frame).
 */
export function validateCursor(idx: AtomIndex, c: Cursor, fps: Fps | null, role: CursorRole = "start"): void {
  const pos = atomPos(idx, c.atom);
  const atom = idx.atoms[pos]!;
  if (!Number.isInteger(c.offsetUs) || c.offsetUs < 0) {
    throw new EngineError("INVALID_CURSOR", `offset ${c.offsetUs} must be a non-negative integer`);
  }
  const len = atom.endUs - atom.startUs;
  if (c.offsetUs === len && role === "end" && pos === idx.atoms.length - 1) return; // end of source
  if (c.offsetUs >= len) {
    throw new EngineError("INVALID_CURSOR", `offset ${c.offsetUs} is outside atom ${c.atom} (length ${len})`);
  }
  if (c.offsetUs === 0) return;
  if (atom.kind === "word") {
    throw new EngineError("INVALID_CURSOR", `a cursor cannot be inside the word "${atom.text}" (offset ${c.offsetUs})`);
  }
  if (fps !== null) {
    const abs = atom.startUs + c.offsetUs;
    if (snapToFrameUs(abs, fps) !== abs) {
      throw new EngineError("INVALID_CURSOR", `time ${abs} is not on the frame grid ${fps.num}/${fps.den}`);
    }
  }
}

export function cursorToUs(idx: AtomIndex, c: Cursor, fps: Fps | null, role: CursorRole = "start"): Micros {
  validateCursor(idx, c, fps, role);
  return idx.atoms[atomPos(idx, c.atom)]!.startUs + c.offsetUs;
}

/**
 * Canonical cursor for a time: a boundary between atoms is (next atom, 0), so
 * there is exactly one spelling per position. t == duration is (last atom, its length).
 */
export function usToCursor(idx: AtomIndex, t: Micros, fps: Fps | null): Cursor {
  if (t === idx.durationUs) {
    const last = idx.atoms[idx.atoms.length - 1]!;
    return { atom: last.id, offsetUs: last.endUs - last.startUs };
  }
  const atom = atomAt(idx, t);
  const c: Cursor = { atom: atom.id, offsetUs: t - atom.startUs };
  validateCursor(idx, c, fps, "start");
  return c;
}

export function spanToInterval(idx: AtomIndex, span: Span, fps: Fps | null): Interval {
  const s = cursorToUs(idx, span.start, fps, "start");
  const e = cursorToUs(idx, span.end, fps, "end");
  if (e <= s) throw new EngineError("INVALID_SPAN", `span end (${e}) must be after its start (${s})`);
  return { s, e };
}
