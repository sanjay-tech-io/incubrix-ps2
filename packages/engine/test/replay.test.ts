import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendEdit, appendRedo, appendUndo, type Log } from "../src/log";
import { materialize } from "../src/replay";
import { autoCaptionCues, buildPieces, effectDisplay, editedToSource, sourceToEdited, timelinePieces } from "../src/timemap";
import { timelineHash } from "../src/hash";
import { atomEndingAt, atomStartingAt, FACTS, makeFixture, SOURCE_SHA } from "./fixtures/transcript";
import { captionOp, cutOp, span, speedOp } from "./helpers";
import type { Operation } from "../src/types";

const { ctx, atoms } = makeFixture();
const edit = (log: Log, ...ops: Operation[]) => appendEdit(log, ops).log;

describe("materialize: the empty log", () => {
  it("is one segment covering the whole source; hash matches a hand-written canonical string", () => {
    const tl = materialize(ctx, []);
    expect(tl.durationUs).toBe(200_000_000);
    expect(tl.segments).toHaveLength(1);
    const first = atoms[0]!;
    const last = atoms[atoms.length - 1]!;
    // Written by hand from the canonical-JSON rules (sorted keys, no spaces), not produced by the code under test.
    const expected =
      `{"autoCaption":null,"durationUs":200000000,"effects":[],"music":null,"protectedPauses":[],` +
      `"segments":[{"id":"seg_0","span":{"end":{"atom":"${last.id}","offsetUs":${last.endUs - last.startUs}},"start":{"atom":"${first.id}","offsetUs":0}}}],` +
      `"sourceSha256":"${SOURCE_SHA}","speedRegions":[]}`;
    expect(timelineHash(tl)).toBe(createHash("sha256").update(expected, "utf8").digest("hex"));
  });
});

describe("cut and time mapping", () => {
  it("cutting the first 30 s (a point inside the 29.2-31.0 silence) removes exactly 30 s", () => {
    const log = edit([], cutOp(ctx, 0, 30_000_000));
    const tl = materialize(ctx, log);
    expect(tl.durationUs).toBe(170_000_000);
    expect(tl.segments).toHaveLength(1);
    // The cut point is inside a silence atom, so it is stored as that atom plus an offset: 30.0 - 29.2 = 0.8 s.
    const silence = atomEndingAt(atoms, FACTS.silenceBeforeFirstCutPoint.endUs);
    expect(silence.startUs).toBe(FACTS.silenceBeforeFirstCutPoint.startUs);
    expect(tl.segments[0]!.span.start).toEqual({ atom: silence.id, offsetUs: 800_000 });
  });

  it("maps original time to edited time and back; cut time maps to null", () => {
    const tl = materialize(ctx, edit([], cutOp(ctx, 0, 30_000_000)));
    const pieces = timelinePieces(ctx, tl);
    expect(sourceToEdited(pieces, 42_000_000)).toBe(12_000_000);
    expect(sourceToEdited(pieces, 10_000_000)).toBeNull();
    expect(editedToSource(pieces, 12_000_000)).toBe(42_000_000);
    expect(editedToSource(pieces, 0)).toBe(30_000_000);
  });

  it("two cuts leave two segments and shift later time by both", () => {
    const tl = materialize(ctx, edit(edit([], cutOp(ctx, 0, 30_000_000)), cutOp(ctx, 108_000_000, 113_000_000)));
    expect(tl.segments).toHaveLength(2);
    expect(tl.durationUs).toBe(165_000_000);
    const pieces = timelinePieces(ctx, tl);
    expect(sourceToEdited(pieces, 113_000_000)).toBe(78_000_000); // 113 - 30 - 5
    expect(sourceToEdited(pieces, 110_000_000)).toBeNull();
  });

  it("cutting the same span twice changes nothing (repeated instruction is safe)", () => {
    const once = materialize(ctx, edit([], cutOp(ctx, 30_000_000, 40_000_000)));
    const twice = materialize(ctx, edit(edit([], cutOp(ctx, 30_000_000, 40_000_000)), cutOp(ctx, 30_000_000, 40_000_000)));
    expect(twice.durationUs).toBe(once.durationUs);
    expect(twice.segments).toEqual(once.segments);
  });

  it("keep_only keeps just that span", () => {
    const keep: Operation = { type: "keep_only", span: span(ctx, 90_000_000, 100_000_000) };
    const tl = materialize(ctx, edit([], keep));
    expect(tl.durationUs).toBe(10_000_000);
    expect(tl.segments).toHaveLength(1);
  });
});

