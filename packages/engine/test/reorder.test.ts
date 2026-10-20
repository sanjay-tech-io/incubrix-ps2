import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cursorToUs, spanToInterval, usToCursor } from "../src/cursor";
import { EngineError } from "../src/errors";
import { timelineHash } from "../src/hash";
import { appendEdit, nextEffectId, type Log } from "../src/log";
import { materialize } from "../src/replay";
import { planMoveEdited } from "../src/plan";
import { currentTimeline, newSession, submitOperations, submitRedo, submitUndo } from "../src/session";
import { autoCaptionCues, editedToSource, effectDisplay, sourceToEdited, timelinePieces } from "../src/timemap";
import type { Operation } from "../src/types";
import { deepFreeze } from "./freeze";
import { atomEndingAt, atomStartingAt, makeFixture } from "./fixtures/transcript";
import { captionOp, cutOp, span, speedOp } from "./helpers";

const { ctx, atoms } = makeFixture();
const U = 1_000_000;
const edit = (log: Log, ...ops: Operation[]) => appendEdit(log, ops).log;
const at = (us: number) => usToCursor(ctx.index, us, ctx.fps);
const moveOp = (s: number, e: number, before: number | null): Operation => ({ type: "move", span: span(ctx, s, e), before: before === null ? null : at(before) });
const segsUs = (log: Log) => materialize(ctx, log).segments.map((s) => [cursorToUs(ctx.index, s.span.start, ctx.fps), cursorToUs(ctx.index, s.span.end, ctx.fps, "end")]);

// Fixture facts used below: sentence "Honestly the speed is great." = 90.0-92.0 (words 0.4 s each),
// silence 92.0-98.0, sentence "Captions are generated from your words." = 98.0-100.4, silence 100.4-108.0.

describe("reorder: move a section before a point, or to the end", () => {
  const A = moveOp(90 * U, 92 * U, 98 * U);

  it("moves 90-92 to just before 98: output order [0,90) [92,98) [90,92) [98,200); length unchanged", () => {
    const log = edit([], A);
    expect(segsUs(log)).toEqual([[0, 90 * U], [92 * U, 98 * U], [90 * U, 92 * U], [98 * U, 200 * U]]);
    expect(materialize(ctx, log).durationUs).toBe(200 * U);
  });

  it("time mapping follows: original 90 plays at 96, original 92 plays at 90, and back", () => {
    const pieces = timelinePieces(ctx, materialize(ctx, edit([], A)));
    expect(sourceToEdited(pieces, 90 * U)).toBe(96 * U);
    expect(sourceToEdited(pieces, 92 * U)).toBe(90 * U);
    expect(sourceToEdited(pieces, 98 * U)).toBe(98 * U);
    expect(sourceToEdited(pieces, 89 * U)).toBe(89 * U);
    expect(editedToSource(pieces, 96 * U)).toBe(90 * U);
    expect(editedToSource(pieces, 93 * U)).toBe(95 * U);
    expect(editedToSource(pieces, 97 * U)).toBe(91 * U);
  });

  it("before = null moves the section to the end", () => {
    const log = edit([], moveOp(90 * U, 92 * U, null));
    expect(segsUs(log)).toEqual([[0, 90 * U], [92 * U, 200 * U], [90 * U, 92 * U]]);
    const pieces = timelinePieces(ctx, materialize(ctx, log));
    expect(sourceToEdited(pieces, 90 * U)).toBe(198 * U);
    expect(sourceToEdited(pieces, 199 * U)).toBe(197 * U);
  });

  it("moving a section back where it came from gives the identical timeline hash (segments are canonical)", () => {
    const back = moveOp(90 * U, 92 * U, 92 * U); // before the material that now follows it in the source
    expect(timelineHash(materialize(ctx, edit(edit([], A), back)))).toBe(timelineHash(materialize(ctx, [])));
  });

  it("moving a section before its own end changes nothing, and the answer says so", () => {
    const t = submitOperations(ctx, newSession(), "no-op", [moveOp(90 * U, 92 * U, 92 * U)]);
    expect(t.answer.status).toBe("applied");
    expect(t.answer.warnings.join(" ")).toMatch(/nothing changed/i);
  });

  it("a target inside the section itself is rejected", () => {
    const t = submitOperations(ctx, newSession(), "into itself", [moveOp(90 * U, 98 * U, 94 * U)]); // 94.0 is inside the silence 92-98
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/into itself/);
    expect(t.state.log).toEqual([]);
  });

  it("moving a section that is not in the video is rejected", () => {
    const log = edit([], cutOp(ctx, 90 * U, 92 * U));
    const t = submitOperations(ctx, { log, conversation: [] }, "move cut stuff", [moveOp(90 * U, 92 * U, 98 * U)]);
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/nothing of that section/);
  });

  it("(c) target inside CUT material: the section goes before the next surviving material in source order", () => {
    // cut 102-112 (both ends inside silences), then move 90-92 to "before 105" which is now cut
    const log = edit(edit([], cutOp(ctx, 102 * U, 112 * U)), moveOp(90 * U, 92 * U, 105 * U));
    expect(segsUs(log)).toEqual([[0, 90 * U], [92 * U, 102 * U], [90 * U, 92 * U], [112 * U, 200 * U]]);
    const pieces = timelinePieces(ctx, materialize(ctx, log));
    expect(sourceToEdited(pieces, 90 * U)).toBe(100 * U);
    expect(sourceToEdited(pieces, 112 * U)).toBe(102 * U);
  });

  it("(c) a cut that spans material that has been moved removes it wherever it now is, same result as cutting first", () => {
    const moveThenCut = edit(edit([], A), cutOp(ctx, 84_400_000, 98 * U)); // 84.4-98.0 covers the section's old and new places
    const cutOnly = edit([], cutOp(ctx, 84_400_000, 98 * U));
    expect(segsUs(moveThenCut)).toEqual([[0, 84_400_000], [98 * U, 200 * U]]);
    expect(timelineHash(materialize(ctx, moveThenCut))).toBe(timelineHash(materialize(ctx, cutOnly)));
  });

  it("(c) a cut strictly inside moved material leaves both remainders, in place (the unordered-list cut path)", () => {
    const log = edit(edit([], A), cutOp(ctx, 93 * U, 95 * U)); // inside the silence 92-98, which now plays at 90-96
    expect(segsUs(log)).toEqual([[0, 90 * U], [92 * U, 93 * U], [95 * U, 98 * U], [90 * U, 92 * U], [98 * U, 200 * U]]);
    expect(materialize(ctx, log).durationUs).toBe(198 * U);
    // the same cut on the reordered video and on the original gives the same set of surviving source material
    const plain = segsUs(edit([], cutOp(ctx, 93 * U, 95 * U)));
    expect(plain).toEqual([[0, 93 * U], [95 * U, 200 * U]]);
  });

  it("(c) a move whose span covers already-moved material moves it as one block, keeping its current order", () => {
    // after A the order is [0,90) [92,98) [90,92) [98,200); now move source 90-100.4 (covers [92,98), [90,92), and the first sentence of 98-100.4)
    const log = edit(edit([], A), moveOp(90 * U, 100_400_000, null));
    expect(segsUs(log)).toEqual([[0, 90 * U], [100_400_000, 200 * U], [92 * U, 98 * U], [90 * U, 92 * U], [98 * U, 100_400_000]]);
  });
});

