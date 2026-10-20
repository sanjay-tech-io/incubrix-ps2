import type { EngineContext } from "./context";
import { EngineError } from "./errors";
import { applyOp, emptyRaw, finalize, type Raw } from "./replay";
import type { Operation, Timeline } from "./types";

/**
 * Incremental application: keeps one Raw snapshot per applied group, so an edit
 * costs one group's worth of work and undo/redo cost nothing, instead of
 * replaying the whole log each time.
 *
 * It is deliberately a SECOND, independent implementation of "which groups are
 * in effect" (snapshots on stacks, instead of analyzeLog's walk over the log).
 * A property test checks that it always agrees with the full replay, which is
 * the definition of the timeline. `restore` needs the full replay, so it is not
 * supported here.
 */
export class IncrementalTimeline {
  private active: { group: number; raw: Raw }[] = [];
  private redoStack: { group: number; raw: Raw }[] = [];
  private lastGroup = 0;

  constructor(private readonly ctx: EngineContext) {}

  private top(): Raw {
    return this.active.at(-1)?.raw ?? emptyRaw(this.ctx);
  }

  /** Apply one instruction as one group. Returns its group number. */
  edit(ops: readonly Operation[]): number {
    if (ops.some((o) => o.type === "restore")) throw new EngineError("NOT_IMPLEMENTED", "restore needs a full replay");
    const group = ++this.lastGroup;
    let raw = this.top();
    for (const op of ops) raw = applyOp(this.ctx, raw, op, group, false);
    this.active.push({ group, raw });
    this.redoStack = []; // a new edit clears redo
    return group;
  }

  undo(): boolean {
    const g = this.active.pop();
    if (!g) return false;
    this.redoStack.push(g);
    return true;
  }

  redo(): boolean {
    const g = this.redoStack.pop();
    if (!g) return false;
    this.active.push(g);
    return true;
  }

  timeline(): Timeline {
    return finalize(this.ctx, this.top());
  }
}
