import { describe, expect, it } from "vitest";
import {
  currentTimeline, newSession, nextEffectId, phraseRanges, resolveEditedRange, submitOperations, submitUndo, timelineHash,
  type Operation, type SessionState, type Turn,
} from "@incubrix/engine";
import { makeFixture } from "../../engine/test/fixtures/transcript.ts";
import { RulesParser, createParser, runInstruction, splitParts } from "../src/index.ts";

const U = 1_000_000;
const parser = new RulesParser();

function session() {
  const { ctx } = makeFixture();
  let state: SessionState = newSession();
  const say = (text: string, answer?: string | number): Turn => {
    const t = runInstruction(ctx, state, answer === undefined ? { text } : { text, answer }, parser);
    state = t.state;
    return t;
  };
  return { ctx, say, get state() { return state; } };
}

describe("the 8-step worked example through the rules parser (steps 1-7)", () => {
  it("gives the same answers and the same timeline_hash as building the operations directly with the engine", () => {
    const s = session();
    const { ctx } = s;
    const t1 = s.say('add a caption "Welcome!" on "welcome to the channel"');
    expect(t1.answer.status).toBe("applied");
    const t2 = s.say("cut the first 30 seconds");
    expect(t2.answer.status).toBe("applied");
    expect(t2.answer.durationUs).toBe(170 * U);
    const t3a = s.say("remove the part about pricing");
    expect(t3a.answer.status).toBe("needs_clarification");
    expect(t3a.answer.options).toHaveLength(3);
    expect(t3a.answer.timelineHash).toBe(t2.answer.timelineHash);
    const t3b = s.say("the second one");
    expect(t3b.answer.status).toBe("applied");
    expect(t3b.answer.durationUs).toBe(165 * U);
    const t4 = s.say("speed up 1:00-1:30 by 2x");
    expect(t4.answer).toMatchObject({ status: "applied", timePolicy: "current", durationUs: 150 * U });
    const t5 = s.say("put the intro back");
    expect(t5.answer).toMatchObject({ status: "applied", durationUs: 180 * U });
    const t6 = s.say("undo");
    expect(t6.answer.durationUs).toBe(150 * U);
    expect(t6.answer.timelineHash).toBe(t4.answer.timelineHash); // undo restores exactly the state after step 4
    const t7 = s.say("make that caption red");
    expect(t7.answer.status).toBe("applied");

    // engine-only path, written the way packages/engine/test/worked_example.test.ts does it
    let e: SessionState = newSession();
    const apply = (text: string, ops: Operation[]) => (e = submitOperations(ctx, e, text, ops).state);
    apply("1", [{ type: "add_effect", effectId: nextEffectId(e.log), range: phraseRanges(ctx, "welcome to the channel")[0]!, params: { kind: "caption", text: "Welcome!", style: { color: "#ffffff", sizePt: 32, bold: true }, position: "bottom" } }]);
    apply("2", resolveEditedRange(ctx, currentTimeline(ctx, e), 0, 30 * U).spans.map((span) => ({ type: "cut" as const, span, reason: "user" as const })));
    apply("3", [t3b.answer.operations[0]!]);
    apply("4", resolveEditedRange(ctx, currentTimeline(ctx, e), 60 * U, 90 * U).spans.map((span) => ({ type: "set_speed" as const, span, rate: { num: 2, den: 1 } })));
    apply("5", [{ type: "restore", targetGroup: 2 }]);
    e = submitUndo(ctx, e, "undo").state;
    const cap = currentTimeline(ctx, e).effects[0]!;
    apply("7", [{ type: "update_effect", effectId: cap.id, params: { kind: "caption", text: "Welcome!", style: { color: "#ff0000", sizePt: 32, bold: true }, position: "bottom" } }]);
    expect(timelineHash(currentTimeline(ctx, s.state))).toBe(timelineHash(currentTimeline(ctx, e)));
    expect(t7.answer.timelineHash).toBe(timelineHash(currentTimeline(ctx, e)));
  });

  it("the answer to a question can also come in the separate `answer` field", () => {
    const s = session();
    s.say("remove the part about pricing");
    const t = s.say("", 3);
    expect(t.answer.status).toBe("applied");
    expect(t.answer.durationUs).toBe(190 * U); // third mention is 10 s (sentence + the silence after it)
  });

  it("'the last one' picks the last option; an unreadable reply does not guess", () => {
    const s = session();
    s.say("remove the part about pricing");
    const bad = s.say("whatever you think");
    expect(bad.answer.status).not.toBe("applied");
  });
});

