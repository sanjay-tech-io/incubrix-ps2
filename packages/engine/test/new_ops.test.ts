import { describe, expect, it } from "vitest";
import { buildAtoms, isFillerLike, type WordInput } from "../src/atoms";
import { createContext } from "../src/context";
import { cursorToUs, spanToInterval, usToCursor } from "../src/cursor";
import { sha256Hex, timelineHash } from "../src/hash";
import { appendEdit, nextEffectId, type Log } from "../src/log";
import { duckingEnvelope, speechSegments } from "../src/music";
import { planMuteOrBleep, planProtectPause, planRemoveFillers, planRemoveSilences, planUpdateCaption } from "../src/plan";
import { findEffect } from "../src/resolve";
import { materialize } from "../src/replay";
import { currentTimeline, newSession, submitOperations, submitUndo } from "../src/session";
import { atomOutSpan, effectDisplay, timelinePieces } from "../src/timemap";
import type { MusicParams, Operation, Source } from "../src/types";
import { atomEndingAt, atomStartingAt, makeFixture } from "./fixtures/transcript";
import { captionOp, cutOp, RED, span, WHITE } from "./helpers";

const { ctx, atoms } = makeFixture();
const U = 1_000_000;
const edit = (log: Log, ...ops: Operation[]) => appendEdit(log, ops).log;
const at = (us: number) => usToCursor(ctx.index, us, ctx.fps);
const iv = (op: Operation) => {
  if (op.type !== "cut") throw new Error("expected a cut");
  return [cursorToUs(ctx.index, op.span.start, ctx.fps), cursorToUs(ctx.index, op.span.end, ctx.fps, "end")];
};

/** A tiny synthetic source for exact-number tests. */
function tiny(words: WordInput[], durationUs: number, fps: { num: number; den: number } | null = { num: 30, den: 1 }) {
  const sha = sha256Hex("tiny-" + words.map((w) => w.text + w.startUs).join(","));
  const atomsT = buildAtoms(sha, durationUs, words);
  const source: Source = { sha256: sha, durationUs, fps, hasAudio: true, hasVideo: true, variableFrameRate: false };
  return { ctx: createContext(source, atomsT), atoms: atomsT };
}

describe('filler "like": a deterministic documented rule', () => {
  const w = (text: string, i: number, extra: Partial<WordInput> = {}): WordInput => ({ text, startUs: i * 500_000, endUs: i * 500_000 + 400_000, ...extra });
  const likeAt = (words: string[], pauses: Record<number, number> = {}) => {
    let t = 0;
    const ws: WordInput[] = words.map((text, i) => {
      const start = t + (pauses[i] ?? 0);
      t = start + 400_000;
      return { text, startUs: start, endUs: t };
    });
    const a = buildAtoms("a".repeat(64), t + 1_000_000, ws);
    const idx = a.findIndex((x) => x.text.replace(/,/g, "") === "like");
    return a[idx]!.filler;
  };

  it('"I like this tool" is NOT a filler', () => {
    expect(likeAt(["I", "like", "this", "tool"])).toBe(false);
    expect(likeAt(["I", "would", "like", "to", "go"])).toBe(false);
    expect(likeAt(["it", "looks", "like", "a", "pro"])).toBe(false);
  });
  it("R1/R2: commas around it make it a filler", () => {
    expect(likeAt(["it", "was,", "like,", "really", "fast"])).toBe(true);
    expect(likeAt(["it", "was", "like,", "really", "fast"])).toBe(true);
    expect(likeAt(["so,", "like", "really", "fast"])).toBe(true);
  });
  it("R3: isolated by pauses of 0.3 s on both sides", () => {
    expect(likeAt(["well", "like", "yes"], { 1: 300_000, 2: 300_000 })).toBe(true);
    expect(likeAt(["well", "like", "yes"], { 1: 300_000 })).toBe(false); // only one side
  });
  it("R4: right after um/uh", () => {
    expect(likeAt(["um", "like", "yes"])).toBe(true);
    expect(likeAt(["um", "like", "yes"], { 1: 600_000 })).toBe(false); // too long a pause between
  });
  it("an explicit flag always wins over the rule", () => {
    const a = buildAtoms("b".repeat(64), 3_000_000, [w("like,", 0, { filler: false }), w("like", 2, { filler: true })]);
    expect(a.filter((x) => x.kind === "word").map((x) => x.filler)).toEqual([false, true]);
  });
  it("isFillerLike is false for any other word", () => {
    const a = buildAtoms("c".repeat(64), 2_000_000, [w("hello,", 0)]);
    expect(isFillerLike(a, 0)).toBe(false);
  });
});

