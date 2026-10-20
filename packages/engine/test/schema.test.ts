import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { SessionDocument as SessionDocumentZ } from "@incubrix/contracts";
import type { SessionDocument } from "../src/types";

const schema = JSON.parse(readFileSync(new URL("../../contracts/schemas/timeline.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: true }).compile(schema);
const sampleCheck = (doc: unknown) => SessionDocumentZ.safeParse(doc).success;

// Typed as SessionDocument so the compiler checks types.ts against this sample.
const sample: SessionDocument = {
  schemaVersion: 1,
  source: { sha256: "a".repeat(64), durationUs: 3_000_000, fps: { num: 30000, den: 1001 }, hasAudio: true, hasVideo: true, variableFrameRate: false },
  atoms: [
    { id: "a_000000000001", kind: "word", startUs: 0, endUs: 1_000_000, text: "welcome", speaker: "S1", confidencePermille: 950, lowConfidence: false, filler: false, overlapsSpeech: false, speakerUncertain: false },
    { id: "a_000000000002", kind: "silence", startUs: 1_000_000, endUs: 3_000_000, text: "", speaker: null, confidencePermille: 1000, lowConfidence: false, filler: false, overlapsSpeech: false, speakerUncertain: false },
  ],
  log: [
    { seq: 0, kind: "edit", group: 1, op: { type: "add_effect", effectId: "fx_0_0", range: { from: "a_000000000001", to: "a_000000000001" }, params: { kind: "caption", text: "Welcome!", style: { color: "#ffffff", sizePt: 32, bold: true }, position: "bottom" } } },
    { seq: 1, kind: "edit", group: 2, op: { type: "cut", span: { start: { atom: "a_000000000002", offsetUs: 500_000 }, end: { atom: "a_000000000002", offsetUs: 2_000_000 } }, reason: "user" } },
    { seq: 2, kind: "undo" },
    { seq: 3, kind: "redo" },
    { seq: 4, kind: "edit", group: 3, op: { type: "restore", targetGroup: 2 } },
  ],
  conversation: [
    { turn: 0, text: "caption welcome", answer: { status: "applied", operations: [], summary: "Added caption", question: null, options: [], reason: null, timePolicy: "current", warnings: [], timelineHash: "b".repeat(64), durationUs: 3_000_000 }, appliedGroup: 1, pending: null },
  ],
};

describe("timeline.schema.json", () => {
  it("compiles under strict mode and accepts a sample session document", () => {
    expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
    expect(sampleCheck(sample)).toBe(true);
  });

  it("rejects float times (time must be integer microseconds)", () => {
    const bad = structuredClone(sample);
    bad.source.durationUs = 1.5;
    expect(validate(bad)).toBe(false);
  });

  it("rejects an unknown operation type", () => {
    const bad = structuredClone(sample) as unknown as { log: { op?: { type: string } }[] };
    bad.log[0]!.op!.type = "explode";
    expect(validate(bad)).toBe(false);
  });
});

describe("the schema accepts what the engine really produces", () => {
  it("a real session (caption, cut, question, answer, speed, restore, undo, recolour) validates, and so does its materialized timeline", async () => {
    const { makeFixture } = await import("./fixtures/transcript");
    const { answerClarification, askClarification, currentTimeline, newSession, submitOperations, submitUndo } = await import("../src/session");
    const { captionOp, cutOp, speedOp, RED } = await import("./helpers");
    const { ctx, source, atoms } = makeFixture();
    const U = 1_000_000;
    const welcome = atoms.find((a) => a.startUs === 42 * U)!;
    const channel = atoms.find((a) => a.endUs === 44 * U)!;

    let s = submitOperations(ctx, newSession(), "caption", [captionOp("fx_0_0", welcome.id, channel.id, "Welcome!")]).state;
    s = submitOperations(ctx, s, "cut", [cutOp(ctx, 0, 30 * U)]).state;
    s = askClarification(ctx, s, "remove pricing", "Which?", [{ label: "second", operations: [cutOp(ctx, 108 * U, 113 * U)], warnings: [] }]).state;
    s = answerClarification(ctx, s, "the second one", 0).state;
    s = submitOperations(ctx, s, "speed", [speedOp(ctx, 90 * U, 108 * U, 2)]).state;
    s = submitOperations(ctx, s, "intro back", [{ type: "restore", targetGroup: 2 }]).state;
    s = submitUndo(ctx, s, "undo").state;
    s = submitOperations(ctx, s, "red", [{ type: "update_effect", effectId: "fx_0_0", params: { kind: "caption", text: "Welcome!", style: RED, position: "bottom" } }]).state;
    s = submitOperations(ctx, s, "speed 10x", [speedOp(ctx, 90 * U, 108 * U, 10)]).state; // rejected: still logged in the conversation

    const doc: SessionDocument = { schemaVersion: 1, source, atoms, log: [...s.log], conversation: [...s.conversation] };
    expect(validate(doc), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
    expect(SessionDocumentZ.safeParse(doc).success).toBe(true); // zod (the source of truth) agrees

    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(schema);
    const validateTimeline = ajv.getSchema(`${schema.$id}#/$defs/Timeline`)!;
    const tl = currentTimeline(ctx, s);
    expect(validateTimeline(tl), JSON.stringify(validateTimeline.errors?.slice(0, 3))).toBe(true);
  });
});
