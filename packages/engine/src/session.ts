import type { EngineContext } from "./context";
import { spanToInterval } from "./cursor";
import { EngineError } from "./errors";
import { timelineHash } from "./hash";
import { analyzeLog, appendEdit, appendRedo, appendUndo, type Log } from "./log";
import { formatTime } from "./resolve";
import { applyOp, materialize, primeRaw, rawFromLog, type Raw } from "./replay";
import { atomsOverlapping, rangeAtoms } from "./search";
import { atomOutSpan, effectDisplay, MIN_CAPTION_VISIBLE_US, timelinePieces } from "./timemap";
import type { Answer, ConversationEntry, Effect, Operation, PendingQuestion, Timeline } from "./types";

/**
 * The conversation layer: every user turn gets exactly one answer, applied,
 * needs_clarification or rejected, and is written to the conversation log.
 * Only an `applied` edit (or an undo/redo) touches the operation log.
 * Rejection is a normal answer, never an exception.
 *
 * State is immutable: each function returns the new state beside the answer.
 */
export interface SessionState {
  log: Log;
  conversation: readonly ConversationEntry[];
}

export interface Turn {
  state: SessionState;
  answer: Answer;
}

export type TimePolicy = "current" | "original";

export interface TurnOptions {
  timePolicy?: TimePolicy;
  /** Warnings produced while resolving the instruction (e.g. a cut point moved off a word). */
  warnings?: readonly string[];
}

export function newSession(): SessionState {
  return { log: [], conversation: [] };
}

export function currentTimeline(ctx: EngineContext, state: SessionState): Timeline {
  return materialize(ctx, state.log);
}

// ---------------------------------------------------------------------------
// building answers
// ---------------------------------------------------------------------------

function answerOf(tl: Timeline, policy: TimePolicy, a: Partial<Answer> & Pick<Answer, "status">): Answer {
  return {
    operations: [],
    summary: null,
    question: null,
    options: [],
    reason: null,
    timePolicy: policy,
    warnings: [],
    ...a,
    timelineHash: timelineHash(tl),
    durationUs: tl.durationUs,
  };
}

function record(state: SessionState, text: string, answer: Answer, appliedGroup: number | null, pending: PendingQuestion | null, log: Log = state.log): SessionState {
  const entry: ConversationEntry = { turn: state.conversation.length, text, answer, appliedGroup, pending };
  return { log, conversation: [...state.conversation, entry] };
}

function formatDelta(beforeUs: number, afterUs: number): string {
  if (afterUs === beforeUs) return "unchanged";
  return `${afterUs < beforeUs ? "-" : "+"}${formatTime(Math.abs(afterUs - beforeUs))}`;
}

function effectLabel(ctx: EngineContext, e: Effect): string {
  if (e.params.kind === "caption") return `caption "${e.params.text}"`;
  if (e.params.kind === "text_overlay") return `text overlay "${e.params.text}"`;
  const words = rangeAtoms(ctx, e.range)
    .map((i) => ctx.index.atoms[i]!)
    .filter((a) => a.kind === "word")
    .map((a) => a.text)
    .join(" ");
  return `${e.params.kind} on "${words}"`;
}

/** Words of an effect's range that are cut right now. */
function cutWords(ctx: EngineContext, tl: Timeline, e: Effect): string[] {
  const pieces = timelinePieces(ctx, tl);
  return rangeAtoms(ctx, e.range)
    .map((i) => ctx.index.atoms[i]!)
    .filter((a) => a.kind === "word" && atomOutSpan(pieces, a) === null)
    .map((a) => a.text);
}

const LIST_LIMIT = 5;

function flaggedWarning(ctx: EngineContext, ops: readonly Operation[]): string[] {
  const touched = new Set<number>();
  for (const op of ops) {
    if (op.type === "cut" || op.type === "keep_only" || op.type === "set_speed" || op.type === "move") {
      const iv = spanToInterval(ctx.index, op.span, ctx.fps);
      atomsOverlapping(ctx, iv.s, iv.e).forEach((i) => touched.add(i));
    } else if (op.type === "add_effect") {
      rangeAtoms(ctx, op.range).forEach((i) => touched.add(i));
    }
  }
  const notes: string[] = [];
  for (const i of [...touched].sort((a, b) => a - b)) {
    const a = ctx.index.atoms[i]!;
    if (a.kind !== "word") continue;
    const why = [a.speakerUncertain ? "speaker uncertain" : "", a.overlapsSpeech ? "overlapping speech" : "", a.lowConfidence ? "low confidence" : ""].filter(Boolean);
    if (why.length > 0) notes.push(`"${a.text}" (${why.join(", ")})`);
  }
  if (notes.length === 0) return [];
  const shown = notes.slice(0, LIST_LIMIT).join(", ");
  const more = notes.length > LIST_LIMIT ? ` and ${notes.length - LIST_LIMIT} more` : "";
  return [`This edit touches words the transcript is unsure about: ${shown}${more}. Check the result.`];
}

