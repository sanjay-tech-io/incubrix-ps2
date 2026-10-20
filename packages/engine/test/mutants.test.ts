import { describe, expect, it } from "vitest";
import { timelineHash } from "../src/hash";
import { appendEdit, appendRedo, appendUndo, editCount, nextEffectId, type Log } from "../src/log";
import { materialize } from "../src/replay";
import type { MusicParams, Operation } from "../src/types";
import { makeFixture } from "./fixtures/transcript";
import { cutOp, RED, WHITE } from "./helpers";

// Each block below was added because a reviewer broke the code and the suite still passed ("surviving mutant").
// Every assertion names the thing that must be part of the timeline / hash / numbering.

const { ctx, atoms } = makeFixture();
const edit = (log: Log, ...ops: Operation[]) => appendEdit(log, ops).log;
const hash = (log: Log) => timelineHash(materialize(ctx, log));

const MUSIC: MusicParams = { assetSha256: "e".repeat(64), gainCentiDb: -1200, duckCentiDb: 1800, attackUs: 100_000, releaseUs: 400_000 };

describe("music is part of the timeline and of the hash", () => {
  it("set_music appears in the timeline", () => {
    expect(materialize(ctx, edit([], { type: "set_music", music: MUSIC })).music).toEqual(MUSIC);
  });
  it("adding music changes the hash; each music parameter changes it; clearing music restores the original hash", () => {
    const none = hash([]);
    const withMusic = hash(edit([], { type: "set_music", music: MUSIC }));
    expect(withMusic).not.toBe(none);
    for (const changed of [
      { ...MUSIC, assetSha256: "d".repeat(64) },
      { ...MUSIC, gainCentiDb: -600 },
      { ...MUSIC, duckCentiDb: 900 },
      { ...MUSIC, attackUs: 50_000 },
      { ...MUSIC, releaseUs: 800_000 },
    ]) {
      expect(hash(edit([], { type: "set_music", music: changed }))).not.toBe(withMusic);
    }
    expect(hash(edit(edit([], { type: "set_music", music: MUSIC }), { type: "clear_music" }))).toBe(none);
  });
  it("the latest set_music wins", () => {
    const tl = materialize(ctx, edit(edit([], { type: "set_music", music: MUSIC }), { type: "set_music", music: { ...MUSIC, gainCentiDb: -300 } }));
    expect(tl.music?.gainCentiDb).toBe(-300);
  });
});

describe("effect ids count edit entries only, never undo/redo markers", () => {
  it("fx ids use the number of edit entries so far", () => {
    expect(nextEffectId([])).toBe("fx_0_0");
    const one = edit([], cutOp(ctx, 0, 10_000_000));
    expect(nextEffectId(one)).toBe("fx_1_0");
    expect(nextEffectId(one, 2)).toBe("fx_3_0"); // two more ops already queued in the same instruction
    expect(nextEffectId(one, 0, 4)).toBe("fx_1_4");
  });
  it("undo and redo markers do not advance the count", () => {
    let log = edit([], cutOp(ctx, 0, 10_000_000)); // 1 edit entry
    log = appendRedo(appendUndo(log)); // + 2 markers, log length is now 3
    log = appendUndo(log); // + 1 marker, length 4
    expect(log).toHaveLength(4);
    expect(editCount(log)).toBe(1);
    expect(nextEffectId(log)).toBe("fx_1_0");
    const more = edit(appendRedo(log), cutOp(ctx, 20_000_000, 30_000_000)); // redo marker + 1 more edit
    expect(editCount(more)).toBe(2);
    expect(nextEffectId(more)).toBe("fx_2_0");
  });
  it("an instruction with several ops counts every op entry", () => {
    const log = edit([], cutOp(ctx, 0, 10_000_000), cutOp(ctx, 20_000_000, 30_000_000), cutOp(ctx, 40_000_000, 50_000_000));
    expect(editCount(log)).toBe(3);
    expect(nextEffectId(log)).toBe("fx_3_0");
  });
});

// silence atoms: [0] is the 2 s lead-in; pick two distinct ones
const silences = atoms.filter((a) => a.kind === "silence");
const s1 = silences[0]!;
const s2 = silences[1]!;
const pause = (a: typeof s1): Operation => ({ type: "protect_pause", range: { from: a.id, to: a.id } });

describe("protected pauses are part of the timeline and of the hash", () => {
  it("protect_pause is stored in the timeline", () => {
    expect(materialize(ctx, edit([], pause(s1))).protectedPauses).toEqual([{ from: s1.id, to: s1.id }]);
  });
  it("protecting a pause changes the hash; protecting a different pause changes it again; unprotecting restores it", () => {
    const none = hash([]);
    const a = hash(edit([], pause(s1)));
    const b = hash(edit([], pause(s2)));
    expect(a).not.toBe(none);
    expect(b).not.toBe(none);
    expect(a).not.toBe(b);
    const unprotected = hash(edit(edit([], pause(s1)), { type: "unprotect_pause", range: { from: s1.id, to: s1.id } }));
    expect(unprotected).toBe(none);
  });
  it("the order the pauses were protected in does not change the hash (stored in source order)", () => {
    expect(hash(edit(edit([], pause(s1)), pause(s2)))).toBe(hash(edit(edit([], pause(s2)), pause(s1))));
    expect(materialize(ctx, edit(edit([], pause(s2)), pause(s1))).protectedPauses.map((p) => p.from)).toEqual([s1.id, s2.id]);
  });
  it("protecting the same pause twice is the same as once", () => {
    expect(hash(edit(edit([], pause(s1)), pause(s1)))).toBe(hash(edit([], pause(s1))));
  });
  it("only silence can be protected", () => {
    const word = atoms.find((a) => a.kind === "word")!;
    expect(() => materialize(ctx, edit([], { type: "protect_pause", range: { from: word.id, to: word.id } }))).toThrow(/silence/);
  });
});

describe("the auto-caption style is part of the timeline and of the hash", () => {
  it("auto_caption stores its style in the timeline", () => {
    expect(materialize(ctx, edit([], { type: "auto_caption", style: WHITE })).autoCaption).toEqual(WHITE);
  });
  it("turning auto-caption on changes the hash; a different style changes it again", () => {
    const none = hash([]);
    const white = hash(edit([], { type: "auto_caption", style: WHITE }));
    const red = hash(edit([], { type: "auto_caption", style: RED }));
    expect(white).not.toBe(none);
    expect(red).not.toBe(none);
    expect(red).not.toBe(white);
    expect(hash(edit([], { type: "auto_caption", style: { ...WHITE, sizePt: 48 } }))).not.toBe(white);
    expect(hash(edit([], { type: "auto_caption", style: { ...WHITE, bold: false } }))).not.toBe(white);
  });
  it("the latest style wins", () => {
    const tl = materialize(ctx, edit(edit([], { type: "auto_caption", style: WHITE }), { type: "auto_caption", style: RED }));
    expect(tl.autoCaption).toEqual(RED);
  });
});