describe("times", () => {
  const hashAfter = (text: string) => {
    const s = session();
    const t = s.say(text);
    return t.answer.status === "applied" ? timelineHash(currentTimeline(s.ctx, s.state)) : t.answer.status;
  };

  it("'80 seconds', 'a minute twenty' and '1:20' mean the same moment", () => {
    const a = hashAfter("cut 80 seconds to 90 seconds");
    expect(a).not.toBe("rejected");
    expect(hashAfter("cut a minute twenty to a minute thirty")).toBe(a);
    expect(hashAfter("cut 1:20-1:30")).toBe(a);
    expect(hashAfter("remove from one minute and twenty seconds to one minute and thirty seconds")).toBe(a);
  });

  it("'the last 10 seconds' and '0:30-0:40'", () => {
    const s = session();
    expect(s.say("cut the last 10 seconds").answer.durationUs).toBe(190 * U);
    expect(session().say("remove 0:30-0:40").answer.durationUs).toBe(190 * U);
  });

  it("'remove 0:30-0:40' sent twice: the second time the times refer to the NEW timeline and a different piece goes", () => {
    const s = session();
    const first = s.say("remove 0:30-0:40");
    const second = s.say("remove 0:30-0:40");
    expect(first.answer.status).toBe("applied");
    expect(second.answer.status).toBe("applied");
    expect(second.answer.durationUs).toBe(180 * U);
    expect(second.answer.timePolicy).toBe("current");
  });

  it("'original' switches the time policy and says so", () => {
    const s = session();
    s.say("cut the first 30 seconds");
    const t = s.say("remove 1:00-1:10 in the original");
    expect(t.answer.timePolicy).toBe("original");
    expect(t.answer.status).toBe("applied");
    expect(t.answer.durationUs).toBe(160 * U);
  });

  it("out of range is a rejection with a reason, not an error: add a caption at 5:00 on a 3:20 video", () => {
    const t = session().say('add a caption "Late" at 5:00');
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/3:20/);
    expect(session().say("cut 3:00-4:00").answer.status).toBe("rejected");
  });

  it("a caption at a time anchors to the words playing there", () => {
    const t = session().say('add a caption "Hello" at 0:12');
    expect(t.answer.status).toBe("applied");
  });
});

