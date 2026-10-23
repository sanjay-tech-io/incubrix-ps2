import { describe, expect, it } from "vitest";
import { buildAtoms, createContext, currentTimeline, newSession, sha256Hex, sourceToEdited, timelinePieces, type EngineContext, type SessionState, type Turn } from "@incubrix/engine";
import { makeFixture } from "../../engine/test/fixtures/transcript.ts";
import { RulesParser, runInstruction, type SemanticHit, type SideData } from "../src/index.ts";

const U = 1_000_000;
const parser = new RulesParser();

function driver(ctx: EngineContext, side: SideData = {}) {
  let state: SessionState = newSession();
  return {
    say(text: string, answer?: string | number): Turn {
      const t = runInstruction(ctx, state, answer === undefined ? { text, side } : { text, side, answer }, parser);
      state = t.state;
      return t;
    },
    timeline: () => currentTimeline(ctx, state),
    plays: (us: number) => sourceToEdited(timelinePieces(ctx, currentTimeline(ctx, state)), us) !== null,
  };
}

describe("vague references ask, with concrete options", () => {
  it("'make it shorter' offers measurable cuts with the time each would save; nothing is cut before the answer", () => {
    const { ctx } = makeFixture();
    const d = driver(ctx);
    const before = d.timeline().durationUs;
    const q = d.say("make it shorter");
    expect(q.answer.status).toBe("needs_clarification");
    expect(q.answer.options!.length).toBeGreaterThanOrEqual(2);
    expect(q.answer.options!.join(" ")).toMatch(/filler|silence/i);
    expect(q.answer.options!.join(" ")).toMatch(/saves about \d/);
    expect(d.timeline().durationUs).toBe(before);
    const a = d.say("the first one");
    expect(a.answer.status).toBe("applied");
    expect(d.timeline().durationUs).toBeLessThan(before);
  });

  it("'remove the boring part' says it cannot judge boring, offers candidates picked by stated signals, and cuts only the chosen one", () => {
    const { ctx } = makeFixture();
    const d = driver(ctx);
    const q = d.say("remove the boring part");
    expect(q.answer.status).toBe("needs_clarification");
    expect(q.answer.question).toMatch(/cannot judge what is boring/i);
    expect(q.answer.options!.length).toBeGreaterThanOrEqual(2);
    expect(q.answer.options!.join(" ")).toMatch(/longest pause|fewest words|slowest/i);
    const before = d.timeline().durationUs;
    expect(d.say("the second one").answer.status).toBe("applied");
    expect(d.timeline().durationUs).toBeLessThan(before);
  });

  it("'that caption' with two captions asks which; 'put back what I removed' lists each removed edit; 'make it bigger' with no caption is rejected", () => {
    const { ctx } = makeFixture();
    const d = driver(ctx);
    expect(d.say("make it bigger").answer.status).toBe("rejected");
    d.say('add a caption "One" on "welcome to the channel"');
    d.say('add a caption "Two" on "I like this tool"');
    const q = d.say("make that caption red");
    expect(q.answer.status).toBe("needs_clarification");
    expect(q.answer.options).toHaveLength(2);
    d.say("the second one");
    d.say("cut 0:50-0:55");
    d.say("cut 1:00-1:05");
    const r = d.say("put back what I removed");
    expect(r.answer.status).toBe("needs_clarification");
    expect(r.answer.options!.join(" ")).toMatch(/edit \d+: removed original 0:50.*edit \d+: removed original 1:05|edit \d+: removed original/s);
    expect(r.answer.options!.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------- two speakers ----------
function twoSpeakers(extra: [number, string, string][] = []) {
  const lines: [number, string, string][] = [
    [1, "Welcome to the show today.", "SPEAKER_00"],
    [5, "So tell me about your old job.", "SPEAKER_00"],
    [9, "My old job was in a factory for ten years.", "SPEAKER_01"],
    [14, "The old job was hard but I learned a lot.", "SPEAKER_01"],
    [20, "What do you do now?", "SPEAKER_00"],
    [24, "Now I build software and I love it.", "SPEAKER_01"],
    ...extra,
  ];
  const words = lines.flatMap(([start, text, speaker]) => text.split(" ").map((w, i) => ({ text: w, startUs: Math.round((start + i * 0.4) * U), endUs: Math.round((start + i * 0.4 + 0.35) * U), speaker })));
  const atoms = buildAtoms(sha256Hex("two"), 40 * U, words);
  return createContext({ sha256: sha256Hex("two"), durationUs: 40 * U, fps: { num: 25, den: 1 }, hasAudio: true, hasVideo: true, variableFrameRate: false }, atoms);
}
const hit = (s: number, e: number, text: string, speaker: string, score = 500): SemanticHit => ({ startUs: s * U, endUs: e * U, text, scorePermille: score, speaker });

describe("'remove everything the guest says about <topic>'", () => {
  it("says it assumes the FIRST speaker is the host, cuts only the guest's lines about the topic, and ASKS about the host's lead-in", () => {
    const ctx = twoSpeakers();
    const d = driver(ctx, { semantic: { topic: "old job", hits: [hit(9, 12.6, "My old job was in a factory for ten years.", "SPEAKER_01"), hit(14, 17.2, "The old job was hard but I learned a lot.", "SPEAKER_01")] } });
    const q = d.say("remove everything the guest says about their old job");
    expect(q.answer.status).toBe("needs_clarification");
    expect(q.answer.question).toMatch(/assum\w+ Speaker A .*host/i);
    expect(q.answer.question).toMatch(/lead-in|question just before/i);
    expect(q.answer.options).toHaveLength(2);
    expect(q.answer.options![0]).toMatch(/only the guest's \(Speaker B\) 2 line/);
    expect(q.answer.options![1]).toMatch(/also.*So tell me about your old job/);
    expect(d.plays(10 * U)).toBe(true); // nothing is cut before the answer
    const a = d.say("the first one");
    expect(a.answer.status).toBe("applied");
    expect(d.plays(10 * U)).toBe(false); // guest line cut
    expect(d.plays(15 * U)).toBe(false);
    expect(d.plays(5.5 * U)).toBe(true); // host lead-in kept
    expect(d.plays(21 * U)).toBe(true); // host's next question kept
    expect(d.plays(25 * U)).toBe(true); // guest's line about something else kept
  });

  it("answering 'the second one' also removes the host's lead-in", () => {
    const ctx = twoSpeakers();
    const d = driver(ctx, { semantic: { topic: "old job", hits: [hit(9, 12.6, "My old job was in a factory for ten years.", "SPEAKER_01")] } });
    d.say("remove everything the guest says about their old job");
    expect(d.say("the second one").answer.status).toBe("applied");
    expect(d.plays(5.5 * U)).toBe(false);
    expect(d.plays(21 * U)).toBe(true);
  });

  it("with three speakers it asks WHICH speaker is the guest (Speaker A, B or C) with sample lines, and cuts nothing yet", () => {
    const ctx = twoSpeakers([[30, "I also worked an old job as a driver.", "SPEAKER_02"]]);
    const d = driver(ctx, { semantic: { topic: "old job", hits: [] } });
    const q = d.say("remove everything the guest says about their old job");
    expect(q.answer.status).toBe("needs_clarification");
    expect(q.answer.question).toMatch(/Speaker A, Speaker B or Speaker C/);
    expect(q.answer.options!.join(" ")).toMatch(/Speaker B.*My old job was in a factory/);
    expect(q.answer.options!.join(" ")).toMatch(/Speaker C.*driver/);
    expect(d.plays(10 * U)).toBe(true);
  });

  it("with one speaker it rejects and says so; an explicit 'speaker B' needs no assumption about who the host is", () => {
    const { ctx } = makeFixture();
    const one = driver(ctx).say("remove everything the guest says about pricing");
    expect(one.answer.status).toBe("rejected");
    expect(one.answer.reason).toMatch(/only one speaker/i);
    // The answer must not stop at "can't": it says the voices may have been merged and names the hint to use on upload.
    expect(one.answer.reason).toMatch(/num_speakers/);
    expect(one.answer.reason).toMatch(/merged|may have|could be/i);
    expect(one.answer.reason).toMatch(/upload (it|the video) again/i);
    expect(one.answer.reason).toMatch(/time, topic or phrase/i);
    const two = driver(twoSpeakers());
    const q = two.say("remove everything speaker B says about the old job");
    expect(q.answer.question).not.toMatch(/assum/i);
  });

  it("warns about a POSSIBLE LABEL SWAP when the guest lines it cuts were flagged by the swap detector", () => {
    const lines: [number, string, string][] = [[1, "So tell me about your old job.", "SPEAKER_00"], [5, "My old job was in a factory.", "SPEAKER_01"], [10, "And now I build software.", "SPEAKER_00"]];
    const words = lines.flatMap(([start, text, speaker]) => text.split(" ").map((w, i) => ({ text: w, startUs: Math.round((start + i * 0.4) * U), endUs: Math.round((start + i * 0.4 + 0.35) * U), speaker, possibleLabelSwap: speaker === "SPEAKER_01" })));
    const atoms = buildAtoms(sha256Hex("sw2"), 20 * U, words);
    const ctx = createContext({ sha256: sha256Hex("sw2"), durationUs: 20 * U, fps: { num: 25, den: 1 }, hasAudio: true, hasVideo: true, variableFrameRate: false }, atoms);
    const d = driver(ctx, { semantic: { topic: "old job", hits: [hit(5, 7.4, "My old job was in a factory.", "SPEAKER_01")] } });
    const q = d.say("remove everything the guest says about the old job");
    expect(q.answer.warnings.join(" ")).toMatch(/possible speaker-label swap/i);
    expect(q.answer.warnings.join(" ")).toMatch(/7 word\(s\)/);
    // no flags -> no such warning
    const plain = buildAtoms(sha256Hex("sw3"), 20 * U, words.map((w) => ({ ...w, possibleLabelSwap: false })));
    const ctx2 = createContext({ sha256: sha256Hex("sw3"), durationUs: 20 * U, fps: { num: 25, den: 1 }, hasAudio: true, hasVideo: true, variableFrameRate: false }, plain);
    const q2 = driver(ctx2, { semantic: { topic: "old job", hits: [hit(5, 7.4, "My old job was in a factory.", "SPEAKER_01")] } }).say("remove everything the guest says about the old job");
    expect(q2.answer.warnings.join(" ")).not.toMatch(/swap/i);
  });

  it("warns when the words it cuts have an uncertain speaker label (possible label swap) or overlap another speaker", () => {
    const lines: [number, string, string][] = [[1, "So tell me about your old job.", "SPEAKER_00"], [5, "My old job was in a factory.", "SPEAKER_01"], [10, "And now I build software.", "SPEAKER_00"]];
    const words = lines.flatMap(([start, text, speaker]) => text.split(" ").map((w, i) => ({ text: w, startUs: Math.round((start + i * 0.4) * U), endUs: Math.round((start + i * 0.4 + 0.35) * U), speaker, speakerUncertain: speaker === "SPEAKER_01" && i < 2, overlapsSpeech: speaker === "SPEAKER_01" && i === 2 })));
    const atoms = buildAtoms(sha256Hex("sw"), 20 * U, words);
    const ctx = createContext({ sha256: sha256Hex("sw"), durationUs: 20 * U, fps: { num: 25, den: 1 }, hasAudio: true, hasVideo: true, variableFrameRate: false }, atoms);
    const d = driver(ctx, { semantic: { topic: "old job", hits: [hit(5, 7.4, "My old job was in a factory.", "SPEAKER_01")] } });
    const q = d.say("remove everything the guest says about the old job");
    expect(q.answer.warnings.join(" ")).toMatch(/uncertain speaker label/i);
    expect(q.answer.warnings.join(" ")).toMatch(/overlap/i);
  });
});
