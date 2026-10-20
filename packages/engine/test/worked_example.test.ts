import { describe, expect, it } from "vitest";
import { timelineHash } from "../src/hash";
import { analyzeLog, nextEffectId } from "../src/log";
import { findEffect, formatTime, resolveEditedRange } from "../src/resolve";
import { findTopicParts, phraseRanges } from "../src/search";
import { answerClarification, askClarification, currentTimeline, newSession, submitOperations, submitUndo, type SessionState, type Turn } from "../src/session";
import { effectDisplay, sourceToEdited, timelinePieces } from "../src/timemap";
import { cursorToUs } from "../src/cursor";
import { makeFixture } from "./fixtures/transcript";
import { RED, WHITE } from "./helpers";

/**
 * The 8-step worked example from the brief, on the synthetic 3:20 fixture.
 * Every number below is written out by hand from the fixture facts:
 *   caption "welcome to the channel" 42.0-44.0; first 30 s cut; pricing mention #2 = 108.0-113.0 (5.0 s,
 *   sentence + trailing silence); edited 1:00-1:30 after those cuts = source 90-108 and 113-125 (30 s, 2x saves 15 s).
 * Parsing instructions is not in M1, so each step builds the operations the parser WILL produce, using the
 * same engine helpers (phrase search, time resolution, topic search).
 */
const { ctx } = makeFixture();
const U = 1_000_000;

const caption = (s: SessionState) => {
  const tl = currentTimeline(ctx, s);
  const e = tl.effects.find((x) => x.params.kind === "caption")!;
  return { effect: e, display: effectDisplay(ctx, tl, e)! };
};