describe("speed regions", () => {
  it("2x over 18 s of source saves 9 s; later time maps with the speed-up", () => {
    const tl = materialize(ctx, edit([], speedOp(ctx, 90_000_000, 108_000_000, 2)));
    expect(tl.durationUs).toBe(191_000_000);
    const pieces = timelinePieces(ctx, tl);
    expect(sourceToEdited(pieces, 120_000_000)).toBe(111_000_000);
    expect(editedToSource(pieces, 111_000_000)).toBe(120_000_000);
    expect(sourceToEdited(pieces, 99_000_000)).toBe(94_500_000); // 90 + 9/2
  });

  it("rate is stored in lowest terms so 4/2 and 2/1 hash the same", () => {
    const a = materialize(ctx, edit([], speedOp(ctx, 90_000_000, 108_000_000, 4, 2)));
    const b = materialize(ctx, edit([], speedOp(ctx, 90_000_000, 108_000_000, 2)));
    expect(timelineHash(a)).toBe(timelineHash(b));
  });

  it("rejects a rate above the maximum, naming the allowed range", () => {
    expect(() => materialize(ctx, edit([], speedOp(ctx, 90_000_000, 108_000_000, 10)))).toThrow(/0\.25x.*4x/);
    expect(() => materialize(ctx, edit([], speedOp(ctx, 90_000_000, 108_000_000, 1, 8)))).toThrow(/0\.25x.*4x/);
  });

  it("accepts the limits themselves (4x and 0.25x)", () => {
    expect(() => materialize(ctx, edit([], speedOp(ctx, 90_000_000, 108_000_000, 4)))).not.toThrow();
    expect(() => materialize(ctx, edit([], speedOp(ctx, 90_000_000, 108_000_000, 1, 4)))).not.toThrow();
  });

  // Documented rule (DESIGN.md): the later change wins on the overlap and REPLACES the earlier rate; rates never multiply.
  it("overlap: a later 1x in the middle of a 2x leaves 2x on both sides", () => {
    const tl = materialize(ctx, edit(edit([], speedOp(ctx, 90_000_000, 108_000_000, 2)), speedOp(ctx, 95_000_000, 100_000_000, 1)));
    const rs = timelinePieces(ctx, tl);
    expect(tl.speedRegions.map((r) => r.rate)).toEqual([{ num: 2, den: 1 }, { num: 2, den: 1 }]);
    expect(rs.filter((p) => p.rate.num === 2).map((p) => [p.srcS, p.srcE])).toEqual([[90_000_000, 95_000_000], [100_000_000, 108_000_000]]);
    expect(tl.durationUs).toBe(200_000_000 - 2_500_000 - 4_000_000); // (5 s + 8 s) saved half
  });

  it("overlap: a later 3x over part of a 2x replaces (not multiplies) on the overlap", () => {
    const tl = materialize(ctx, edit(edit([], speedOp(ctx, 90_000_000, 108_000_000, 2)), speedOp(ctx, 100_000_000, 110_000_000, 3)));
    const pieces = timelinePieces(ctx, tl);
    const rates = pieces.filter((p) => p.rate.num !== 1).map((p) => [p.srcS, p.srcE, p.rate.num]);
    expect(rates).toEqual([[90_000_000, 100_000_000, 2], [100_000_000, 110_000_000, 3]]);
  });

  it("adjacent regions with the same rate merge into one region", () => {
    const tl = materialize(ctx, edit(edit([], speedOp(ctx, 90_000_000, 100_000_000, 2)), speedOp(ctx, 100_000_000, 108_000_000, 2)));
    expect(tl.speedRegions).toHaveLength(1);
  });

  it("speed over a cut area is clipped to what remains, and returns when the cut is restored", () => {
    let log = edit([], speedOp(ctx, 90_000_000, 108_000_000, 2)); // group 1
    log = edit(log, cutOp(ctx, 95_000_000, 100_000_000)); // group 2: 5 s removed, 13 s of 2x remain
    expect(materialize(ctx, log).durationUs).toBe(188_500_000); // 200 - 5 - 6.5
    log = edit(log, { type: "restore", targetGroup: 2 }); // group 3
    expect(materialize(ctx, log).durationUs).toBe(191_000_000); // 200 - 9
  });

});

