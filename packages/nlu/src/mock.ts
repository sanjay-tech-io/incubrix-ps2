import type { InstructionParser, ParseInput, Parsed } from "./types.ts";

/** Test double: returns a scripted result per exact text, otherwise a rejection. Needs no rules and no key. */
export class MockParser implements InstructionParser {
  readonly name = "mock";
  readonly version = "1";
  private readonly script: Record<string, Parsed | ((i: ParseInput) => Parsed)>;
  constructor(script: Record<string, Parsed | ((i: ParseInput) => Parsed)> = {}) {
    this.script = script;
  }
  parse(input: ParseInput): Parsed {
    const hit = this.script[input.text];
    if (hit === undefined) return { kind: "reject", reason: `mock parser has no script for "${input.text}"`, timePolicy: "current", warnings: [] };
    return typeof hit === "function" ? hit(input) : hit;
  }
}