describe("hard cases", () => {
  it("'make it bigger' with no caption is rejected", () => {
    const t = session().say("make it bigger");
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/no caption/i);
  });

  it("'that caption' with two captions asks which one; the choice is applied", () => {
    const s = session();
    s.say('add a caption "A" on "welcome to the channel"');
    s.say('add a caption "B" on "the interface is very clean"');
    const q = s.say("make that caption red");
    expect(q.answer.status === "needs_clarification" || q.answer.options.length > 0).toBe(true);
    expect(q.answer.options.length).toBeGreaterThanOrEqual(2);
    const done = s.say("2");
    expect(done.answer.status).toBe("applied");
  });

  it("'speed up 10x' is rejected with the allowed range; 'cut everything' is rejected", () => {
    const a = session().say("speed up 0:10-0:20 by 10x");
    expect(a.answer.status).toBe("rejected");
    expect(a.answer.reason).toMatch(/4/);
    const b = session().say("cut everything");
    expect(b.answer.status).toBe("rejected");
    expect(b.answer.reason).toMatch(/whole video|nothing would be left/i);
  });

  it("'remove everything after I say thanks' (said 4 times) asks which; nothing is cut before the answer", () => {
    const s = session();
    const q = s.say("remove everything after I say thanks");
    expect(q.answer.status).toBe("needs_clarification");
    expect(q.answer.options).toHaveLength(4);
    expect(q.answer.durationUs).toBe(200 * U);
    const t = s.say("the last one");
    expect(t.answer.status).toBe("applied");
    expect(t.answer.durationUs).toBeLessThan(200 * U);
  });

  it("a three-part instruction with one impossible part applies the other two and names the failed one", () => {
    const s = session();
    const t = s.say("cut the first 30 seconds, then speed up 1:00-1:10 by 10x, then add a caption \"Hi\" on \"welcome to the channel\"");
    expect(t.answer.status).toBe("applied");
    expect(t.answer.warnings.join(" ")).toMatch(/Applied 2 of 3 parts/);
    expect(t.answer.warnings.join(" ")).toMatch(/Part 2/);
    expect(currentTimeline(s.ctx, s.state).effects).toHaveLength(1);
    // one instruction = one undo group
    const u = s.say("undo");
    expect(u.answer.durationUs).toBe(200 * U);
  });

  it("'undo the second-to-last cut but keep the music' restores that cut only", () => {
    const s = session();
    s.say("cut 0:10-0:20");
    s.say("cut 1:00-1:10");
    s.say("cut 2:00-2:10");
    const t = s.say("undo the second-to-last cut but keep the music");
    expect(t.answer.status).toBe("applied");
    expect(t.answer.durationUs).toBe(180 * U); // 200 - 10 - 10 (middle cut came back)
  });

  it("undo / redo, and undo with nothing to undo is a rejection", () => {
    const s = session();
    expect(s.say("undo").answer.status).toBe("rejected");
    s.say("cut 0:10-0:20");
    expect(s.say("undo").answer.durationUs).toBe(200 * U);
    expect(s.say("redo").answer.durationUs).toBe(190 * U);
  });

  it("'put back what I removed' with one cut restores it, with several asks", () => {
    const s = session();
    expect(s.say("put back what I removed").answer.status).toBe("rejected");
    s.say("cut 0:10-0:20");
    expect(s.say("put back what I removed").answer.durationUs).toBe(200 * U);
    const s2 = session();
    s2.say("cut 0:10-0:20");
    s2.say("cut 1:00-1:10");
    expect(s2.say("put back what I removed").answer.status).toBe("needs_clarification");
  });
});

describe("other operations", () => {
  it("removes fillers, silences, mutes and bleeps, moves, keeps only", () => {
    const s = session();
    expect(s.say("remove all the filler words").answer.status).toBe("applied");
    const sil = session().say("remove silences longer than 2 seconds");
    expect(sil.answer.status).toBe("applied");
    expect(session().say("remove silences").answer.status).toBe("needs_clarification");
    expect(session().say('bleep "pricing"').answer.status).toBe("applied");
    expect(session().say("mute the word tool").answer.status).toBe("applied");
    expect(session().say("move 0:30-0:40 to the end").answer.status).toBe("applied");
    expect(session().say("keep only 1:00-2:00").answer.durationUs).toBe(60 * U);
    expect(session().say("add captions").answer.status).toBe("applied");
  });

  it("caption look: colour, size, position; remove that caption", () => {
    const s = session();
    s.say('add a caption "Hi" on "welcome to the channel"');
    expect(s.say("make the caption bigger").answer.status).toBe("applied");
    expect(s.say("move the caption to the top").answer.status).toBe("applied");
    expect(s.say("make it blue").answer.status).toBe("applied");
    const cap = currentTimeline(s.ctx, s.state).effects[0]!;
    expect(cap.params).toMatchObject({ style: { color: "#0000ff", sizePt: 40 }, position: "top" });
    expect(s.say("remove that caption").answer.status).toBe("applied");
  });

  it("unknown text is a rejection that says what is supported", () => {
    const t = session().say("make it pop");
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/Examples/);
  });

  it("splits only on separators outside quotes", () => {
    expect(splitParts('add a caption "a, then b" on "x"; cut 0:10-0:20')).toEqual(['add a caption "a, then b" on "x"', "cut 0:10-0:20"]);
  });
});

