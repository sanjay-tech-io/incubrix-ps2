import type { EngineContext, Operation, PendingQuestion, SessionState, TimePolicy } from "@incubrix/engine";

export interface ParseInput {
  text: string;
  ctx: EngineContext;
  state: SessionState;
  /** The user's reply to an open question, when the client sends it separately: 1-based number or text ("the second one"). */
  answer?: string | number;
}

/**
 * What a parser may return. It is only ever a request for the engine: operations that are already
 * resolved to atoms, or a question, or a refusal. Timeline logic never lives in a parser.
 */
export type Parsed =
  | { kind: "plan"; operations: Operation[]; warnings: string[]; timePolicy: TimePolicy; nothingToDo?: string }
  | { kind: "undo"; timePolicy: TimePolicy; warnings: string[] }
  | { kind: "redo"; timePolicy: TimePolicy; warnings: string[] }
  | { kind: "choose"; choice: number; timePolicy: TimePolicy }
  | { kind: "clarify"; question: string; options: PendingQuestion["options"]; timePolicy: TimePolicy; warnings: string[] }
  | { kind: "reject"; reason: string; timePolicy: TimePolicy; warnings: string[] };

export interface InstructionParser {
  readonly name: string;
  readonly version: string;
  parse(input: ParseInput): Parsed;
}
