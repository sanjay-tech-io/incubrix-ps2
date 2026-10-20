import { describe, expect, it } from "vitest";
import { analyzeLog } from "../src/log";
import {
  answerClarification,
  askClarification,
  currentTimeline,
  newSession,
  submitOperations,
  submitRedo,
  submitRejection,
  submitUndo,
  type SessionState,
} from "../src/session";
import { timelineHash } from "../src/hash";
import { materialize } from "../src/replay";
import { atomEndingAt, atomStartingAt, FACTS, makeFixture } from "./fixtures/transcript";
import { captionOp, cutOp, speedOp } from "./helpers";

const { ctx, atoms } = makeFixture();
const dur = (s: SessionState) => currentTimeline(ctx, s).durationUs;

describe("answer contract", () => {
  it("an applied answer has every field of the contract", () => {
    const t = submitOperations(ctx, newSession(), "cut the first 30 seconds", [cutOp(ctx, 0, 30_000_000)]);
    expect(Object.keys(t.answer).sort()).toEqual(["durationUs", "operations", "options", "question", "reason", "status", "summary", "timePolicy", "timelineHash", "warnings"]);
    expect(t.answer).toMatchObject({ status: "applied", question: null, reason: null, options: [], timePolicy: "current", durationUs: 170_000_000 });
    expect(t.answer.operations).toHaveLength(1);
    expect(t.answer.summary).toBe("Length 3:20.000 -> 2:50.000 (-0:30.000).");
    expect(t.answer.timelineHash).toBe(timelineHash(currentTimeline(ctx, t.state)));
  });

  it("states the time policy that was used", () => {
    const t = submitOperations(ctx, newSession(), "cut original 0:10-0:20", [cutOp(ctx, 10_000_000, 20_000_000)], { timePolicy: "original" });
    expect(t.answer.timePolicy).toBe("original");
  });

  it("extra warnings from resolving the instruction are passed through", () => {
    const t = submitOperations(ctx, newSession(), "x", [cutOp(ctx, 0, 30_000_000)], { warnings: ["moved a cut point"] });
    expect(t.answer.warnings).toContain("moved a cut point");
  });
});

describe("undo groups", () => {
  it("one instruction with several operations is ONE undo step", () => {
    let s = submitOperations(ctx, newSession(), "cut and speed", [cutOp(ctx, 0, 30_000_000), speedOp(ctx, 90_000_000, 108_000_000, 2)]).state;
    expect(dur(s)).toBe(200_000_000 - 30_000_000 - 9_000_000);
    expect(analyzeLog(s.log).active).toEqual([1]);
    s = submitUndo(ctx, s, "undo").state;
    expect(dur(s)).toBe(200_000_000);
  });

  it("undo then redo returns the same timeline hash", () => {
    const s1 = submitOperations(ctx, newSession(), "cut", [cutOp(ctx, 0, 30_000_000)]).state;
    const s2 = submitRedo(ctx, submitUndo(ctx, s1, "undo").state, "redo").state;
    expect(timelineHash(currentTimeline(ctx, s2))).toBe(timelineHash(currentTimeline(ctx, s1)));
  });

  it("a new edit clears redo", () => {
    let s = submitOperations(ctx, newSession(), "a", [cutOp(ctx, 0, 10_000_000)]).state;
    s = submitUndo(ctx, s, "undo").state;
    s = submitOperations(ctx, s, "b", [cutOp(ctx, 20_000_000, 30_000_000)]).state;
    const t = submitRedo(ctx, s, "redo");
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/nothing to redo/i);
    expect(dur(t.state)).toBe(190_000_000);
  });

  it("undo with nothing to undo is rejected, not an error", () => {
    const t = submitUndo(ctx, newSession(), "undo");
    expect(t.answer).toMatchObject({ status: "rejected" });
    expect(t.answer.reason).toMatch(/nothing to undo/i);
    expect(t.state.log).toEqual([]);
  });

  it("undo only reverses the latest group", () => {
    let s = submitOperations(ctx, newSession(), "a", [cutOp(ctx, 0, 10_000_000)]).state;
    s = submitOperations(ctx, s, "b", [cutOp(ctx, 20_000_000, 30_000_000)]).state;
    s = submitUndo(ctx, s, "undo").state;
    expect(dur(s)).toBe(190_000_000);
    expect(materialize(ctx, s.log).segments).toHaveLength(1);
  });
});

