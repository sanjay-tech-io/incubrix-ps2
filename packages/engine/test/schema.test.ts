import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import type { SessionDocument } from "../src/types";

const schema = JSON.parse(readFileSync(new URL("../schemas/timeline.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: true }).compile(schema);

// Typed as SessionDocument so the compiler checks types.ts against this sample.
const sample: SessionDocument = {
  schemaVersion: 1,
  source: { sha256: "a".repeat(64), durationUs: 3_000_000, fps: { num: 30000, den: 1001 }, hasAudio: true, hasVideo: true, variableFrameRate: false },
  atoms: [
    { id: "a_000000000001", kind: "word", startUs: 0, endUs: 1_000_000, text: "welcome", speaker: "S1", confidencePermille: 950, lowConfidence: false, filler: false, overlapsSpeech: false, speakerUncertain: false },
    { id: "a_000000000002", kind: "silence", startUs: 1_000_000, endUs: 3_000_000, text: "", speaker: null, confidencePermille: 1000, lowConfidence: false, filler: false, overlapsSpeech: false, speakerUncertain: false },
  ],
  log: [
    { seq: 0, kind: "edit", group: 1, op: { type: "add_effect", effectId: "fx_0_0", range: { from: "a_000000000001", to: "a_000000000001" }, params: { kind: "caption", text: "Welcome!", style: { color: "#ffffff", sizePt: 32, bold: true } } } },
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
