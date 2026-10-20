/**
 * One error type for "this input is not acceptable". The session layer turns an
 * EngineError into a `rejected` answer (never an HTTP error); anything else is a bug.
 */
export type EngineErrorCode =
  | "INVALID_CURSOR"
  | "INVALID_SPAN"
  | "INVALID_RANGE"
  | "INVALID_LOG"
  | "SPEED_OUT_OF_RANGE"
  | "UNKNOWN_EFFECT"
  | "NOTHING_TO_UNDO"
  | "NOTHING_TO_REDO"
  | "INVALID_RESTORE"
  | "EMPTY_RESULT"
  | "NOT_IMPLEMENTED";

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "EngineError";
  }
  /** The message without the code prefix, for showing to the user. */
  get reason(): string {
    return this.message.slice(this.code.length + 2);
  }
}
