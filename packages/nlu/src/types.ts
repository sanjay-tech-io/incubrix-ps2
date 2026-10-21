import type { EngineContext, Operation, PendingQuestion, SessionState, TimePolicy } from "@incubrix/engine";

/** A voiced stretch no ASR word covers (packages/media findVoicedGaps). A POSSIBLE filler: never cut without asking. */
export interface PossibleFiller {
  startUs: number;
  endUs: number;
  levelDb: number;
  zcr: number;
  touchesWord: boolean;
  confidencePermille: number;
}

/** A passage of the transcript whose meaning is close to the query (cosine similarity of sentence embeddings). */
export interface SemanticHit {
  startUs: number;
  endUs: number;
  text: string;
  /** 0..1000 (similarity x 1000, rounded): an integer so it can sit in logs and hashes. */
  scorePermille: number;
  speaker: string | null;
}

/**
 * Data the caller computed BEFORE parsing because it needs I/O (this package stays pure): untranscribed sounds read
 * from the transcript manifest, and the meaning-search hits for the topic of the instruction.
 */
export interface SideData {
  possibleFillers?: readonly PossibleFiller[];
  semantic?: { topic: string; hits: readonly SemanticHit[] } | null;
  /** Set when meaning search was wanted but could not run: the answer says exact words only were searched. */
  semanticNote?: string;
}

export interface ParseInput {
  /** See SideData. Absent = none available (the rules still work on exact words). */
  side?: SideData;
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
  | { kind: "reject"; reason: string; timePolicy: TimePolicy; warnings: string[]; /** The text was not recognised at all (an LLM fallback may try); false/absent = understood but refused. */ unparsed?: boolean };

export interface InstructionParser {
  readonly name: string;
  readonly version: string;
  parse(input: ParseInput): Parsed;
}
