import { describe, expect, it } from "vitest";
import { buildAtoms, type WordInput } from "../src/atoms";
import { createContext } from "../src/context";
import { cursorToUs } from "../src/cursor";
import { sha256Hex } from "../src/hash";
import { planMoveEdited, planRemoveFillers, planRemoveSilences } from "../src/plan";
import { materialize } from "../src/replay";
import { resolveEditedRange, resolveOriginalRange, snapPoint } from "../src/resolve";
import { findTopicParts } from "../src/search";
import { answerClarification, askClarification, currentTimeline, newSession, submitOperations } from "../src/session";
import type { Operation, Source } from "../src/types";
import { makeFixture } from "./fixtures/transcript";

// A 29.97 fps source in which the sentence "pricing matters." starts RIGHT AFTER the word "beta." (no pause),
// and "uh" sits between two words. Those boundaries cannot be moved into a silence, so they cannot be put on
// the frame grid. Every path that builds a span there must say so, with the same words as snapPoint.
const NTSC = { num: 30000, den: 1001 };
const w = (text: string, startUs: number, endUs: number): WordInput => ({ text, startUs, endUs });
const sha = sha256Hex("grid-warning-fixture");
const atoms = buildAtoms(sha, 10_000_000, [
  w("alpha", 1_000_000, 1_500_000),
  w("beta.", 1_500_000, 2_000_000),
  w("pricing", 2_000_000, 2_600_000), // touches "beta." at 2.000000 s: not a frame boundary, no silence to move into
  w("matters.", 2_600_000, 3_200_000),
  w("other", 6_000_000, 6_500_000),
  w("stuff.", 6_500_000, 7_000_000),
  w("then", 7_000_000, 7_500_000),
  w("uh", 7_500_000, 8_000_000), // between two words
  w("yes.", 8_000_000, 8_500_000),
]);
const source: Source = { sha256: sha, durationUs: 10_000_000, fps: NTSC, hasAudio: true, hasVideo: true, variableFrameRate: false };
const ctx = createContext(source, atoms);
const tl0 = materialize(ctx, []);

const TWO = /between two words.*not on a frame boundary/;

describe("grid warnings on every path that builds spans (touching words, 29.97 fps)", () => {
  it("control: the boundary really is off the grid, and snapPoint warns about it", () => {
    const r = snapPoint(ctx, 2_000_000);
    expect(r.us).toBe(2_000_000);
    expect(r.warning).toMatch(TWO);
    expect(r.warning).toContain("0:02.000");
  });

  it('"remove the part about pricing": findTopicParts carries the warning, and the answer includes it (single match path)', () => {
    const parts = findTopicParts(ctx, tl0, "pricing");
    expect(parts).toHaveLength(1);
    expect(parts[0]!.warnings).toEqual([snapPoint(ctx, 2_000_000).warning]); // identical text to snapPoint's
    const t = submitOperations(ctx, newSession(), "remove the part about pricing", [{ type: "cut", reason: "user", span: parts[0]!.span }], { warnings: parts[0]!.warnings });
    expect(t.answer.status).toBe("applied");
    expect(t.answer.warnings.join(" ")).toMatch(TWO);
    // the cut itself: starts at the (unsnappable) word boundary, ends in the silence on the grid
    expect(cursorToUs(ctx.index, parts[0]!.span.start, ctx.fps)).toBe(2_000_000);
  });

  it("clarification path: the warning rides along with the chosen option into the answer", () => {
    const parts = findTopicParts(ctx, tl0, "pricing");
    const asked = askClarification(ctx, newSession(), "remove the part about pricing", "Which?", parts.map((p) => ({ label: p.snippet, operations: [{ type: "cut", reason: "user", span: p.span } as Operation], warnings: p.warnings })));
    const done = answerClarification(ctx, asked.state, "that one", 0);
    expect(done.answer.warnings.join(" ")).toMatch(TWO);
  });

  it("a part bounded by silences has no grid warning (control on the normal fixture, 29.97 fps)", () => {
    const f = makeFixture(undefined, NTSC);
    for (const p of findTopicParts(f.ctx, materialize(f.ctx, []), "pricing")) expect(p.warnings).toEqual([]);
  });

  it("resolveEditedRange and resolveOriginalRange warn for a start on the touching boundary", () => {
    expect(resolveEditedRange(ctx, tl0, 2_000_000, 3_200_000).warnings.join(" ")).toMatch(TWO);
    expect(resolveOriginalRange(ctx, 2_000_000, 3_200_000).warnings.join(" ")).toMatch(TWO);
  });

  it("resolveEditedRange also warns when the range STARTS exactly at a segment edge that sits on a touching-words boundary", async () => {
    // cut 1.0 s (snapped into the silence) .. 2.0 s (between "beta." and "pricing": cannot be snapped); the next segment starts at 2.0 s
    const { snapBoundaryUs, usToCursor } = await import("../src/cursor");
    const { timelinePieces } = await import("../src/timemap");
    const s = snapBoundaryUs(ctx.index, 1_000_000, NTSC);
    const cut: Operation = { type: "cut", reason: "user", span: { start: usToCursor(ctx.index, s, NTSC), end: usToCursor(ctx.index, 2_000_000, NTSC) } };
    const tl = materialize(ctx, [{ seq: 0, kind: "edit", group: 1, op: cut }]);
    const second = timelinePieces(ctx, tl)[1]!;
    expect(second.srcS).toBe(2_000_000);
    const r = resolveEditedRange(ctx, tl, second.outS, second.outS + 1_400_000); // ends at about 3.4 s: inside a silence, so only the START can warn
    expect(r.warnings.join(" ")).toMatch(TWO); // the start is not "interior", so only the span-level check can find this
  });

  it("they do not warn when both ends are fine (silence on the grid)", () => {
    // 4.0 s is inside the silence 3.2-6.0: snapped to the nearest frame, no warning
    expect(resolveEditedRange(ctx, tl0, 4_000_000, 5_000_000).warnings).toEqual([]);
    expect(resolveOriginalRange(ctx, 4_000_000, 5_000_000).warnings).toEqual([]);
  });

  it("filler removal warns for a filler between two words (both of its boundaries)", () => {
    const plan = planRemoveFillers(ctx, tl0);
    expect(plan.operations).toHaveLength(1);
    expect(plan.warnings).toHaveLength(2); // 7.5 s and 8.0 s: two different boundaries
    for (const warning of plan.warnings) expect(warning).toMatch(TWO);
    expect(plan.warnings.join(" ")).toContain("0:07.500");
    expect(plan.warnings.join(" ")).toContain("0:08.000");
  });

  it("the answer to a filler-removal instruction includes them", () => {
    const plan = planRemoveFillers(ctx, tl0);
    const t = submitOperations(ctx, newSession(), "remove the fillers", plan.operations, { warnings: plan.warnings });
    expect(t.answer.warnings.join(" ")).toMatch(TWO);
    // 9.5 s = 284.715 frames at 29.97 fps: the output is a whole number of frames (285), the documented cumulative rounding
    expect(currentTimeline(ctx, t.state).durationUs).toBe(9_509_500);
  });

  it("reorder warns when the moved section starts on the touching boundary", () => {
    const plan = planMoveEdited(ctx, tl0, 2_000_000, 3_200_000, null);
    expect(plan.warnings.join(" ")).toMatch(TWO);
  });

  it("silence removal never produces a grid warning (its cuts are always inside a silence)", () => {
    const plan = planRemoveSilences(ctx, tl0, { minUs: 1_000_000 });
    expect(plan.operations.length).toBeGreaterThan(0);
    expect(plan.warnings).toEqual([]);
  });
});