describe("restore a specific earlier edit while later ones stay", () => {
  it("restores edit 1 and keeps edit 2; undoing the restore cuts edit 1 again", () => {
    let s = submitOperations(ctx, newSession(), "cut A", [cutOp(ctx, 0, 10_000_000)]).state; // group 1
    s = submitOperations(ctx, s, "cut B", [cutOp(ctx, 20_000_000, 30_000_000)]).state; // group 2
    expect(dur(s)).toBe(180_000_000);
    const t = submitOperations(ctx, s, "put A back", [{ type: "restore", targetGroup: 1 }]); // group 3
    expect(t.answer.status).toBe("applied");
    expect(dur(t.state)).toBe(190_000_000); // A is back, B is still cut
    const undone = submitUndo(ctx, t.state, "undo").state;
    expect(dur(undone)).toBe(180_000_000);
  });

  it("the log is append-only: restoring never removes the original entries", () => {
    const s1 = submitOperations(ctx, newSession(), "cut A", [cutOp(ctx, 0, 10_000_000)]).state;
    const s2 = submitOperations(ctx, s1, "back", [{ type: "restore", targetGroup: 1 }]).state;
    expect(s2.log.slice(0, s1.log.length)).toEqual(s1.log);
    expect(s2.log).toHaveLength(2);
  });

  it("restoring a restore brings the original edit back", () => {
    let s = submitOperations(ctx, newSession(), "cut A", [cutOp(ctx, 0, 10_000_000)]).state;
    s = submitOperations(ctx, s, "back", [{ type: "restore", targetGroup: 1 }]).state;
    s = submitOperations(ctx, s, "redo the cut", [{ type: "restore", targetGroup: 2 }]).state;
    expect(dur(s)).toBe(190_000_000);
  });

  it.each([
    ["an edit that never existed", 7, /edit 7/],
  ])("rejects restoring %s", (_n, target, re) => {
    const s = submitOperations(ctx, newSession(), "cut A", [cutOp(ctx, 0, 10_000_000)]).state;
    const t = submitOperations(ctx, s, "restore", [{ type: "restore", targetGroup: target }]);
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(re);
    expect(t.state.log).toEqual(s.log);
  });

  it("rejects restoring an edit that was already restored, or one that was undone", () => {
    let s = submitOperations(ctx, newSession(), "cut A", [cutOp(ctx, 0, 10_000_000)]).state;
    s = submitOperations(ctx, s, "back", [{ type: "restore", targetGroup: 1 }]).state;
    const again = submitOperations(ctx, s, "back again", [{ type: "restore", targetGroup: 1 }]);
    expect(again.answer.status).toBe("rejected");
    expect(again.answer.reason).toMatch(/already been restored/);

    const u = submitUndo(ctx, submitOperations(ctx, newSession(), "cut", [cutOp(ctx, 0, 10_000_000)]).state, "undo").state;
    const undone = submitOperations(ctx, u, "restore", [{ type: "restore", targetGroup: 1 }]);
    expect(undone.answer.status).toBe("rejected");
  });
});

