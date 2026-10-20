import { describe, expect, it } from "vitest";
import { cursorToUs } from "../src/cursor";
import { appendEdit, type Log } from "../src/log";
import { materialize } from "../src/replay";
import { findTopicParts, phraseRanges } from "../src/search";
import { formatTime, resolveEditedRange, snapPoint } from "../src/resolve";
import { atomEndingAt, atomStartingAt, FACTS, makeFixture } from "./fixtures/transcript";
import { cutOp, speedOp } from "./helpers";
import type { Operation } from "../src/types";

const { ctx, atoms } = makeFixture();
const edit = (log: Log, ...ops: Operation[]) => appendEdit(log, ops).log;

describe("fixture sanity (so later numbers can be trusted)", () => {
  it("has the planned content: welcome once, pricing 3x after 0:30, thanks 4x, one non-filler like, 4 fillers", () => {
    expect(phraseRanges(ctx, "welcome to the channel")).toHaveLength(1);
    expect(phraseRanges(ctx, "pricing")).toHaveLength(3);
    expect(phraseRanges(ctx, "thanks")).toHaveLength(4);
    const likes = atoms.filter((a) => a.text.toLowerCase() === "like");
    expect(likes).toHaveLength(1);
    expect(likes[0]!.filler).toBe(false);
    expect(atoms.filter((a) => a.filler).map((a) => a.text)).toEqual(["Um", "Uh", "Um", "Um"]);
    for (const p of FACTS.pricing) expect(p.startUs).toBeGreaterThan(30_000_000);
    const silence = atoms.find((a) => a.startUs === FACTS.silenceBeforeFirstCutPoint.startUs)!;
    expect(silence.kind).toBe("silence");
    expect(silence.endUs).toBe(FACTS.silenceBeforeFirstCutPoint.endUs);
  });
});

describe("phraseRanges", () => {
  it("returns the atom range of 'welcome to the channel' at 42.0-44.0", () => {
    const [r] = phraseRanges(ctx, "welcome to the channel");
    expect(r).toEqual({ from: atomStartingAt(atoms, FACTS.welcome.startUs).id, to: atomEndingAt(atoms, FACTS.welcome.endUs).id });
  });
  it("ignores case and punctuation", () => {
    expect(phraseRanges(ctx, "Welcome, to the CHANNEL!")).toHaveLength(1);
  });
  it("finds nothing for a phrase that is not there", () => {
    expect(phraseRanges(ctx, "goodbye forever")).toEqual([]);
  });
});

describe("findTopicParts: 'the part about pricing'", () => {
  it("finds 3 parts in original time; each is a sentence plus the silence after it", () => {
    const parts = findTopicParts(ctx, materialize(ctx, []), "pricing");
    expect(parts).toHaveLength(3);
    FACTS.pricing.forEach((p, i) => {
      const part = parts[i]!;
      expect(part.originalStartUs).toBe(p.startUs);
      expect(cursorToUs(ctx.index, part.span.start, ctx.fps)).toBe(p.startUs);
      expect(cursorToUs(ctx.index, part.span.end, ctx.fps, "end")).toBe(p.partEndUs);
      expect(part.editedStartUs).toBe(p.startUs);
    });
    expect(parts[1]!.snippet).toBe("The pricing for teams is different.");
  });

  it("reports edited-time starts after the first 30 s are cut", () => {
    const tl = materialize(ctx, edit([], cutOp(ctx, 0, 30_000_000)));
    expect(findTopicParts(ctx, tl, "pricing").map((p) => p.editedStartUs)).toEqual([35_000_000, 78_000_000, 130_000_000]);
  });

  it("a part that is already cut is not offered again", () => {
    const tl = materialize(ctx, edit([], cutOp(ctx, 108_000_000, 113_000_000)));
    expect(findTopicParts(ctx, tl, "pricing")).toHaveLength(2);
  });

  it("'cost' finds the pricing parts (small built-in synonym group; real meaning search is M4)", () => {
    expect(findTopicParts(ctx, materialize(ctx, []), "cost")).toHaveLength(3);
  });

  it("an unknown topic finds nothing", () => {
    expect(findTopicParts(ctx, materialize(ctx, []), "volcano")).toEqual([]);
  });
});