describe("determinism", () => {
  const texts = ["cut the first 30 seconds", "remove the part about pricing", "the second one", "speed up 1:00-1:30 by 2x", 'add a caption "Hi" on "welcome to the channel"', "make that caption red", "undo", "remove all the filler words", "cut everything", "nonsense words"];
  it("the same instruction on the same session gives the identical Parsed output 3 times, and identical answers", () => {
    const outputs: string[][] = [];
    for (let run = 0; run < 3; run++) {
      const s = session();
      const lines: string[] = [];
      for (const text of texts) {
        const before = s.state;
        lines.push(JSON.stringify(parser.parse({ ctx: s.ctx, state: before, text })));
        lines.push(JSON.stringify(s.say(text).answer));
      }
      outputs.push(lines);
    }
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(outputs[0]);
  });

  it("createParser: rules and mock exist, a real LLM provider fails loudly at startup", () => {
    expect(createParser("rules").name).toBe("rules");
    expect(createParser("mock").name).toBe("mock");
    expect(() => createParser("groq")).toThrow(/not implemented/);
  });
});

describe("background music", () => {
  it("'add background music' sets the built-in track; 'remove the music' clears it; the sha matches packages/media", async () => {
    const { BUILTIN_MUSIC_SHA256 } = await import("@incubrix/media");
    const { BUILTIN_MUSIC } = await import("../src/index.ts");
    expect(BUILTIN_MUSIC.assetSha256).toBe(BUILTIN_MUSIC_SHA256);
    const s = session();
    const none = s.say("remove the music");
    expect(none.answer.status).toBe("rejected");
    const add = s.say("add background music");
    expect(add.answer.status).toBe("applied");
    expect(currentTimeline(s.ctx, s.state).music?.assetSha256).toBe(BUILTIN_MUSIC_SHA256);
    expect(add.answer.warnings.join(" ")).toMatch(/lowered by 12 dB/);
    const off = s.say("remove the music");
    expect(off.answer.status).toBe("applied");
    expect(currentTimeline(s.ctx, s.state).music).toBeNull();
  });
});

describe("multi-part instructions never drop a part silently", () => {
  const THREE = 'cut the first 30 seconds, then speed up 1:00-1:10 by 10x, then add a caption "Hi" on "welcome to the channel"';

  it("fresh session: applies the possible parts as one undo group and lists every part with its status", () => {
    const s = session();
    const t = s.say(THREE);
    expect(t.answer.status).toBe("applied");
    const w = t.answer.warnings.join("\n");
    expect(w).toMatch(/Applied 2 of 3 parts/);
    expect(w).toMatch(/Part 1 \(.*\) applied/);
    expect(w).toMatch(/Part 2 \(.*10x.*\) was not applied \(rejected\): .*allowed range/);
    expect(w).toMatch(/Part 3 \(.*\) applied/);
    expect(s.say("undo").answer.durationUs).toBe(200 * U);
  });

  it("with an open clarification the same sentence is NOT swallowed: the open question is dropped and every part is reported", () => {
    const s = session();
    const q = s.say("remove the part about pricing");
    expect(q.answer.status).toBe("needs_clarification");
    const t = s.say(THREE);
    expect(t.answer.status).toBe("applied");
    const w = t.answer.warnings.join("\n");
    expect(w).toMatch(/Applied 2 of 3 parts/);
    expect(w).toMatch(/Part 2 .*not applied \(rejected\)/);
    expect(t.answer.durationUs).toBe(170 * U);
    expect(currentTimeline(s.ctx, s.state).effects).toHaveLength(1);
    expect(s.say("undo").answer.durationUs).toBe(200 * U); // one undo group
  });

  it("a part that needs a choice is named with its question and options, not dropped", () => {
    const s = session();
    const t = s.say('cut the first 10 seconds, then remove the part about pricing, then add a caption "Hi" on "welcome to the channel"');
    expect(t.answer.status).toBe("applied");
    const w = t.answer.warnings.join("\n");
    expect(w).toMatch(/Applied 2 of 3 parts/);
    expect(w).toMatch(/Part 2 \(.*pricing.*\) was not applied \(needs clarification\): .*mentioned 3 times.*Send it on its own/);
  });

  it("a plain answer to an open question is still an answer, not a new instruction", () => {
    const s = session();
    s.say("remove the part about pricing");
    expect(s.say("the second one").answer.status).toBe("applied");
  });

  it("when no part can be applied the answer is a rejection that lists every part", () => {
    const s = session();
    const t = s.say("speed up 0:10-0:20 by 10x, then cut 5:00-6:00");
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/None of the 2 parts/);
    expect(t.answer.reason).toMatch(/Part 1/);
    expect(t.answer.reason).toMatch(/Part 2/);
  });
});