describe("remove fillers", () => {
  it("removes um/uh (4 in the fixture) and keeps the non-filler 'like' in 'I like this tool'", () => {
    const tl = materialize(ctx, []);
    const plan = planRemoveFillers(ctx, tl);
    expect(plan.warnings).toEqual([]);
    expect(plan.operations).toHaveLength(4);
    expect(plan.operations.map(iv)).toEqual([[6 * U, 6_400_000], [18 * U, 18_400_000], [60 * U, 60_400_000], [170 * U, 170_400_000]]);
    const t = submitOperations(ctx, newSession(), "remove the fillers", plan.operations);
    expect(t.answer.status).toBe("applied");
    expect(t.answer.durationUs).toBe(198_400_000); // 4 words of 0.4 s
    const after = currentTimeline(ctx, t.state);
    const pieces = timelinePieces(ctx, after);
    const like = atoms.find((a) => a.text === "like")!;
    expect(atomOutSpan(pieces, like)).not.toBeNull(); // "I like this tool" stays
    for (const f of atoms.filter((a) => a.filler)) expect(atomOutSpan(pieces, f)).toBeNull();
  });

  it("repeating it is safe: nothing left to remove", () => {
    const t = submitOperations(ctx, newSession(), "fillers", planRemoveFillers(ctx, materialize(ctx, [])).operations);
    expect(planRemoveFillers(ctx, currentTimeline(ctx, t.state)).operations).toEqual([]);
  });

  it("a short silence right after the filler goes with it; a long one, or a pinned one, stays", () => {
    const mk = (gap: number) => tiny([{ text: "so", startUs: 1_000_000, endUs: 1_500_000 }, { text: "uh", startUs: 1_500_000, endUs: 2_000_000 }, { text: "yes", startUs: 2_000_000 + gap, endUs: 2_500_000 + gap }], 6_000_000);
    const short = mk(300_000);
    expect(planRemoveFillers(short.ctx, materialize(short.ctx, [])).operations.map((o) => (o.type === "cut" ? [cursorToUs(short.ctx.index, o.span.start, short.ctx.fps), cursorToUs(short.ctx.index, o.span.end, short.ctx.fps, "end")] : []))).toEqual([[1_500_000, 2_300_000]]);
    const long = mk(800_000);
    expect(planRemoveFillers(long.ctx, materialize(long.ctx, [])).operations.map((o) => (o.type === "cut" ? [cursorToUs(long.ctx.index, o.span.start, long.ctx.fps), cursorToUs(long.ctx.index, o.span.end, long.ctx.fps, "end")] : []))).toEqual([[1_500_000, 2_000_000]]);
    const pause = short.atoms.find((a) => a.kind === "silence" && a.startUs === 2_000_000)!;
    const pinned = materialize(short.ctx, edit([], { type: "protect_pause", range: { from: pause.id, to: pause.id } }));
    expect(planRemoveFillers(short.ctx, pinned).operations.map((o) => (o.type === "cut" ? cursorToUs(short.ctx.index, o.span.end, short.ctx.fps, "end") : 0))).toEqual([2_000_000]);
  });

  it("hard case: a filler that is bleeped is KEPT, with a warning (documented rule)", () => {
    const uh = atoms.find((a) => a.text === "Uh")!;
    const log = edit([], planMuteOrBleep([], { from: uh.id, to: uh.id }, "bleep"));
    const plan = planRemoveFillers(ctx, materialize(ctx, log));
    expect(plan.operations).toHaveLength(3);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/Kept the filler "Uh" at 0:18\.000.*bleep/);
  });

  it("hard case: a bleep range that merely contains a filler also keeps it; fillers outside the range are removed", () => {
    const um = atoms.find((a) => a.text === "Um" && a.startUs === 60 * U)!;
    const the = atomStartingAt(atoms, 60_400_000); // "the" right after the second Um
    const log = edit([], planMuteOrBleep([], { from: um.id, to: the.id }, "mute"));
    const plan = planRemoveFillers(ctx, materialize(ctx, log));
    expect(plan.operations.map(iv).map((x) => x[0])).toEqual([6 * U, 18 * U, 170 * U]);
    expect(plan.warnings.join(" ")).toMatch(/Kept the filler "Um" at 1:00\.000.*mute/);
  });
});