/** Summary and warnings for a change from `before` to `after`. */
function describeChange(ctx: EngineContext, before: Timeline, after: Timeline, ops: readonly Operation[], extra: readonly string[]): { summary: string; warnings: string[] } {
  const parts = [`Length ${formatTime(before.durationUs)} -> ${formatTime(after.durationUs)} (${formatDelta(before.durationUs, after.durationUs)}).`];
  const warnings: string[] = [...extra];

  for (const e of after.effects) {
    const prev = before.effects.find((x) => x.id === e.id);
    const label = effectLabel(ctx, e);
    const dAfter = effectDisplay(ctx, after, e);
    const dBefore = prev ? effectDisplay(ctx, before, prev) : null;

    if (e.state === "inactive" && prev?.state !== "inactive") {
      warnings.push(`${label} is hidden because all of its words were cut. It stays in the history; restoring those words brings it back.`);
    } else if (e.state === "active" && e.partial && !prev?.partial) {
      warnings.push(`${label} keeps its text but some of its words were cut: ${cutWords(ctx, after, e).join(", ")}.`);
    }
    if (dAfter && !dBefore && prev && prev.state === "inactive") {
      parts.push(`${label} is visible again at ${formatTime(dAfter.startUs)}.`);
    } else if (dAfter && dBefore && dAfter.startUs !== dBefore.startUs) {
      parts.push(`${label} moved from ${formatTime(dBefore.startUs)} to ${formatTime(dAfter.startUs)}.`);
    }
    if (e.state === "active" && e.fragmented && !prev?.fragmented) {
      const where = dAfter ? ` at ${formatTime(dAfter.startUs)}` : "";
      warnings.push(
        e.params.kind === "mute" || e.params.kind === "bleep"
          ? `${label} now plays in ${dAfter?.runs.length ?? 2} separate places; it applies to the words wherever they are.`
          : `${label} is now split: its words no longer play together, so it is shown on the first part only${where}.`,
      );
    }
    if (dAfter?.extended && !dBefore?.extended) {
      warnings.push(`${label} would be on screen for under ${MIN_CAPTION_VISIBLE_US / 1_000_000} s after the speed change, so it is shown for 0.7 s instead.`);
    }
  }
  for (const op of ops) {
    if (op.type !== "move") continue;
    const iv = spanToInterval(ctx.index, op.span, ctx.fps);
    const first = atomsOverlapping(ctx, iv.s, iv.e).map((i) => ctx.index.atoms[i]!).find((a) => a.kind === "word");
    if (!first) continue;
    const was = atomOutSpan(timelinePieces(ctx, before), first);
    const now = atomOutSpan(timelinePieces(ctx, after), first);
    if (was && now) parts.push(`Moved the section starting "${first.text}" from ${formatTime(was.startUs)} to ${formatTime(now.startUs)}.`);
  }
  warnings.push(...flaggedWarning(ctx, ops));
  return { summary: parts.join(" "), warnings };
}

// ---------------------------------------------------------------------------
// validation of a new instruction
// ---------------------------------------------------------------------------

/** Check the operations one by one against the current state; returns the state after them. */
function validate(ctx: EngineContext, log: Log, ops: readonly Operation[]): Raw {
  const an = analyzeLog(log);
  let group = 0;
  for (const g of an.opsByGroup.keys()) if (g > group) group = g;
  group += 1;
  let raw = rawFromLog(ctx, log);
  for (const op of ops) {
    if (op.type === "restore") {
      if (!an.active.includes(op.targetGroup)) {
        throw new EngineError("INVALID_RESTORE", `edit ${op.targetGroup} is not in effect: it never existed or it was undone`);
      }
      if (an.neutralized.has(op.targetGroup)) {
        throw new EngineError("INVALID_RESTORE", `edit ${op.targetGroup} has already been restored`);
      }
      continue;
    }
    raw = applyOp(ctx, raw, op, group, true);
  }
  return raw;
}

function reject(ctx: EngineContext, state: SessionState, text: string, reason: string, policy: TimePolicy): Turn {
  const answer = answerOf(materialize(ctx, state.log), policy, { status: "rejected", reason });
  return { state: record(state, text, answer, null, null), answer };
}

// ---------------------------------------------------------------------------
// the five kinds of turn
// ---------------------------------------------------------------------------