describe("effects follow their words", () => {
  const welcome = atomStartingAt(atoms, FACTS.welcome.startUs);
  const channel = atomEndingAt(atoms, FACTS.welcome.endUs);
  const withCaption = edit([], captionOp("fx_0_0", welcome.id, channel.id, "Welcome!"));

  it("an effect is active and keeps its anchor after a cut before it", () => {
    const tl = materialize(ctx, edit(withCaption, cutOp(ctx, 0, 30_000_000)));
    expect(tl.effects).toHaveLength(1);
    expect(tl.effects[0]).toMatchObject({ id: "fx_0_0", state: "active", partial: false, range: { from: welcome.id, to: channel.id } });
    const d = effectDisplay(ctx, tl, tl.effects[0]!)!;
    expect([d.startUs, d.endUs]).toEqual([12_000_000, 14_000_000]);
  });

  it("is inactive (kept, not deleted) when all its words are cut", () => {
    const tl = materialize(ctx, edit(withCaption, cutOp(ctx, 41_000_000, 45_000_000)));
    expect(tl.effects).toHaveLength(1);
    expect(tl.effects[0]).toMatchObject({ state: "inactive", partial: false });
    expect(effectDisplay(ctx, tl, tl.effects[0]!)).toBeNull();
  });

  it("is partial when only some of its words are cut", () => {
    const tl = materialize(ctx, edit(withCaption, cutOp(ctx, 41_000_000, 42_500_000)));
    expect(tl.effects[0]).toMatchObject({ state: "active", partial: true });
  });

  it("a sped-up caption keeps a 0.7 s minimum visible time and says it was extended", () => {
    // 4x over 41-45 s: the 2.0 s caption would last 0.5 s.
    const tl = materialize(ctx, edit(withCaption, speedOp(ctx, 41_000_000, 45_000_000, 4)));
    const d = effectDisplay(ctx, tl, tl.effects[0]!)!;
    expect(d).toEqual({ startUs: 41_250_000, endUs: 41_950_000, extended: true });
  });

  it("a caption already longer than 0.7 s is not extended", () => {
    const tl = materialize(ctx, withCaption);
    expect(effectDisplay(ctx, tl, tl.effects[0]!)).toEqual({ startUs: 42_000_000, endUs: 44_000_000, extended: false });
  });
});

describe("log replay edge cases", () => {
  it("an invalid cursor in a logged op makes replay fail loudly", () => {
    const bad: Operation = { type: "cut", reason: "user", span: { start: { atom: atoms[2]!.id, offsetUs: 5 }, end: { atom: atoms[3]!.id, offsetUs: 0 } } };
    expect(() => materialize(ctx, edit([], bad))).toThrow(/INVALID_CURSOR/);
  });

  it("reorder is not implemented in M1 and says so", () => {
    const op: Operation = { type: "move", span: span(ctx, 0, 1_000_000), before: null };
    expect(() => materialize(ctx, edit([], op))).toThrow(/NOT_IMPLEMENTED/);
  });

  it("undo then redo of the same group gives the same timeline hash", () => {
    const base = edit([], cutOp(ctx, 0, 30_000_000));
    const redone = appendRedo(appendUndo(base));
    expect(timelineHash(materialize(ctx, redone))).toBe(timelineHash(materialize(ctx, base)));
    expect(materialize(ctx, appendUndo(base)).durationUs).toBe(200_000_000);
  });

  it("buildPieces splits a segment at speed boundaries", () => {
    const pieces = buildPieces([{ s: 0, e: 10_000_000 }], [{ s: 2_000_000, e: 4_000_000, rate: { num: 2, den: 1 } }]);
    expect(pieces.map((p) => [p.srcS, p.srcE, p.outS, p.outE])).toEqual([
      [0, 2_000_000, 0, 2_000_000],
      [2_000_000, 4_000_000, 2_000_000, 3_000_000],
      [4_000_000, 10_000_000, 3_000_000, 9_000_000],
    ]);
  });
});

describe("auto-caption text is derived from the words that survive", () => {
  it("shows a sentence as one cue at its edited time, and drops cut words from the text", () => {
    const base = edit([], cutOp(ctx, 0, 30_000_000));
    const cues = autoCaptionCues(ctx, materialize(ctx, base)).filter((c) => c.startUs >= 12_000_000 && c.startUs < 15_000_000);
    expect(cues).toEqual([{ text: "welcome to the channel.", startUs: 12_000_000, endUs: 14_000_000 }]);
    // cut just the word "welcome" (42.0-42.5): its text must disappear from the cue
    const welcome = atomStartingAt(atoms, 42_000_000);
    const to = atomStartingAt(atoms, 42_500_000);
    const cutWord = edit(base, { type: "cut", reason: "user", span: { start: { atom: welcome.id, offsetUs: 0 }, end: { atom: to.id, offsetUs: 0 } } });
    const after = autoCaptionCues(ctx, materialize(ctx, cutWord)).filter((c) => c.startUs >= 11_000_000 && c.startUs < 15_000_000);
    expect(after).toEqual([{ text: "to the channel.", startUs: 12_000_000, endUs: 13_500_000 }]);
  });
});
