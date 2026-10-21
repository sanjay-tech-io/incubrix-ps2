import {
  answerClarification, askClarification, submitOperations, submitPlan, submitRedo, submitRejection, submitUndo,
  type EngineContext, type SessionState, type Turn,
} from "@incubrix/engine";
import { MockParser } from "./mock.ts";
import { RulesParser } from "./rules.ts";
import type { InstructionParser, ParseInput, Parsed } from "./types.ts";

/** Parse, then hand the result to the engine. All timeline logic happens in the engine's session functions. */
export function runInstruction(ctx: EngineContext, state: SessionState, input: Pick<ParseInput, "text" | "answer" | "side">, parser: InstructionParser): Turn {
  return applyParsed(ctx, state, input.text, parser.parse({ ctx, state, ...input }));
}

/** The second half of runInstruction: lets a caller parse first (and, say, ask an LLM when the rules did not understand). */
export function applyParsed(ctx: EngineContext, state: SessionState, text: string, p: Parsed): Turn {
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
  // gemini: the RULES parser still goes first; the language model is only the fallback and lives in packages/llm (it needs I/O).
  if (provider === "gemini") return new RulesParser();
  throw new Error(`LLM_PROVIDER=${provider} is not implemented yet; use "rules", "mock" or "gemini"`);
}

export { submitOperations };