/** Apply one instruction's operations as one undo group, or reject it. */
export function submitOperations(ctx: EngineContext, state: SessionState, text: string, ops: readonly Operation[], opts: TurnOptions = {}): Turn {
  const policy = opts.timePolicy ?? "current";
  const before = materialize(ctx, state.log);
  let after: Timeline;
  let appended: { log: Log; group: number };
  try {
    if (ops.length === 0) throw new EngineError("INVALID_RANGE", "the instruction produced no operations");
    const rawAfter = validate(ctx, state.log, ops);
    appended = appendEdit(state.log, ops);
    // Without a restore, replaying the new log is exactly "previous state + this group", so don't redo that work.
    if (!ops.some((o) => o.type === "restore")) primeRaw(ctx, appended.log, rawAfter);
    after = materialize(ctx, appended.log);
    if (after.durationUs === 0) throw new EngineError("EMPTY_RESULT", "this would remove the whole video; nothing would be left to play");
  } catch (e) {
    if (e instanceof EngineError) return reject(ctx, state, text, e.reason, policy);
    throw e;
  }

  const { summary, warnings } = describeChange(ctx, before, after, ops, opts.warnings ?? []);
  if (timelineHash(after) === timelineHash(before)) warnings.push("Nothing changed: the timeline is identical to before (this edit was already in effect).");
  const answer = answerOf(after, policy, { status: "applied", operations: [...ops], summary, warnings });
  return { state: record(state, text, answer, appended.group, null, appended.log), answer };
}

function undoRedo(ctx: EngineContext, state: SessionState, text: string, kind: "undo" | "redo", opts: TurnOptions): Turn {
  const policy = opts.timePolicy ?? "current";
  const an = analyzeLog(state.log);
  const target = kind === "undo" ? an.active.at(-1) : an.redo.at(-1);
  if (target === undefined) return reject(ctx, state, text, kind === "undo" ? "There is nothing to undo." : "There is nothing to redo.", policy);

  const before = materialize(ctx, state.log);
  const log = kind === "undo" ? appendUndo(state.log) : appendRedo(state.log);
  const after = materialize(ctx, log);
  const ops = analyzeLog(state.log).opsByGroup.get(target) ?? [];
  const change = describeChange(ctx, before, after, ops, opts.warnings ?? []);
  const verb = kind === "undo" ? "Undid" : "Redid";
  const answer = answerOf(after, policy, { status: "applied", summary: `${verb} edit ${target}. ${change.summary}`, warnings: change.warnings });
  return { state: record(state, text, answer, null, null, log), answer };
}

export function submitUndo(ctx: EngineContext, state: SessionState, text: string, opts: TurnOptions = {}): Turn {
  return undoRedo(ctx, state, text, "undo", opts);
}

export function submitRedo(ctx: EngineContext, state: SessionState, text: string, opts: TurnOptions = {}): Turn {
  return undoRedo(ctx, state, text, "redo", opts);
}

/** A rejection decided before any operation exists (e.g. "add a caption at 5:00" on a 3-minute video). */
export function submitRejection(ctx: EngineContext, state: SessionState, text: string, reason: string, opts: TurnOptions = {}): Turn {
  return reject(ctx, state, text, reason, opts.timePolicy ?? "current");
}

/** Ask a question instead of guessing. Changes nothing: not logged as an edit, not an undo group, same hash. */
export function askClarification(
  ctx: EngineContext,
  state: SessionState,
  text: string,
  question: string,
  options: PendingQuestion["options"],
  opts: TurnOptions = {},
): Turn {
  const policy = opts.timePolicy ?? "current";
  const answer = answerOf(materialize(ctx, state.log), policy, {
    status: "needs_clarification",
    question,
    options: options.map((o) => o.label),
    warnings: [...(opts.warnings ?? [])],
  });
  return { state: record(state, text, answer, null, { originalText: text, question, options }), answer };
}

/** The user picked option `choice` (0-based) of the open question. */
export function answerClarification(ctx: EngineContext, state: SessionState, text: string, choice: number, opts: TurnOptions = {}): Turn {
  const policy = opts.timePolicy ?? "current";
  const pending = state.conversation.at(-1)?.pending ?? null;
  if (!pending) return reject(ctx, state, text, "There is no open question to answer.", policy);
  const picked = pending.options[choice];
  if (!picked) {
    const answer = answerOf(materialize(ctx, state.log), policy, {
      status: "needs_clarification",
      question: pending.question,
      options: pending.options.map((o) => o.label),
      warnings: [`There is no option ${choice + 1}; please choose one of the ${pending.options.length} listed.`],
    });
    return { state: record(state, text, answer, null, pending), answer };
  }
  return submitOperations(ctx, state, text, picked.operations, { ...opts, warnings: [...picked.warnings, ...(opts.warnings ?? [])] });
}
