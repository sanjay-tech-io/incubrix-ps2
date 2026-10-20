import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { snapBoundaryUs, spanToInterval, usToCursor, validateCursor } from "../src/cursor";
import { ceilToFrameUs, floorToFrameUs, frameStartUs, snapToFrameUs } from "../src/frames";
import { appendEdit, type Log } from "../src/log";
import { materialize } from "../src/replay";
import { findTopicParts } from "../src/search";
import { timelinePieces } from "../src/timemap";
import type { Operation } from "../src/types";
import { FACTS, makeFixture } from "./fixtures/transcript";
import { speedOp } from "./helpers";

const NTSC = { num: 30000, den: 1001 };
const fx30 = makeFixture();
const ntsc = makeFixture(undefined, NTSC);
const edit = (log: Log, ...ops: Operation[]) => appendEdit(log, ops).log;

describe("floor/ceil to the frame grid (30000/1001)", () => {
  it("floor is the last frame start <= t, ceil the first >= t, both equal t when t is on the grid", () => {
    const f2 = frameStartUs(2, NTSC); // 66733
    expect(floorToFrameUs(f2, NTSC)).toBe(f2);
    expect(ceilToFrameUs(f2, NTSC)).toBe(f2);
    expect(floorToFrameUs(f2 + 1, NTSC)).toBe(f2);
    expect(ceilToFrameUs(f2 + 1, NTSC)).toBe(frameStartUs(3, NTSC));
    expect(floorToFrameUs(f2 - 1, NTSC)).toBe(frameStartUs(1, NTSC));
    expect(ceilToFrameUs(f2 - 1, NTSC)).toBe(f2);
  });
});

describe("source-side boundaries land on the frame grid, inside a silence, never inside a word", () => {
  const idx = ntsc.ctx.index;
  const honestly = ntsc.atoms.find((a) => a.startUs === FACTS.honestly.startUs)!; // 90.000 s: silence before, word after
  const afterSentence = FACTS.honestly.endUs; // 92.000 s: word before, silence after

  it("the NTSC fixture really is off-grid at word boundaries (so these tests mean something)", () => {
    expect(snapToFrameUs(FACTS.honestly.startUs, NTSC)).not.toBe(FACTS.honestly.startUs);
  });

  it("silence -> word boundary moves EARLIER into the silence (floor); the word is untouched", () => {
    const g = snapBoundaryUs(idx, honestly.startUs, NTSC);
    expect(g).toBeLessThan(honestly.startUs);
    expect(honestly.startUs - g).toBeLessThan(33_367);
    expect(snapToFrameUs(g, NTSC)).toBe(g);
  });

  it("word -> silence boundary moves LATER into the silence (ceil)", () => {
    const g = snapBoundaryUs(idx, afterSentence, NTSC);
    expect(g).toBeGreaterThan(afterSentence);
    expect(g - afterSentence).toBeLessThan(33_367);
    expect(snapToFrameUs(g, NTSC)).toBe(g);
  });

  it("two touching words cannot be snapped: the boundary stays (the caller warns)", () => {
    const hiEnd = ntsc.atoms.find((a) => a.text === "Hi")!.endUs; // 2.4 s, next atom is the word "everyone"
    expect(snapBoundaryUs(idx, hiEnd, NTSC)).toBe(hiEnd);
    expect(() => validateCursor(idx, usToCursor(idx, hiEnd, NTSC), NTSC)).not.toThrow();
  });

  it("an unsnapped word-boundary cursor is rejected when it could have been snapped", () => {
    expect(() => validateCursor(idx, { atom: honestly.id, offsetUs: 0 }, NTSC)).toThrow(/frame grid/);
    expect(() => usToCursor(idx, honestly.startUs, NTSC)).toThrow(/frame grid/);
    const g = snapBoundaryUs(idx, honestly.startUs, NTSC);
    expect(() => usToCursor(idx, g, NTSC)).not.toThrow(); // the snapped spelling is accepted
  });

  it("30 fps fixture: boundaries already on the grid are untouched", () => {
    expect(snapBoundaryUs(fx30.ctx.index, FACTS.honestly.startUs, fx30.ctx.fps)).toBe(FACTS.honestly.startUs);
  });

  it("'remove the part about pricing' on NTSC: both ends on the grid, whole sentence removed, neighbour words untouched", () => {
    const tl = materialize(ntsc.ctx, []);
    const part = findTopicParts(ntsc.ctx, tl, "pricing")[1]!; // 108.0-110.4 + silence to 113.0
    const iv = spanToInterval(idx, part.span, NTSC);
    expect(iv.s).toBeLessThanOrEqual(FACTS.pricing[1].startUs);
    expect(iv.e).toBeGreaterThan(FACTS.pricing[1].sentenceEndUs);
    expect(iv.e).toBeLessThanOrEqual(FACTS.pricing[1].partEndUs); // floor into the silence: the next word is not clipped
    expect(snapToFrameUs(iv.s, NTSC)).toBe(iv.s);
    expect(snapToFrameUs(iv.e, NTSC)).toBe(iv.e);
    const prevWordEnd = 100_400_000; // "words." of the previous sentence
    expect(iv.s).toBeGreaterThanOrEqual(prevWordEnd);
  });
});

