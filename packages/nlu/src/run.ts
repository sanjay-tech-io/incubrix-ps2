import {
  answerClarification, askClarification, submitOperations, submitPlan, submitRedo, submitRejection, submitUndo,
  type EngineContext, type SessionState, type Turn,
} from "@incubrix/engine";
import { MockParser } from "./mock.ts";
import { RulesParser } from "./rules.ts";
import type { InstructionParser, ParseInput } from "./types.ts";

/** Parse, then hand the result to the engine. All timeline logic happens in the engine's session functions. */
export function runInstruction(ctx: EngineContext, state: SessionState, input: Pick<ParseInput, "text" | "answer">, parser: InstructionParser): Turn {
  const p = parser.parse({ ctx, state, ...input });
  const text = input.text;
  switch (p.kind) {
    case "plan":
      return p.nothingToDo !== undefined
        ? submitPlan(ctx, state, text, p, { timePolicy: p.timePolicy, nothingToDo: p.nothingToDo })
        : submitPlan(ctx, state, text, p, { timePolicy: p.timePolicy });
    case "undo":
      return submitUndo(ctx, state, text, { timePolicy: p.timePolicy, warnings: p.warnings });
    case "redo":
      return submitRedo(ctx, state, text, { timePolicy: p.timePolicy, warnings: p.warnings });
    case "choose":
      return answerClarification(ctx, state, text, p.choice, { timePolicy: p.timePolicy });
    case "clarify":
      return askClarification(ctx, state, text, p.question, p.options, { timePolicy: p.timePolicy, warnings: p.warnings });
    case "reject":
      return submitRejection(ctx, state, text, p.reason, { timePolicy: p.timePolicy, warnings: p.warnings });
  }
}

export type ParserName = "rules" | "mock";

/** LLM_PROVIDER -> parser. The real LLM providers (groq, gemini) are not built yet: asking for one fails at startup, not at request time. */
export function createParser(provider: string): InstructionParser {
  if (provider === "rules") return new RulesParser();
  if (provider === "mock") return new MockParser();
  throw new Error(`LLM_PROVIDER=${provider} is not implemented yet; use "rules" or "mock"`);
}

export { submitOperations };
