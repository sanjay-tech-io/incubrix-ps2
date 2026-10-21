import { describe, expect, it } from "vitest";
import { currentTimeline, newSession, sourceToEdited, timelinePieces, type SessionState, type Turn } from "@incubrix/engine";
import { makeFixture } from "../../engine/test/fixtures/transcript.ts";
import { RulesParser, runInstruction, topicRequest, type SemanticHit } from "../src/index.ts";

const U = 1_000_000;
const parser = new RulesParser();
const hit = (startS: number, endS: number, text: string, score = 520): SemanticHit => ({ startUs: startS * U, endUs: endS * U, text, scorePermille: score, speaker: null });

function driver(side: { semantic?: { topic: string; hits: SemanticHit[] } | null; semanticNote?: string }) {
  const { ctx } = makeFixture();
  let state: SessionState = newSession();
  return {
    ctx,
    say(text: string, answer?: string | number): Turn {
      const t = runInstruction(ctx, state, answer === undefined ? { text, side } : { text, side, answer }, parser);
      state = t.state;
      return t;
    },
    plays: (us: number) => sourceToEdited(timelinePieces(ctx, currentTimeline(ctx, state)), us) !== null,
  };
}

describe("meaning search in 'remove the part about <topic>'", () => {
  it("topicRequest reads the topic out of the instruction (the caller embeds it before parsing)", () => {
    expect(topicRequest("remove the part about pricing")).toBe("pricing");
    expect(topicRequest("Cut the section about how much it costs.")).toBe("how much it costs");
    expect(topicRequest('remove the part about "old job"')).toBe("old job");
    expect(topicRequest("cut 0:10-0:20")).toBeNull();
    expect(topicRequest("remove everything after thanks")).toBeNull();
  });

  it("exact mentions AND meaning matches are listed together in time order, each marked, and nothing is cut before the answer", () => {
    // the fixture says "pricing" at 65, 108 and 160 s; 82 s is "I use it every single day" - pretend the model found it
    const d = driver({ semantic: { topic: "pricing", hits: [hit(82, 84.9, "I use it every single day.", 410)] } });
    const q = d.say("remove the part about pricing");
    expect(q.answer.status).toBe("needs_clarification");
    expect(q.answer.options).toHaveLength(4);
    const labels = q.answer.options!;
    expect(labels[0]).toMatch(/#1 at 1:05.*\[exact word\]/);
    expect(labels[1]).toMatch(/#2 at 1:22.*\[meaning match 41%\].*I use it every single day/);
    expect(labels[2]).toMatch(/#3 at 1:48/);
    expect(d.plays(83 * U)).toBe(true);
    const a = d.say("the second one");
    expect(a.answer.status).toBe("applied");
    expect(d.plays(83 * U)).toBe(false);
    expect(d.plays(66 * U)).toBe(true); // the exact pricing mention was not touched
  });

  it("a topic with no exact word but a meaning match asks (one option) instead of cutting on a guess", () => {
    const d = driver({ semantic: { topic: "gardening tips", hits: [hit(90, 92, "Honestly the speed is great.", 380)] } });
    const q = d.say("remove the part about gardening tips");
    expect(q.answer.status).toBe("needs_clarification");
    expect(q.answer.options).toHaveLength(1);
    expect(q.answer.question).toMatch(/meaning/);
    expect(d.plays(91 * U)).toBe(true);
    expect(d.say("the first one").answer.status).toBe("applied");
    expect(d.plays(91 * U)).toBe(false);
  });

  it("a meaning match that overlaps an exact mention is not listed twice; one that is already cut is not offered", () => {
    const d = driver({ semantic: { topic: "pricing", hits: [hit(65, 67.4, "Now let us talk about pricing.", 600), hit(90, 92, "Honestly the speed is great.", 380)] } });
    expect(d.say("cut 1:30-1:32").answer.status).toBe("applied"); // current-time 1:30 = original 90 s here (nothing cut before)
    const q = d.say("remove the part about pricing");
    expect(q.answer.options).toHaveLength(3); // the 3 exact mentions only
  });

  it("with no exact mention and no meaning match it rejects; an unavailable model is said in the answer", () => {
    const none = driver({ semantic: { topic: "xylophone", hits: [] } }).say("remove the part about xylophone");
    expect(none.answer.status).toBe("rejected");
    const d = driver({ semantic: null, semanticNote: "Meaning search is unavailable (the embedding service did not answer); only exact words were searched." });
    const q = d.say("remove the part about pricing");
    expect(q.answer.status).toBe("needs_clarification");
    expect(q.answer.warnings.join(" ")).toMatch(/Meaning search is unavailable/);
  });
});