describe("remove silences longer than N", () => {
  const tl0 = materialize(ctx, []);

  it("N = 1 s: every pause longer than that is cut down to a 0.15 s pad on each speech side (26 in the fixture)", () => {
    const plan = planRemoveSilences(ctx, tl0, { minUs: U });
    expect(plan.operations).toHaveLength(26);
    expect(plan.warnings).toEqual([]);
  });

  it("exact numbers: the 1.8 s pause 29.2-31.0 keeps 0.15 s each side rounded INTO the cut on the 30 fps grid; the lead-in and the tail keep pad only next to speech", () => {
    const cuts = planRemoveSilences(ctx, tl0, { minUs: U }).operations.map(iv);
    // 29.2+0.15 = 29.35 s = frame 880.5 -> 881 (29.366667 s); 31.0-0.15 = 30.85 s = frame 925.5 -> 925 (30.833333 s)
    expect(cuts).toContainEqual([29_366_667, 30_833_333]);
    // lead-in 0-2.0: no speech before it, so only the end keeps a pad: 1.85 s = frame 55.5 -> floor 55 (1.833333 s)
    expect(cuts[0]).toEqual([0, 1_833_333]);
    // tail 192.4-200: only the start keeps a pad: 192.55 s = frame 5776.5 -> 5777 (192.566667 s); the end is the end of the video
    expect(cuts.at(-1)).toEqual([192_566_667, 200 * U]);
  });

  it("'longer than' is strict: silences of exactly 2.8 s stay at N = 2.8 s, 16 longer ones go", () => {
    expect(planRemoveSilences(ctx, tl0, { minUs: 2_800_000 }).operations).toHaveLength(16);
  });

  it("applied, no surviving pause is longer than two pads plus a frame, and speech is untouched", () => {
    const t = submitOperations(ctx, newSession(), "remove silences longer than 1 second", planRemoveSilences(ctx, tl0, { minUs: U }).operations);
    expect(t.answer.status).toBe("applied");
    const tl = currentTimeline(ctx, t.state);
    const pieces = timelinePieces(ctx, tl);
    for (const a of atoms) {
      if (a.kind === "word") expect(atomOutSpan(pieces, a)).not.toBeNull(); // every word survives
    }
    for (const seg of tl.segments.map((s) => spanToInterval(ctx.index, s.span, ctx.fps))) {
      for (const a of atoms) {
        if (a.kind !== "silence" || a.endUs - a.startUs <= U) continue;
        const kept = Math.max(0, Math.min(seg.e, a.endUs) - Math.max(seg.s, a.startUs));
        expect(kept).toBeLessThanOrEqual(2 * 150_000 + 34_000);
      }
    }
  });

  it("a pinned pause survives, and the answer counts it", () => {
    const pin = planProtectPause(ctx, tl0, 120 * U); // inside the 14.6 s pause 115.4-130
    const tl = materialize(ctx, edit([], pin));
    const plan = planRemoveSilences(ctx, tl, { minUs: U });
    expect(plan.operations).toHaveLength(25);
    expect(plan.warnings).toEqual(["Kept 1 long pause because it is pinned."]);
    const removed = plan.operations.map(iv);
    expect(removed.some(([s, e]) => s! < 130 * U && e! > 115 * U)).toBe(false);
  });

  it("the pad is a setting: a bigger pad leaves more silence", () => {
    const small = planRemoveSilences(ctx, tl0, { minUs: U, padUs: 100_000 }).operations.map(iv);
    const big = planRemoveSilences(ctx, tl0, { minUs: U, padUs: 400_000 }).operations.map(iv);
    const len = (xs: number[][]) => xs.reduce((a, [s, e]) => a + e! - s!, 0);
    expect(len(big)).toBeLessThan(len(small));
  });

  it("rejects a non-positive N, and pinning a moment inside speech", () => {
    expect(() => planRemoveSilences(ctx, tl0, { minUs: 0 })).toThrow();
    expect(() => planProtectPause(ctx, tl0, 90_200_000)).toThrow(/inside speech/);
    expect(() => planProtectPause(ctx, tl0, 250 * U)).toThrow(/outside/);
  });
});