describe("worked example (steps 1-7)", () => {
  // The steps build on each other, so they share state and run in order.
  let state = newSession();
  const hashes: Record<string, string> = {};
  let turn: Turn;

  it("step 1: caption 'Welcome!' on 'welcome to the channel', original 0:42-0:44", () => {
    const ranges = phraseRanges(ctx, "welcome to the channel");
    expect(ranges).toHaveLength(1);
    turn = submitOperations(ctx, state, 'caption "Welcome!" on "welcome to the channel"', [
      { type: "add_effect", effectId: nextEffectId(state.log), range: ranges[0]!, params: { kind: "caption", text: "Welcome!", style: WHITE, position: "bottom" } },
    ]);
    state = turn.state;
    expect(turn.answer.status).toBe("applied");
    expect(turn.answer.timePolicy).toBe("current");
    expect(caption(state).display).toMatchObject({ startUs: 42 * U, endUs: 44 * U, extended: false });
    expect(turn.answer.durationUs).toBe(200 * U);
    hashes.s1 = turn.answer.timelineHash;
  });

  it("step 2: cut the first 30 s -> caption now 0:12-0:14 on the same words; length drops by exactly 30 s", () => {
    const tl = currentTimeline(ctx, state);
    const { spans, warnings } = resolveEditedRange(ctx, tl, 0, 30 * U);
    expect(warnings).toEqual([]); // 30.0 s is inside the 29.2-31.0 silence: exact cut, no snapping
    const before = caption(state).effect.range;
    turn = submitOperations(ctx, state, "cut the first 30 seconds", spans.map((span) => ({ type: "cut", span, reason: "user" })));
    state = turn.state;
    expect(turn.answer.status).toBe("applied");
    expect(turn.answer.durationUs).toBe(170 * U);
    expect(turn.answer.summary).toBe('Length 3:20.000 -> 2:50.000 (-0:30.000). caption "Welcome!" moved from 0:42.000 to 0:12.000.');
    expect(caption(state).display).toMatchObject({ startUs: 12 * U, endUs: 14 * U, extended: false });
    expect(caption(state).effect.range).toEqual(before); // anchored to the same atoms, not to seconds
    expect(turn.answer.timelineHash).not.toBe(hashes.s1);
    hashes.s2 = turn.answer.timelineHash;
  });

  it("step 3a: 'remove the part about pricing' -> needs_clarification listing the 3 mentions; nothing changes", () => {
    const tl = currentTimeline(ctx, state);
    const parts = findTopicParts(ctx, tl, "pricing");
    expect(parts).toHaveLength(3);
    const options = parts.map((p) => ({
      label: `#${p.index} at ${formatTime(p.editedStartUs)}: "${p.snippet}"`,
      operations: [{ type: "cut" as const, span: p.span, reason: "user" as const }],
      warnings: [],
    }));
    const logBefore = state.log;
    turn = askClarification(ctx, state, "remove the part about pricing", "Pricing is mentioned 3 times. Which part should I remove?", options);
    state = turn.state;
    expect(turn.answer.status).toBe("needs_clarification");
    expect(turn.answer.options).toEqual([
      '#1 at 0:35.000: "Now let us talk about pricing."',
      '#2 at 1:18.000: "The pricing for teams is different."',
      '#3 at 2:10.000: "One last word on pricing."',
    ]);
    expect(turn.answer.timelineHash).toBe(hashes.s2); // clarification does not change the hash
    expect(state.log).toBe(logBefore); // ...nor the log
  });

  it("step 3b: 'the second one' -> applied; exactly the second mention (5.0 s) is removed", () => {
    turn = answerClarification(ctx, state, "the second one", 1);
    state = turn.state;
    expect(turn.answer.status).toBe("applied");
    expect(turn.answer.durationUs).toBe(165 * U);
    const [cut] = turn.answer.operations;
    if (cut?.type !== "cut") throw new Error("expected a cut");
    expect([cursorToUs(ctx.index, cut.span.start, ctx.fps), cursorToUs(ctx.index, cut.span.end, ctx.fps, "end")]).toEqual([108 * U, 113 * U]);
    expect(analyzeLog(state.log).active).toEqual([1, 2, 3]); // the clarification turn was not a group
    hashes.s3 = turn.answer.timelineHash;
  });

  it("step 4: speed up 1:00-1:30 by 2x (current-time policy); the range straddles the removed gap", () => {
    const tl = currentTimeline(ctx, state);
    const { spans, warnings } = resolveEditedRange(ctx, tl, 60 * U, 90 * U);
    expect(warnings).toEqual([]);
    expect(spans).toHaveLength(2); // [90,108) and [113,125): the removed pricing part is skipped
    turn = submitOperations(
      ctx,
      state,
      "speed up 1:00 to 1:30 by 2x",
      spans.map((span) => ({ type: "set_speed", span, rate: { num: 2, den: 1 } })),
      { timePolicy: "current" },
    );
    state = turn.state;
    expect(turn.answer.status).toBe("applied");
    expect(turn.answer.timePolicy).toBe("current"); // the answer states which policy was used
    expect(turn.answer.durationUs).toBe(150 * U); // 165 - (30 s of source played at 2x saves 15 s)
    const regions = currentTimeline(ctx, state).speedRegions.map((r) => [cursorToUs(ctx.index, r.span.start, ctx.fps), cursorToUs(ctx.index, r.span.end, ctx.fps, "end")]);
    expect(regions).toEqual([[90 * U, 108 * U], [113 * U, 125 * U]]);
    expect(caption(state).display).toMatchObject({ startUs: 12 * U, endUs: 14 * U, extended: false });
    hashes.s4 = turn.answer.timelineHash;
  });

  it("step 5: 'put the intro back' -> first 30 s return, caption back at 0:42; pricing cut and speed change stay", () => {
    // The intro is edit #2 (the cut of the first 30 s). "Restore edit N" is a new op that points at it.
    turn = submitOperations(ctx, state, "put the intro back", [{ type: "restore", targetGroup: 2 }]);
    state = turn.state;
    expect(turn.answer.status).toBe("applied");
    expect(turn.answer.durationUs).toBe(180 * U); // 200 - 5 (pricing part) - 15 (2x)
    expect(caption(state).display).toMatchObject({ startUs: 42 * U, endUs: 44 * U, extended: false });
    const tl = currentTimeline(ctx, state);
    const pieces = timelinePieces(ctx, tl);
    expect(sourceToEdited(pieces, 10 * U)).toBe(10 * U); // intro content is back
    expect(sourceToEdited(pieces, 110 * U)).toBeNull(); // pricing part #2 still cut
    expect(tl.speedRegions).toHaveLength(2); // speed change still there
    expect(turn.answer.timelineHash).not.toBe(hashes.s4);
    hashes.s5 = turn.answer.timelineHash;
  });

  it("step 6: undo reverses step 5 only", () => {
    turn = submitUndo(ctx, state, "undo");
    state = turn.state;
    expect(turn.answer.status).toBe("applied");
    expect(turn.answer.summary).toMatch(/^Undid edit 5\./);
    expect(turn.answer.durationUs).toBe(150 * U);
    expect(caption(state).display).toMatchObject({ startUs: 12 * U, endUs: 14 * U, extended: false });
    expect(currentTimeline(ctx, state).speedRegions).toHaveLength(2); // step 4 not undone
    expect(turn.answer.timelineHash).toBe(hashes.s4); // exactly the state after step 4
    expect(analyzeLog(state.log).active).toEqual([1, 2, 3, 4]);
  });

  it("step 7: 'make that caption red' applies to the only caption", () => {
    const found = findEffect(currentTimeline(ctx, state), "caption");
    if (found.kind !== "one") throw new Error("expected exactly one caption");
    turn = submitOperations(ctx, state, "make that caption red", [{ type: "update_effect", effectId: found.effect.id, params: { kind: "caption", text: "Welcome!", style: RED, position: "bottom" } }]);
    state = turn.state;
    expect(turn.answer.status).toBe("applied");
    const c = caption(state);
    expect(c.effect.params).toEqual({ kind: "caption", text: "Welcome!", style: RED, position: "bottom" });
    expect(c.display).toMatchObject({ startUs: 12 * U, endUs: 14 * U, extended: false });
    expect(turn.answer.durationUs).toBe(150 * U);
    expect(turn.answer.timelineHash).not.toBe(hashes.s4); // colour is part of the timeline
  });

  it.skip("step 8: render is in sync, length matches, caption on the right words — needs M3", () => {
    // Requires the ffmpeg renderer (M3). Intentionally not asserted anywhere in M1.
  });

  it("'that caption' is ambiguous with two captions and impossible with none (never guessed)", () => {
    const tl = currentTimeline(ctx, state);
    expect(findEffect(tl, "caption").kind).toBe("one");
    expect(findEffect(tl, "bleep").kind).toBe("none");
    const two = submitOperations(ctx, state, "second caption", [
      { type: "add_effect", effectId: nextEffectId(state.log), range: phraseRanges(ctx, "pricing")[0]!, params: { kind: "caption", text: "Pricing", style: WHITE, position: "bottom" } },
    ]);
    expect(findEffect(currentTimeline(ctx, two.state), "caption").kind).toBe("ambiguous");
  });

  it("the whole example replays to the same hash on 3 fresh engines", () => {
    const final = timelineHash(currentTimeline(ctx, state));
    const again = [1, 2, 3].map(() => timelineHash(currentTimeline(makeFixture().ctx, { log: state.log, conversation: [] })));
    expect(again).toEqual([final, final, final]);
  });
});
