import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { generateTimelineJsonSchema, Operation, SessionDocument } from "../src/index";

const committed = JSON.parse(readFileSync(new URL("../schemas/timeline.schema.json", import.meta.url), "utf8"));

describe("schemas/timeline.schema.json is generated from the zod contracts", () => {
  it("the committed file equals the generated schema (run `npm run generate -w @incubrix/contracts` if this fails)", () => {
    expect(committed).toEqual(generateTimelineJsonSchema());
  });

  it("compiles under ajv strict mode and exposes Timeline and Answer as named definitions", () => {
    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(committed);
    expect(ajv.getSchema(`${committed.$id}#/$defs/Timeline`)).toBeDefined();
    expect(ajv.getSchema(`${committed.$id}#/$defs/Answer`)).toBeDefined();
    expect(ajv.getSchema(`${committed.$id}#/$defs/Operation`)).toBeDefined();
  });

  it("zod and the generated JSON Schema agree on valid and invalid operations", () => {
    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(committed);
    const validateOp = ajv.getSchema(`${committed.$id}#/$defs/Operation`)!;
    const good = { type: "restore", targetGroup: 3 };
    const bad = [
      { type: "explode" },
      { type: "restore", targetGroup: 0 },
      { type: "restore", targetGroup: 1.5 },
      { type: "restore", targetGroup: 1, extra: true },
      { type: "set_speed", span: { start: { atom: "a_000000000001", offsetUs: 0 }, end: { atom: "a_000000000002", offsetUs: 0 } }, rate: { num: 0, den: 1 } },
    ];
    expect(validateOp(good)).toBe(true);
    expect(Operation.safeParse(good).success).toBe(true);
    for (const b of bad) {
      expect(validateOp(b), JSON.stringify(b)).toBe(false);
      expect(Operation.safeParse(b).success, JSON.stringify(b)).toBe(false);
    }
  });

  it("rejects a session document with a float time", () => {
    const doc = { schemaVersion: 1, source: { sha256: "a".repeat(64), durationUs: 1.5, fps: null, hasAudio: true, hasVideo: false, variableFrameRate: false }, atoms: [], log: [], conversation: [] };
    expect(SessionDocument.safeParse(doc).success).toBe(false);
  });
});