describe("snapPoint: the cut rule", () => {
  it("inside a silence: exact (on the frame grid)", () => {
    expect(snapPoint(ctx, 30_000_000)).toEqual({ us: 30_000_000 });
    expect(snapPoint(ctx, 30_010_000)).toEqual({ us: 30_000_000 }); // 30 fps: nearest frame start
  });

  it("on an atom boundary: unchanged, no warning", () => {
    expect(snapPoint(ctx, FACTS.welcome.startUs)).toEqual({ us: FACTS.welcome.startUs });
  });

  it("inside a word: snaps to the edge that touches a silence, and warns", () => {
    // "welcome" is 42.0-42.5; its start touches the silence before it, its end touches the word "to".
    const r = snapPoint(ctx, 42_200_000);
    expect(r.us).toBe(42_000_000);
    expect(r.warning).toMatch(/inside the word "welcome".*0:42\.000/);
  });

  it("inside a word with no silence on either side: nearest edge, and says there was no silence nearby", () => {
    // "everyone" is 2.4-2.8 between the words "Hi" and "and"
    const r = snapPoint(ctx, 2_700_000);
    expect(r.us).toBe(2_800_000);
    expect(r.warning).toMatch(/no silence nearby/);
  });
});

describe("resolveEditedRange (current-time policy)", () => {
  it("edited 0:60-0:90 straddling a removed gap becomes two source spans", () => {
    const log = edit(edit([], cutOp(ctx, 0, 30_000_000)), cutOp(ctx, 108_000_000, 113_000_000));
    const tl = materialize(ctx, log);
    const r = resolveEditedRange(ctx, tl, 60_000_000, 90_000_000);
    expect(r.warnings).toEqual([]);
    const us = r.spans.map((s) => [cursorToUs(ctx.index, s.start, ctx.fps), cursorToUs(ctx.index, s.end, ctx.fps, "end")]);
    expect(us).toEqual([[90_000_000, 108_000_000], [113_000_000, 125_000_000]]);
  });

  it("an edited range inside one stretch is one span", () => {
    const tl = materialize(ctx, edit([], cutOp(ctx, 0, 30_000_000)));
    const r = resolveEditedRange(ctx, tl, 12_000_000, 14_000_000);
    expect(r.spans).toHaveLength(1);
    expect(cursorToUs(ctx.index, r.spans[0]!.start, ctx.fps)).toBe(42_000_000);
  });

  it("accounts for speed regions when mapping edited time back to source", () => {
    const tl = materialize(ctx, edit([], speedOp(ctx, 90_000_000, 108_000_000, 2)));
    // output 0:99 = source 108 (90 + 18/2 = 99). Edited 99-100 s = source 108-109 s
    const r = resolveEditedRange(ctx, tl, 99_000_000, 100_000_000);
    expect(r.spans.map((s) => cursorToUs(ctx.index, s.start, ctx.fps))).toEqual([108_000_000]);
  });

  it("a boundary that lands inside a word is snapped and warned", () => {
    const tl = materialize(ctx, []);
    const r = resolveEditedRange(ctx, tl, 42_200_000, 50_000_000);
    expect(r.warnings).toHaveLength(1);
    expect(cursorToUs(ctx.index, r.spans[0]!.start, ctx.fps)).toBe(42_000_000);
  });

  it("rejects ranges outside the timeline, naming the length", () => {
    const tl = materialize(ctx, edit([], cutOp(ctx, 0, 30_000_000))); // 170 s long
    expect(() => resolveEditedRange(ctx, tl, 180_000_000, 190_000_000)).toThrow(/2:50\.000/);
    expect(() => resolveEditedRange(ctx, tl, 10_000_000, 10_000_000)).toThrow();
  });
});

describe("formatTime", () => {
  it("writes m:ss.mmm", () => {
    expect(formatTime(0)).toBe("0:00.000");
    expect(formatTime(42_000_000)).toBe("0:42.000");
    expect(formatTime(200_000_000)).toBe("3:20.000");
    expect(formatTime(61_500_000)).toBe("1:01.500");
  });
});