describe("rejections are normal answers", () => {
  it("speed outside the allowed range: rejected with the reason and the range; nothing logged", () => {
    const t = submitOperations(ctx, newSession(), "speed up 10x", [speedOp(ctx, 90_000_000, 108_000_000, 10)]);
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toBe("speed 10x is outside the allowed range 0.25x to 4x");
    expect(t.answer.operations).toEqual([]);
    expect(t.state.log).toEqual([]);
    expect(t.state.conversation).toHaveLength(1);
  });

  it("an edit that would remove the whole video is rejected", () => {
    const t = submitOperations(ctx, newSession(), "cut everything", [cutOp(ctx, 0, 200_000_000)]);
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/whole video/i);
    expect(t.state.log).toEqual([]);
  });

  it("an invalid cursor is rejected, not thrown", () => {
    const bad = { type: "cut" as const, reason: "user" as const, span: { start: { atom: atoms[2]!.id, offsetUs: 5 }, end: { atom: atoms[3]!.id, offsetUs: 0 } } };
    const t = submitOperations(ctx, newSession(), "x", [bad]);
    expect(t.answer.status).toBe("rejected");
  });

  it("updating a caption that does not exist is rejected", () => {
    const t = submitOperations(ctx, newSession(), "make it red", [{ type: "update_effect", effectId: "fx_9_0", params: { kind: "bleep" } }]);
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/fx_9_0/);
  });

  it("submitRejection records a rejection decided by the caller without touching the log", () => {
    const t = submitRejection(ctx, newSession(), "add a caption at 5:00", "5:00 is after the end of the video (3:20.000)");
    expect(t.answer).toMatchObject({ status: "rejected", reason: "5:00 is after the end of the video (3:20.000)", operations: [] });
    expect(t.state.log).toEqual([]);
  });

  it("repeating an instruction is safe and says nothing changed", () => {
    const once = submitOperations(ctx, newSession(), "remove 0:30-0:40", [cutOp(ctx, 30_000_000, 40_000_000)]);
    const twice = submitOperations(ctx, once.state, "remove 0:30-0:40", [cutOp(ctx, 30_000_000, 40_000_000)]);
    expect(twice.answer.timelineHash).toBe(once.answer.timelineHash);
    expect(twice.answer.warnings.join(" ")).toMatch(/nothing changed/i);
  });
});

describe("clarification", () => {
  const options = (): { label: string; operations: ReturnType<typeof cutOp>[]; warnings: string[] }[] => [
    { label: "first", operations: [cutOp(ctx, 65_000_000, 68_000_000)], warnings: [] },
    { label: "second", operations: [cutOp(ctx, 108_000_000, 113_000_000)], warnings: ["note"] },
  ];

  it("asking changes neither the log nor the timeline hash, and is not an undo group", () => {
    const before = submitOperations(ctx, newSession(), "cut", [cutOp(ctx, 0, 30_000_000)]);
    const asked = askClarification(ctx, before.state, "remove the part about pricing", "Which one?", options());
    expect(asked.answer).toMatchObject({ status: "needs_clarification", question: "Which one?", options: ["first", "second"], operations: [] });
    expect(asked.answer.timelineHash).toBe(before.answer.timelineHash);
    expect(asked.state.log).toEqual(before.state.log);
    expect(analyzeLog(asked.state.log).active).toEqual([1]);
    expect(asked.state.conversation.at(-1)!.pending).not.toBeNull();
  });

  it("the answer applies exactly the chosen option's operations and its warnings", () => {
    const asked = askClarification(ctx, newSession(), "remove the part about pricing", "Which one?", options());
    const done = answerClarification(ctx, asked.state, "the second one", 1);
    expect(done.answer.status).toBe("applied");
    expect(done.answer.operations).toEqual(options()[1]!.operations);
    expect(done.answer.warnings).toContain("note");
    expect(dur(done.state)).toBe(195_000_000);
    expect(done.state.conversation.at(-1)).toMatchObject({ text: "the second one", appliedGroup: 1, pending: null });
  });

  it("an out-of-range choice asks again and keeps the question open", () => {
    const asked = askClarification(ctx, newSession(), "x", "Which one?", options());
    const again = answerClarification(ctx, asked.state, "the fifth", 4);
    expect(again.answer.status).toBe("needs_clarification");
    expect(again.state.log).toEqual([]);
    expect(again.state.conversation.at(-1)!.pending).not.toBeNull();
  });

  it("answering when no question is open is rejected", () => {
    const t = answerClarification(ctx, newSession(), "the second one", 1);
    expect(t.answer.status).toBe("rejected");
    expect(t.answer.reason).toMatch(/no open question/i);
  });
});