describe("(a) speed regions stay attached to their source atoms", () => {
  it("2x on 90-92 still applies to that material after it is moved; the region itself does not change", () => {
    const sped = edit([], speedOp(ctx, 90 * U, 92 * U, 2));
    const moved = edit(sped, moveOp(90 * U, 92 * U, 98 * U));
    const before = materialize(ctx, sped);
    const after = materialize(ctx, moved);
    expect(after.speedRegions).toEqual(before.speedRegions);
    expect(after.durationUs).toBe(199 * U);
    const pieces = timelinePieces(ctx, after);
    expect(sourceToEdited(pieces, 90 * U)).toBe(96 * U);
    expect(sourceToEdited(pieces, 91 * U)).toBe(96_500_000); // 1 s of source at 2x = 0.5 s
    expect(sourceToEdited(pieces, 98 * U)).toBe(97 * U); // the section now lasts 1 s
  });

  it("speed applied AFTER the move still lands on the right material", () => {
    const log = edit(edit([], moveOp(90 * U, 92 * U, 98 * U)), speedOp(ctx, 90 * U, 92 * U, 2));
    expect(materialize(ctx, log).durationUs).toBe(199 * U);
  });
});

describe("(b) effects after a reorder", () => {
  const first = atomStartingAt(atoms, 90 * U);
  const great = atomEndingAt(atoms, 92 * U);

  it("a caption on moved words keeps following them (shown at the new place, summary says how far it moved)", () => {
    const s0 = submitOperations(ctx, newSession(), "caption", [captionOp(nextEffectId([]), first.id, great.id, "Speed!")]).state;
    const t = submitOperations(ctx, s0, "move it", [moveOp(90 * U, 92 * U, 98 * U)]);
    const tl = currentTimeline(ctx, t.state);
    expect(effectDisplay(ctx, tl, tl.effects[0]!)).toMatchObject({ startUs: 96 * U, endUs: 98 * U });
    expect(tl.effects[0]).toMatchObject({ state: "active", partial: false, fragmented: false });
    expect(t.answer.summary).toContain('caption "Speed!" moved from 1:30.000 to 1:36.000');
    expect(t.answer.summary).toContain('Moved the section starting "Honestly" from 1:30.000 to 1:36.000');
  });

  it("moving the WHOLE range elsewhere keeps one run (the pause inside the range moves along)", () => {
    const lastWords = atomEndingAt(atoms, 100_400_000);
    const log = edit(edit([], captionOp("fx_0_0", first.id, lastWords.id, "Both")), moveOp(90 * U, 100_400_000, null));
    const tl = materialize(ctx, log);
    expect(tl.effects[0]).toMatchObject({ fragmented: false });
    expect(effectDisplay(ctx, tl, tl.effects[0]!)).toMatchObject({ startUs: 189_600_000, endUs: 200 * U });
  });

  it("moving only PART of a range splits it: a caption shows on the run holding its first surviving word, and the answer warns", () => {
    const lastWords = atomEndingAt(atoms, 100_400_000);
    const s0 = submitOperations(ctx, newSession(), "caption", [captionOp("fx_0_0", first.id, lastWords.id, "Both")]).state;
    const t = submitOperations(ctx, s0, "move the second sentence to the end", [moveOp(98 * U, 100_400_000, null)]);
    const tl = currentTimeline(ctx, t.state);
    expect(tl.effects[0]).toMatchObject({ state: "active", fragmented: true });
    const d = effectDisplay(ctx, tl, tl.effects[0]!)!;
    expect(d).toMatchObject({ startUs: 90 * U, endUs: 92 * U });
    expect(d.runs).toHaveLength(2);
    expect(d.runs[1]).toEqual({ startUs: 197_600_000, endUs: 200 * U });
    expect(t.answer.warnings.join(" ")).toMatch(/caption "Both" is now split.*first part only/);
  });

  it("a mute on the same range applies to every run, and the answer says it plays in several places", () => {
    const lastWords = atomEndingAt(atoms, 100_400_000);
    const s0 = submitOperations(ctx, newSession(), "mute", [{ type: "add_effect", effectId: "fx_0_0", range: { from: first.id, to: lastWords.id }, params: { kind: "mute" } }]).state;
    const t = submitOperations(ctx, s0, "move", [moveOp(98 * U, 100_400_000, null)]);
    const tl = currentTimeline(ctx, t.state);
    expect(effectDisplay(ctx, tl, tl.effects[0]!)!.runs).toHaveLength(2);
    expect(t.answer.warnings.join(" ")).toMatch(/separate places/);
  });

  it("auto-caption text follows the new order: swap two sentences and their cues swap (output order, not source order)", () => {
    // move "Captions are generated..." (98-100.4) to before "Honestly..." (90.0): they now play in the opposite order
    const cues = autoCaptionCues(ctx, materialize(ctx, edit([], moveOp(98 * U, 100_400_000, 90 * U))));
    const texts = cues.map((c) => c.text);
    expect(texts.indexOf("Captions are generated from your words.")).toBeGreaterThan(-1);
    expect(texts.indexOf("Captions are generated from your words.")).toBeLessThan(texts.indexOf("Honestly the speed is great."));
    expect(cues.map((c) => c.startUs)).toEqual([...cues.map((c) => c.startUs)].sort((a, b) => a - b)); // times ascend in the output
    expect(cues.find((c) => c.text.startsWith("Captions"))).toMatchObject({ startUs: 90 * U, endUs: 92_400_000 });
    expect(cues.find((c) => c.text.startsWith("Honestly"))).toMatchObject({ startUs: 92_400_000, endUs: 94_400_000 });
  });
});