describe("mute and bleep", () => {
  const low = makeFixture((words) => words.map((w) => (w.text === "speed" ? { ...w, confidencePermille: 300 } : w)));
  const speed = low.atoms.find((a) => a.text === "speed")!;
  const great = low.atoms.find((a) => a.text === "great.")!;

  it("a bleep touching a low-confidence word warns instead of bleeping blindly", () => {
    const op = planMuteOrBleep([], { from: speed.id, to: speed.id }, "bleep");
    const t = submitOperations(low.ctx, newSession(), "bleep speed", [op]);
    expect(t.answer.status).toBe("applied");
    expect(t.answer.warnings.join(" ")).toMatch(/"speed" \(low confidence\)/);
  });
  it("so does a mute, and a bleep on confident words does not warn", () => {
    expect(submitOperations(low.ctx, newSession(), "mute", [planMuteOrBleep([], { from: speed.id, to: great.id }, "mute")]).answer.warnings.join(" ")).toMatch(/low confidence/);
    const g = atoms.find((a) => a.text === "great.")!;
    expect(submitOperations(ctx, newSession(), "bleep great", [planMuteOrBleep([], { from: g.id, to: g.id }, "bleep")]).answer.warnings).toEqual([]);
  });
  it("the effect id counts edit entries, and the effect stays on its word after a cut before it", () => {
    const g = atoms.find((a) => a.text === "great.")!;
    const log = edit(edit([], cutOp(ctx, 0, 30 * U)), planMuteOrBleep(edit([], cutOp(ctx, 0, 30 * U)), { from: g.id, to: g.id }, "bleep"));
    const tl = materialize(ctx, log);
    expect(tl.effects[0]!.id).toBe(nextEffectId(edit([], cutOp(ctx, 0, 30 * U))));
    expect(effectDisplay(ctx, tl, tl.effects[0]!)).toMatchObject({ startUs: 61_600_000, endUs: 62 * U }); // 91.6-92.0 minus 30 s
  });
});