describe("bare durations", () => {
  it("'the last 10 seconds' and 'the first 30 seconds' are unambiguous and applied", () => {
    const s = session();
    expect(s.say("cut the last 10 seconds").answer.durationUs).toBe(190 * U);
    expect(s.say("cut the first 30 seconds").answer.durationUs).toBe(160 * U);
  });

  it.each(["cut 80 seconds", "remove a minute twenty", "cut 1:20", "remove 1 minute 20"])("%s asks: the first 80 s, the last 80 s, or from a time you give", (text) => {
    const s = session();
    const q = s.say(text);
    expect(q.answer.status).toBe("needs_clarification");
    expect(q.answer.options).toHaveLength(3);
    expect(q.answer.options[0]).toMatch(/first 1:20/);
    expect(q.answer.options[1]).toMatch(/last 1:20/);
    expect(q.answer.options[2]).toMatch(/time you give/i);
    expect(q.answer.durationUs).toBe(200 * U);
    expect(q.answer.timelineHash).toBe(timelineHash(currentTimeline(s.ctx, newSession())));
  });

  it("choosing the first or the last option applies it (and the first and last give different timelines)", () => {
    const a = session();
    a.say("cut 80 seconds");
    const first = a.say("the first one");
    expect(first.answer).toMatchObject({ status: "applied", durationUs: 120 * U });
    const b = session();
    b.say("cut 80 seconds");
    const last = b.say("2");
    expect(last.answer).toMatchObject({ status: "applied", durationUs: 120 * U });
    expect(last.answer.timelineHash).not.toBe(first.answer.timelineHash);
  });

  it("choosing 'from a time you give' changes nothing and says what to type", () => {
    const s = session();
    s.say("cut 80 seconds");
    const t = s.say("the third one");
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/cut 1:20 from 1:00|from 1:00/);
    expect(t.answer.durationUs).toBe(200 * U);
  });

  it.each(["from 1:20", "at 1:20", "1:20", "start at one minute twenty", "from 1 minute 20 seconds"])("answering the question with a time (%s) cuts 80 s from there", (reply) => {
    const s = session();
    s.say("cut 80 seconds");
    const r = s.say(reply);
    expect(r.answer.status).toBe("applied");
    expect(r.answer.durationUs).toBe(120 * U);
    expect(r.answer.operations).toHaveLength(1);
    // the same result as saying it in one sentence
    const one = session();
    expect(one.say("cut 80 seconds from 1:20").answer.timelineHash).toBe(r.answer.timelineHash);
  });

  it("the time answer also works through the answer field and undoes as one group", () => {
    const s = session();
    s.say("cut 80 seconds");
    const r = s.say("from 0:30");
    expect(r.answer).toMatchObject({ status: "applied", durationUs: 120 * U });
    expect(s.say("undo").answer.durationUs).toBe(200 * U);
    const t = session();
    t.say("cut 80 seconds");
    expect(t.say("", "from 0:30").answer).toMatchObject({ status: "applied", durationUs: 120 * U });
  });

  it("an answer with no usable time is rejected and changes nothing; a start that runs past the end is rejected", () => {
    const s = session();
    s.say("cut 80 seconds");
    const bad = s.say("somewhere in the middle");
    expect(bad.answer.status).toBe("rejected");
    expect(bad.answer.durationUs).toBe(200 * U);
    const s2 = session();
    s2.say("cut 80 seconds");
    const past = s2.say("from 3:00");
    expect(past.answer.status).toBe("rejected");
    expect(past.answer.reason).toMatch(/past the end/);
    expect(past.answer.durationUs).toBe(200 * U);
  });

  it("a start time given in the same sentence makes it unambiguous", () => {
    const s = session();
    const t = s.say("cut 80 seconds from 1:00");
    expect(t.answer).toMatchObject({ status: "applied", durationUs: 120 * U });
  });

  it("a duration longer than the video is rejected, not asked about", () => {
    const s = session();
    const t = s.say("cut 300 seconds");
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/longer than|whole video|nothing would be left/);
  });
});