describe("(d) undo and restore after a reorder", () => {
  it("undo returns the exact earlier timeline; redo brings the reorder back", () => {
    const s1 = submitOperations(ctx, newSession(), "move", [moveOp(90 * U, 92 * U, 98 * U)]);
    const undone = submitUndo(ctx, s1.state, "undo");
    expect(undone.answer.timelineHash).toBe(timelineHash(materialize(ctx, [])));
    expect(submitRedo(ctx, undone.state, "redo").answer.timelineHash).toBe(s1.answer.timelineHash);
  });

  it("restoring the reorder while a later cut stays gives the timeline of that cut alone", () => {
    const moveGroup = appendEdit([], [moveOp(90 * U, 92 * U, 98 * U)]);
    const withCut = appendEdit(moveGroup.log, [cutOp(ctx, 108 * U, 113 * U)]);
    const s = submitOperations(ctx, { log: withCut.log, conversation: [] }, "put the order back", [{ type: "restore", targetGroup: 1 }]);
    expect(s.answer.status).toBe("applied");
    expect(s.answer.timelineHash).toBe(timelineHash(materialize(ctx, edit([], cutOp(ctx, 108 * U, 113 * U)))));
  });

  it("restoring the cut while the reorder stays gives the reorder alone", () => {
    const l1 = appendEdit([], [moveOp(90 * U, 92 * U, 98 * U)]).log;
    const l2 = appendEdit(l1, [cutOp(ctx, 108 * U, 113 * U)]).log;
    const s = submitOperations(ctx, { log: l2, conversation: [] }, "put the pricing back", [{ type: "restore", targetGroup: 2 }]);
    expect(s.answer.timelineHash).toBe(timelineHash(materialize(ctx, l1)));
  });

  it("an edit after the reorder defined by source position survives restoring the reorder (a cut inside the moved section)", () => {
    const l1 = appendEdit([], [moveOp(90 * U, 92 * U, 98 * U)]).log;
    const l2 = appendEdit(l1, [cutOp(ctx, 90 * U, 91_200_000)]).log; // cut "Honestly the speed" (inside the moved section)
    const t = submitOperations(ctx, { log: l2, conversation: [] }, "undo the move", [{ type: "restore", targetGroup: 1 }]);
    expect(t.answer.timelineHash).toBe(timelineHash(materialize(ctx, edit([], cutOp(ctx, 90 * U, 91_200_000)))));
  });
});