describe("caption edits: text, colour, size, position", () => {
  const welcome = atomStartingAt(atoms, 42 * U);
  const channel = atomEndingAt(atoms, 44 * U);
  const base = () => submitOperations(ctx, newSession(), "caption", [captionOp("fx_0_0", welcome.id, channel.id, "Welcome!")]).state;

  it("each edit changes only its field and keeps the anchor", () => {
    let s = base();
    const get = () => {
      const f = findEffect(currentTimeline(ctx, s), "caption");
      if (f.kind !== "one") throw new Error("expected one caption");
      return f.effect;
    };
    s = submitOperations(ctx, s, "red", [planUpdateCaption(get(), { color: "#ff0000" })]).state;
    s = submitOperations(ctx, s, "bigger", [planUpdateCaption(get(), { sizePt: 48 })]).state;
    s = submitOperations(ctx, s, "top", [planUpdateCaption(get(), { position: "top" })]).state;
    s = submitOperations(ctx, s, "retext", [planUpdateCaption(get(), { text: "Hello!" })]).state;
    s = submitOperations(ctx, s, "not bold", [planUpdateCaption(get(), { bold: false })]).state;
    expect(get().params).toEqual({ kind: "caption", text: "Hello!", style: { color: "#ff0000", sizePt: 48, bold: false }, position: "top" });
    expect(get().range).toEqual({ from: welcome.id, to: channel.id });
  });
  it("a bad colour or size is refused; a non-caption cannot be edited", () => {
    const e = findEffect(currentTimeline(ctx, base()), "caption");
    if (e.kind !== "one") throw new Error("one caption");
    expect(() => planUpdateCaption(e.effect, { color: "red" })).toThrow(/#rrggbb/);
    expect(() => planUpdateCaption(e.effect, { sizePt: 0 })).toThrow();
    expect(() => planUpdateCaption({ ...e.effect, params: { kind: "bleep" } }, { text: "x" })).toThrow(/not a caption/);
  });
  it("'make it bigger' with no caption: the lookup says none (the caller rejects instead of guessing)", () => {
    expect(findEffect(materialize(ctx, []), "caption").kind).toBe("none");
  });
});

describe("background music: speech segments and the ducking envelope", () => {
  const T = tiny(
    [
      { text: "a", startUs: 2_000_000, endUs: 3_000_000 },
      { text: "b", startUs: 3_000_000, endUs: 4_000_000 },
      { text: "c", startUs: 7_000_000, endUs: 8_000_000 },
    ],
    10_000_000,
  );
  const music: MusicParams = { assetSha256: "f".repeat(64), gainCentiDb: -600, duckCentiDb: 1800, attackUs: 200_000, releaseUs: 500_000 };

  it("speech segments are the words of the final output, touching words merged", () => {
    expect(speechSegments(T.ctx, materialize(T.ctx, []))).toEqual([{ startUs: 2_000_000, endUs: 4_000_000 }, { startUs: 7_000_000, endUs: 8_000_000 }]);
  });

  it("envelope: fully ducked when speech starts, back to base releaseUs after it ends (exact keyframes)", () => {
    const frames = duckingEnvelope(T.ctx, materialize(T.ctx, []), music);
    expect(frames).toEqual([
      { timeUs: 0, gainCentiDb: -600 },
      { timeUs: 1_800_000, gainCentiDb: -600 },
      { timeUs: 2_000_000, gainCentiDb: -2400 },
      { timeUs: 4_000_000, gainCentiDb: -2400 },
      { timeUs: 4_500_000, gainCentiDb: -600 },
      { timeUs: 6_800_000, gainCentiDb: -600 },
      { timeUs: 7_000_000, gainCentiDb: -2400 },
      { timeUs: 8_000_000, gainCentiDb: -2400 },
      { timeUs: 8_500_000, gainCentiDb: -600 },
      { timeUs: 10_000_000, gainCentiDb: -600 },
    ]);
  });

  it("speech from time 0 starts ducked; speech to the very end stays ducked; no speech is a flat line", () => {
    const edge = tiny([{ text: "a", startUs: 0, endUs: 1_000_000 }, { text: "b", startUs: 4_000_000, endUs: 5_000_000 }], 5_000_000);
    const f = duckingEnvelope(edge.ctx, materialize(edge.ctx, []), music);
    expect(f[0]).toEqual({ timeUs: 0, gainCentiDb: -2400 });
    expect(f.at(-1)).toEqual({ timeUs: 5_000_000, gainCentiDb: -2400 });
    const silent = tiny([], 3_000_000);
    expect(duckingEnvelope(silent.ctx, materialize(silent.ctx, []), music)).toEqual([{ timeUs: 0, gainCentiDb: -600 }, { timeUs: 3_000_000, gainCentiDb: -600 }]);
  });

  it("speech closer than attack + release is one ducked stretch (the music cannot recover in between)", () => {
    const close = tiny([{ text: "a", startUs: 1_000_000, endUs: 2_000_000 }, { text: "b", startUs: 2_600_000, endUs: 3_000_000 }], 5_000_000);
    const times = duckingEnvelope(close.ctx, materialize(close.ctx, []), music).map((k) => [k.timeUs, k.gainCentiDb]);
    expect(times).toEqual([[0, -600], [800_000, -600], [1_000_000, -2400], [3_000_000, -2400], [3_500_000, -600], [5_000_000, -600]]);
    const apart = tiny([{ text: "a", startUs: 1_000_000, endUs: 2_000_000 }, { text: "b", startUs: 2_800_000, endUs: 3_000_000 }], 5_000_000);
    expect(duckingEnvelope(apart.ctx, materialize(apart.ctx, []), music).some((k) => k.timeUs === 2_500_000 && k.gainCentiDb === -600)).toBe(true);
  });

  it("follows the final timeline: a cut shifts the keyframes, a speed-up shortens the ducked stretches", () => {
    const cutFirst = materialize(T.ctx, edit([], cutOp(T.ctx, 0, 1_000_000)));
    expect(duckingEnvelope(T.ctx, cutFirst, music)[2]).toEqual({ timeUs: 1_000_000, gainCentiDb: -2400 });
    const fast = materialize(T.ctx, edit([], { type: "set_speed", span: span(T.ctx, 2_000_000, 4_000_000), rate: { num: 2, den: 1 } }));
    expect(speechSegments(T.ctx, fast)[0]).toEqual({ startUs: 2_000_000, endUs: 3_000_000 });
  });

  it("keyframe times strictly increase and stay inside the video", () => {
    const f = duckingEnvelope(ctx, materialize(ctx, []), music);
    f.forEach((k, i) => {
      expect(k.timeUs).toBeGreaterThanOrEqual(0);
      expect(k.timeUs).toBeLessThanOrEqual(200 * U);
      if (i > 0) expect(k.timeUs).toBeGreaterThan(f[i - 1]!.timeUs);
    });
  });
});

describe("hard cases", () => {
  it('"undo the second-to-last cut but keep the music": the music op stays, the later cut stays, only that cut returns', () => {
    const music: MusicParams = { assetSha256: "e".repeat(64), gainCentiDb: -1200, duckCentiDb: 1500, attackUs: 100_000, releaseUs: 400_000 };
    let s = submitOperations(ctx, newSession(), "cut pricing", [cutOp(ctx, 108 * U, 113 * U)]).state; // group 1 (a cut)
    s = submitOperations(ctx, s, "add music", [{ type: "set_music", music }]).state; // group 2
    s = submitOperations(ctx, s, "cut a section", [cutOp(ctx, 130 * U, 140 * U)]).state; // group 3 (second-to-last cut)
    s = submitOperations(ctx, s, "cut another", [cutOp(ctx, 160 * U, 170 * U)]).state; // group 4 (last cut)
    expect(currentTimeline(ctx, s).durationUs).toBe(175 * U);
    const t = submitOperations(ctx, s, "undo the second-to-last cut but keep the music", [{ type: "restore", targetGroup: 3 }]);
    const tl = currentTimeline(ctx, t.state);
    expect(tl.music).toEqual(music);
    expect(tl.durationUs).toBe(185 * U); // 130-140 is back; 108-113 and 160-170 are still cut
    const pieces = timelinePieces(ctx, tl);
    expect(atomOutSpan(pieces, atomStartingAt(atoms, 130 * U))).not.toBeNull();
    expect(atomOutSpan(pieces, atomStartingAt(atoms, 160 * U))).toBeNull();
    expect(atomOutSpan(pieces, atomStartingAt(atoms, 108 * U))).toBeNull();
  });

  it("a section reordered, then a word inside it muted: the mute sits on the word at its NEW place", () => {
    const move: Operation = { type: "move", span: span(ctx, 90 * U, 92 * U), before: at(98 * U) };
    let s = submitOperations(ctx, newSession(), "move", [move]).state;
    const speed = atoms.find((a) => a.text === "speed")!;
    const t = submitOperations(ctx, s, "mute 'speed'", [planMuteOrBleep(s.log, { from: speed.id, to: speed.id }, "mute")]);
    s = t.state;
    const tl = currentTimeline(ctx, s);
    expect(t.answer.status).toBe("applied");
    expect(effectDisplay(ctx, tl, tl.effects[0]!)).toMatchObject({ startUs: 96_800_000, endUs: 97_200_000 }); // 96.0 + 0.8 .. 97.2
    // undoing the mute and then the move still works in order
    expect(submitUndo(ctx, submitUndo(ctx, s, "u1").state, "u2").answer.timelineHash).toBe(timelineHash(materialize(ctx, [])));
  });

  it("caption added, sentence reordered, sentence cut, cut restored: the caption returns at the moved place", () => {
    const first = atomStartingAt(atoms, 90 * U);
    const last = atomEndingAt(atoms, 92 * U);
    let s = submitOperations(ctx, newSession(), "caption", [captionOp("fx_0_0", first.id, last.id, "Speed")]).state; // g1
    s = submitOperations(ctx, s, "move", [{ type: "move", span: span(ctx, 90 * U, 92 * U), before: at(98 * U) }]).state; // g2
    const cut = submitOperations(ctx, s, "cut it", [cutOp(ctx, 90 * U, 92 * U)]); // g3
    expect(cut.answer.warnings.join(" ")).toMatch(/caption "Speed" is hidden/);
    const back = submitOperations(ctx, cut.state, "put it back", [{ type: "restore", targetGroup: 3 }]);
    const tl = currentTimeline(ctx, back.state);
    expect(tl.effects[0]).toMatchObject({ state: "active", fragmented: false });
    expect(effectDisplay(ctx, tl, tl.effects[0]!)).toMatchObject({ startUs: 96 * U, endUs: 98 * U });
  });
});

describe("keep only a range", () => {
  it("keeps just the span (edited-time resolved), keeps captions on kept words, drops the rest", () => {
    const first = atomStartingAt(atoms, 90 * U);
    const last = atomEndingAt(atoms, 92 * U);
    const s0 = submitOperations(ctx, newSession(), "caption", [captionOp("fx_0_0", first.id, last.id, "Keep")]).state;
    const t = submitOperations(ctx, s0, "keep only 1:30-1:40", [{ type: "keep_only", span: span(ctx, 90 * U, 100 * U) }]);
    expect(t.answer.durationUs).toBe(10 * U);
    const tl = currentTimeline(ctx, t.state);
    expect(effectDisplay(ctx, tl, tl.effects[0]!)).toMatchObject({ startUs: 0, endUs: 2 * U });
  });
  it("keep_only after a cut keeps only what survives inside the span", () => {
    const log = edit(edit([], cutOp(ctx, 92 * U, 98 * U)), { type: "keep_only", span: span(ctx, 90 * U, 100_400_000) });
    expect(materialize(ctx, log).durationUs).toBe(4_400_000); // [90,92) + [98,100.4)
  });
  it("keeping a range that is entirely cut would leave nothing and is rejected", () => {
    const t = submitOperations(ctx, { log: edit([], cutOp(ctx, 90 * U, 92 * U)), conversation: [] }, "keep", [{ type: "keep_only", span: span(ctx, 90 * U, 92 * U) }]);
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/whole video/);
  });
  it("sanity: RED and WHITE helpers differ (keeps the import honest)", () => {
    expect(RED.color).not.toBe(WHITE.color);
  });
});

describe("submitPlan", () => {
  it("passes planner warnings into the answer", async () => {
    const { submitPlan } = await import("../src/session");
    const um = atoms.find((a) => a.text === "Uh")!;
    const withBleep = materialize(ctx, edit([], planMuteOrBleep([], { from: um.id, to: um.id }, "bleep")));
    const t = submitPlan(ctx, newSession(), "remove the fillers", planRemoveFillers(ctx, withBleep));
    expect(t.answer.status).toBe("applied");
    expect(t.answer.warnings.join(" ")).toMatch(/Kept the filler "Uh"/);
  });
  it("an empty plan is a normal rejection, not an empty edit; repeating a removal ends up here", async () => {
    const { submitPlan } = await import("../src/session");
    const first = submitPlan(ctx, newSession(), "remove the fillers", planRemoveFillers(ctx, materialize(ctx, [])));
    const again = submitPlan(ctx, first.state, "remove the fillers", planRemoveFillers(ctx, currentTimeline(ctx, first.state)), { nothingToDo: "There are no filler words left." });
    expect(again.answer.status).toBe("rejected");
    expect(again.answer.reason).toBe("There are no filler words left.");
    expect(again.state.log).toEqual(first.state.log);
  });
});