describe("output frames by cumulative rounding", () => {
  const k0 = 3480; // frame index of 116.0 s at 30 fps, inside the 115.4-130.0 silence
  const U = (k: number) => frameStartUs(k, { num: 30, den: 1 });
  const framesOf = (log: Log) => timelinePieces(fx30.ctx, materialize(fx30.ctx, log)).map((p) => p.outFrames);

  it("2x over two odd-length regions (31 frames each): 16, 29, 15 — total is round(exact)", () => {
    const log = edit(edit([], speedOp(fx30.ctx, U(k0), U(k0 + 31), 2)), speedOp(fx30.ctx, U(k0 + 60), U(k0 + 91), 2));
    // pieces: 3480 (1x) | 31 @2x = 15.5 | 29 (1x) | 31 @2x = 15.5 | 2429 (1x)
    expect(framesOf(log)).toEqual([3480, 16, 29, 15, 2429]);
    const tl = materialize(fx30.ctx, log);
    expect(framesOf(log).reduce((a, b) => a! + b!, 0)).toBe(5969); // exact total 5969.0 -> 5969
    expect(tl.durationUs).toBe(U(5969));
  });

  it("3/2x (1.5x) over two odd-length regions: 21, 29, 20 — exact 20.667 + 29 + 20.667 = 70.333 -> 70", () => {
    const log = edit(edit([], speedOp(fx30.ctx, U(k0), U(k0 + 31), 3, 2)), speedOp(fx30.ctx, U(k0 + 60), U(k0 + 91), 3, 2));
    const frames = framesOf(log);
    expect(frames).toEqual([3480, 21, 29, 20, 2429 + 0]);
    // the three pieces after the prefix sum to round(70.333) = 70
    expect(frames[1]! + frames[2]! + frames[3]!).toBe(70);
    expect(frames.reduce((a, b) => a! + b!, 0)).toBe(3480 + 70 + 2429);
  });

  it("a single half-frame piece rounds half up (1 frame at 2x = 0.5 -> 1)", () => {
    const log = edit([], speedOp(fx30.ctx, U(k0), U(k0 + 1), 2));
    expect(framesOf(log)).toEqual([3480, 1, 6000 - 3481]);
  });
});

// ---- independent exact arithmetic for the property test --------------------------------
// Re-implemented here from the definition (exact fractions with BigInt), not copied from src.
// A time on the frame grid is exactly k frames; any other time is the exact fraction t * num / (den * 1e6).
function framesAt(t: number, fps: { num: number; den: number }): [bigint, bigint] {
  const k = Math.round((t * fps.num) / (fps.den * 1_000_000));
  if (Math.round((k * fps.den * 1_000_000) / fps.num) === t) return [BigInt(k), 1n];
  return [BigInt(t) * BigInt(fps.num), BigInt(fps.den) * 1_000_000n];
}
function exactFramesFraction(srcS: number, srcE: number, rate: { num: number; den: number }, fps: { num: number; den: number }): [bigint, bigint] {
  const [sn, sd] = framesAt(srcS, fps);
  const [en, ed] = framesAt(srcE, fps);
  return [(en * sd - sn * ed) * BigInt(rate.den), ed * sd * BigInt(rate.num)];
}
const roundHalfUp = (n: bigint, d: bigint): bigint => (2n * n + d) / (2n * d);