describe("planMoveEdited: the move as the user states it (edited time)", () => {
  it("'move 1:30-1:32 to before 1:38' (edited == original here) matches the hand-built operation", () => {
    const tl = materialize(ctx, []);
    const plan = planMoveEdited(ctx, tl, 90 * U, 92 * U, 98 * U);
    expect(plan.warnings).toEqual([]);
    expect(plan.operations).toEqual([moveOp(90 * U, 92 * U, 98 * U)]);
  });

  it("to the end, and a range straddling removed material becomes two moves in order", () => {
    const tl = materialize(ctx, edit([], cutOp(ctx, 108 * U, 113 * U)));
    // edited 100-110 = source 100-108 and 113-115; (edited 103 = source 103)
    const plan = planMoveEdited(ctx, tl, 100 * U, 110 * U, null);
    expect(plan.operations).toHaveLength(2);
    const after = materialize(ctx, [...edit(edit([], cutOp(ctx, 108 * U, 113 * U)), ...plan.operations)]);
    expect(after.durationUs).toBe(195 * U);
  });

  it("rejects a target inside the range or beyond the end", () => {
    const tl = materialize(ctx, []);
    expect(() => planMoveEdited(ctx, tl, 90 * U, 92 * U, 91 * U)).toThrow(EngineError);
    expect(() => planMoveEdited(ctx, tl, 90 * U, 92 * U, 250 * U)).toThrow(/after the end/);
  });
});

describe("property: any sequence of moves keeps all material, in disjoint pieces, with consistent time mapping", () => {
  const cursorAt = (i: number) => (i >= atoms.length ? null : at(atoms[i]!.startUs));
  const pair = fc.tuple(fc.integer({ min: 0, max: atoms.length - 2 }), fc.integer({ min: 1, max: atoms.length - 1 })).filter(([a, b]) => a < b);
  const moveArb = fc.tuple(pair, fc.integer({ min: 0, max: atoms.length }));

  it("100 seeded random move sequences (inputs deep-frozen)", () => {
    fc.assert(
      fc.property(fc.array(moveArb, { minLength: 1, maxLength: 8 }), fc.array(fc.integer({ min: 0, max: 199_999_999 }), { minLength: 5, maxLength: 5 }), (moves, samples) => {
        let log: Log = deepFreeze([]);
        for (const [[a, b], t] of moves) {
          const op = deepFreeze<Operation>({
            type: "move",
            span: { start: at(atoms[a]!.startUs), end: at(atoms[b]!.startUs) },
            before: cursorAt(t),
          });
          const next = deepFreeze(edit(log, op));
          try {
            materialize(ctx, next);
          } catch (e) {
            if (e instanceof EngineError) continue; // e.g. target inside the section: rejected, not logged
            throw e;
          }
          log = next;
        }
        const tl = deepFreeze(materialize(ctx, log));
        expect(tl.durationUs).toBe(200 * U); // a reorder never changes the length
        const ivs = tl.segments.map((s) => spanToInterval(ctx.index, s.span, ctx.fps)).sort((x, y) => x.s - y.s);
        let covered = 0;
        ivs.forEach((iv, i) => {
          covered += iv.e - iv.s;
          if (i > 0) expect(iv.s).toBeGreaterThanOrEqual(ivs[i - 1]!.e); // disjoint in source
        });
        expect(covered).toBe(200 * U); // nothing lost, nothing duplicated
        const pieces = timelinePieces(ctx, tl);
        for (const o of samples) expect(sourceToEdited(pieces, editedToSource(pieces, o))).toBe(o); // rate 1: exact round trip
      }),
      { numRuns: 100, seed: 20261022 },
    );
  });
});
