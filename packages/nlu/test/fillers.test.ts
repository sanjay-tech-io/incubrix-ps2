import { describe, expect, it } from "vitest";
import { buildAtoms, createContext, currentTimeline, newSession, sha256Hex, sourceToEdited, timelinePieces, type SessionState, type Turn } from "@incubrix/engine";
import { makeFixture } from "../../engine/test/fixtures/transcript.ts";
import { RulesParser, runInstruction, type PossibleFiller } from "../src/index.ts";

const U = 1_000_000;
const parser = new RulesParser();
const marker = (a: number, b: number, conf = 350): PossibleFiller => ({ startUs: a * U, endUs: b * U, levelDb: -3, zcr: 0.07, touchesWord: false, confidencePermille: conf });

function driver(ctx: ReturnType<typeof createContext>, side: { possibleFillers?: PossibleFiller[] } = {}) {
  let state: SessionState = newSession();
  return {
    say(text: string, answer?: string | number): Turn {
      const input = answer === undefined ? { text, side } : { text, side, answer };
      const t = runInstruction(ctx, state, input, parser);
      state = t.state;
      return t;
    },
    timeline: () => currentTimeline(ctx, state),
  };
}

/** Words with no filler at all, silences between them: 0-1 s silence, "so we start", 1.4 s silence, "now it ends". */
function plainCtx() {
  const words = [["so", 1.0, 1.3], ["we", 1.3, 1.6], ["start", 1.6, 2.0], ["now", 4.0, 4.3], ["it", 4.3, 4.5], ["ends", 4.5, 5.0]] as const;
  const atoms = buildAtoms(sha256Hex("plain"), 8 * U, words.map(([text, a, b]) => ({ text, startUs: a * U, endUs: b * U })));
  return createContext({ sha256: sha256Hex("plain"), durationUs: 8 * U, fps: { num: 25, den: 1 }, hasAudio: true, hasVideo: true, variableFrameRate: false }, atoms);
}

const stillPlays = (tl: ReturnType<typeof currentTimeline>, ctx: ReturnType<typeof createContext>, us: number) => sourceToEdited(timelinePieces(ctx, tl), us) !== null;

describe("possible fillers (voiced gaps no word covers): never cut silently", () => {
  it("'remove the ums' cuts the TRANSCRIBED fillers and only LISTS the possible ones; they still play", () => {
    const { ctx } = makeFixture();
    const d = driver(ctx, { possibleFillers: [marker(4.1, 4.4), marker(9.1, 9.5)] }); // silences in the fixture
    const t = d.say("remove the ums");
    expect(t.answer.status).toBe("applied");
    expect(t.answer.warnings.join(" ")).toMatch(/2 possible untranscribed filler/i);
    expect(t.answer.warnings.join(" ")).toMatch(/0:04\.1/);
    const tl = d.timeline();
    expect(stillPlays(tl, ctx, 4.2 * U)).toBe(true);
    expect(stillPlays(tl, ctx, 9.2 * U)).toBe(true);
  });

  it("with NO transcribed filler it asks, with concrete options, and cuts only after the answer", () => {
    const ctx = plainCtx();
    const d = driver(ctx, { possibleFillers: [marker(2.5, 2.9, 450), marker(3.2, 3.5, 200)] });
    const q = d.say("remove the ums");
    expect(q.answer.status).toBe("needs_clarification");
    expect(q.answer.question).toMatch(/No transcribed filler words/);
    expect(q.answer.options).toHaveLength(2); // all 2, or only the most likely 1
    expect(q.answer.timelineHash).toBe(q.answer.timelineHash);
    expect(stillPlays(d.timeline(), ctx, 2.7 * U)).toBe(true); // nothing cut yet
    const a = d.say("the second one");
    expect(a.answer.status).toBe("applied");
    expect(stillPlays(d.timeline(), ctx, 2.7 * U)).toBe(false); // the likely one (conf 450) is cut
    expect(stillPlays(d.timeline(), ctx, 3.3 * U)).toBe(true); // the unlikely one stays
  });

  it("'remove the possible fillers' asks too, and answering 'the first one' cuts all of them", () => {
    const ctx = plainCtx();
    const d = driver(ctx, { possibleFillers: [marker(2.5, 2.9), marker(3.2, 3.5)] });
    const q = d.say("remove the possible fillers");
    expect(q.answer.status).toBe("needs_clarification");
    const a = d.say("the first one");
    expect(a.answer.status).toBe("applied");
    expect(stillPlays(d.timeline(), ctx, 2.7 * U)).toBe(false);
    expect(stillPlays(d.timeline(), ctx, 3.3 * U)).toBe(false);
  });

  it("without markers and without transcribed fillers it says so; a marker inside a part that is already cut is not offered", () => {
    const ctx = plainCtx();
    const none = driver(ctx).say("remove the ums");
    expect(none.answer.reason ?? none.answer.summary).toMatch(/No filler words were found/);
    const d = driver(ctx, { possibleFillers: [marker(2.5, 2.9)] });
    expect(d.say("cut 0:02-0:03").answer.status).toBe("applied");
    const q = d.say("remove the ums");
    expect(q.answer.status).not.toBe("needs_clarification"); // its only marker is gone with the cut
  });

  it("is deterministic: the same markers and instruction give the same hash 3 times", () => {
    const hashes = [0, 1, 2].map(() => {
      const ctx = plainCtx();
      const d = driver(ctx, { possibleFillers: [marker(2.5, 2.9), marker(3.2, 3.5)] });
      d.say("remove the ums");
      return d.say("the first one").answer.timelineHash;
    });
    expect(new Set(hashes).size).toBe(1);
  });
});