describe("property: sum of piece frames equals round(total), pieces within 1 frame, cuts on the grid", () => {
  const atoms = ntsc.atoms;
  const idx = ntsc.ctx.index;
  const timeAt = (i: number): number => (i >= atoms.length ? idx.durationUs : atoms[i]!.startUs);
  const RATES = [{ num: 1, den: 4 }, { num: 1, den: 2 }, { num: 2, den: 3 }, { num: 3, den: 2 }, { num: 2, den: 1 }, { num: 3, den: 1 }, { num: 7, den: 3 }, { num: 4, den: 1 }];
  const pair = fc.tuple(fc.integer({ min: 0, max: atoms.length - 1 }), fc.integer({ min: 1, max: atoms.length })).filter(([a, b]) => a < b);
  const opArb = fc.oneof(
    pair.map(([a, b]) => ({ t: "cut" as const, a, b })),
    fc.tuple(pair, fc.integer({ min: 0, max: RATES.length - 1 })).map(([[a, b], r]) => ({ t: "speed" as const, a, b, r })),
  );

  it("holds for 150 seeded random cut-and-speed sequences on a 29.97 fps source", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 8 }), (cmds) => {
        let log: Log = [];
        for (const c of cmds) {
          const s = snapBoundaryUs(idx, timeAt(c.a), NTSC);
          const e = snapBoundaryUs(idx, timeAt(c.b), NTSC);
          if (e <= s) continue;
          const sp = { start: usToCursor(idx, s, NTSC), end: usToCursor(idx, e, NTSC) };
          const op: Operation = c.t === "cut" ? { type: "cut", span: sp, reason: "user" } : { type: "set_speed", span: sp, rate: RATES[c.r]! };
          log = edit(log, op);
        }
        const tl = materialize(ntsc.ctx, log);
        const pieces = timelinePieces(ntsc.ctx, tl);

        // exact cumulative frames computed independently, as a fraction
        let cumN = 0n;
        let cumD = 1n;
        let prevRounded = 0n;
        let sumFrames = 0n;
        for (const p of pieces) {
          const [n, d] = exactFramesFraction(p.srcS, p.srcE, p.rate, NTSC);
          const nextN = cumN * d + n * cumD;
          const nextD = cumD * d;
          const rounded = roundHalfUp(nextN, nextD);
          // frames of this piece must equal the difference of cumulative roundings
          expect(BigInt(p.outFrames!)).toBe(rounded - prevRounded);
          // and be within 1 frame of the piece's own exact length: |frames - n/d| < 1
          const diff = BigInt(p.outFrames!) * d - n;
          expect(diff < d && -diff < d).toBe(true);
          cumN = nextN;
          cumD = nextD;
          prevRounded = rounded;
          sumFrames += BigInt(p.outFrames!);
        }
        expect(sumFrames).toBe(roundHalfUp(cumN, cumD)); // sum of piece frames == round(total)
        expect(tl.durationUs).toBe(frameStartUs(Number(sumFrames), NTSC));

        // every cut boundary is on the grid, unless it cannot be snapped (two touching words)
        for (const seg of tl.segments) {
          const iv = spanToInterval(idx, seg.span, NTSC);
          for (const t of [iv.s, iv.e]) expect(snapBoundaryUs(idx, t, NTSC)).toBe(t);
        }
      }),
      { numRuns: 150, seed: 20261021 },
    );
  });
});

describe("a rate that does not divide the frame count still gives whole frames (no fps: microseconds)", () => {
  it("audio-only sources round cumulatively in microseconds", () => {
    const audio = makeFixture(undefined, { num: 30, den: 1 });
    const pieces = timelinePieces({ ...audio.ctx, fps: null }, materialize({ ...audio.ctx, fps: null }, edit([], speedOp(audio.ctx, 116_000_000, 117_033_333, 3, 2))));
    expect(pieces.every((p) => p.outFrames === null)).toBe(true);
    expect(pieces.reduce((a, p) => a + (p.outE - p.outS), 0)).toBe(pieces.at(-1)!.outE);
  });
});

describe("the cut rule warns when a boundary cannot be put on the frame grid", () => {
  it("between two touching words on a 29.97 fps source: a warning; on-grid and silence boundaries: none", async () => {
    const { snapPoint } = await import("../src/resolve");
    const hiEnd = ntsc.atoms.find((a) => a.text === "Hi")!.endUs; // 2.4 s, "Hi" | "everyone"
    const touching = snapPoint(ntsc.ctx, hiEnd);
    expect(touching.us).toBe(hiEnd);
    expect(touching.warning).toMatch(/between two words.*not on a frame boundary/);
    expect(snapPoint(ntsc.ctx, FACTS.honestly.startUs).warning).toBeUndefined(); // silence | word: moved into the silence, no warning
    expect(snapPoint(fx30.ctx, 2_400_000).warning).toBeUndefined(); // 30 fps: 2.4 s is on the grid
  });
});