describe("determinism and independence from the conversation", () => {
  it("the same log replayed 3 times gives the same hash", () => {
    const s = submitOperations(ctx, submitOperations(ctx, newSession(), "a", [cutOp(ctx, 0, 30_000_000)]).state, "b", [speedOp(ctx, 90_000_000, 108_000_000, 2)]).state;
    const hashes = [1, 2, 3].map(() => timelineHash(materialize(makeFixture().ctx, s.log)));
    expect(new Set(hashes).size).toBe(1);
  });

  it("the hash does not depend on what the user typed or on clarification turns", () => {
    const ops = [cutOp(ctx, 0, 30_000_000)];
    const a = submitOperations(ctx, newSession(), "cut the first 30 seconds", ops).state;
    const b = submitOperations(ctx, askClarification(ctx, newSession(), "hmm", "Which?", []).state, "please remove the intro, thanks", ops).state;
    expect(b.conversation).not.toEqual(a.conversation);
    expect(timelineHash(currentTimeline(ctx, b))).toBe(timelineHash(currentTimeline(ctx, a)));
  });
});

describe("warnings about effects and uncertain words", () => {
  const welcome = atomStartingAt(atoms, FACTS.welcome.startUs);
  const channel = atomEndingAt(atoms, FACTS.welcome.endUs);
  const withCaption = () => submitOperations(ctx, newSession(), "caption", [captionOp("fx_0_0", welcome.id, channel.id, "Welcome!")]);

  it("cutting all of a caption's words makes it inactive, says so, and restoring brings it back", () => {
    const cut = submitOperations(ctx, withCaption().state, "cut it", [cutOp(ctx, 41_000_000, 45_000_000)]);
    expect(cut.answer.warnings.join(" ")).toMatch(/caption "Welcome!".*hidden.*words were cut/);
    expect(currentTimeline(ctx, cut.state).effects[0]!.state).toBe("inactive");
    const back = submitOperations(ctx, cut.state, "put it back", [{ type: "restore", targetGroup: 2 }]);
    expect(currentTimeline(ctx, back.state).effects[0]!.state).toBe("active");
    expect(back.answer.summary).toMatch(/caption "Welcome!" is visible again/);
  });

  it("a partial cut keeps the literal text and names the cut words", () => {
    const cut = submitOperations(ctx, withCaption().state, "cut the start", [cutOp(ctx, 41_000_000, 42_500_000)]);
    expect(cut.answer.warnings.join(" ")).toMatch(/caption "Welcome!" keeps its text.*welcome/);
    expect(currentTimeline(ctx, cut.state).effects[0]).toMatchObject({ state: "active", partial: true, params: { text: "Welcome!" } });
  });

  it("reports how far a caption moved", () => {
    const t = submitOperations(ctx, withCaption().state, "cut", [cutOp(ctx, 0, 30_000_000)]);
    expect(t.answer.summary).toContain('caption "Welcome!" moved from 0:42.000 to 0:12.000');
  });

  it("warns when a speed-up shortens a caption below 0.7 s and extends it", () => {
    const t = submitOperations(ctx, withCaption().state, "speed", [speedOp(ctx, 41_000_000, 45_000_000, 4)]);
    expect(t.answer.warnings.join(" ")).toMatch(/caption "Welcome!".*0\.7 s/);
  });

  it("warns when an edit touches low-confidence, overlapping or speaker-uncertain words", () => {
    const flagged = makeFixture((words) =>
      words.map((w) => {
        if (w.text === "Honestly") return { ...w, speakerUncertain: true };
        if (w.text === "speed") return { ...w, confidencePermille: 300 };
        return w;
      }),
    );
    const t = submitOperations(flagged.ctx, newSession(), "cut", [cutOp(flagged.ctx, FACTS.honestly.startUs, FACTS.honestly.endUs)]);
    expect(t.answer.warnings.join(" ")).toMatch(/"Honestly" \(speaker uncertain\).*"speed" \(low confidence\)/);
    const clean = submitOperations(ctx, newSession(), "cut", [cutOp(ctx, FACTS.honestly.startUs, FACTS.honestly.endUs)]);
    expect(clean.answer.warnings).toEqual([]);
  });
});
