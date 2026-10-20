import { EngineError } from "./errors";
import type { EffectId, LogEntry, Operation } from "./types";

export type Log = readonly LogEntry[];

/** Number of edit entries so far. Effect ids count edit ops only (not undo/redo markers, not conversation turns). */
export function editCount(log: Log): number {
  return log.filter((e) => e.kind === "edit").length;
}

/** Id for the next effect: "fx_<ordinal of its edit entry>_<sub>". `pending` = edit ops already queued in the same instruction. */
export function nextEffectId(log: Log, pending = 0, sub = 0): EffectId {
  return `fx_${editCount(log) + pending}_${sub}`;
}

function lastGroup(log: Log): number {
  let g = 0;
  for (const e of log) if (e.kind === "edit" && e.group > g) g = e.group;
  return g;
}

/** Append one instruction's operations as ONE group (= one undo step). Pure: returns a new log. */
export function appendEdit(log: Log, ops: readonly Operation[]): { log: Log; group: number } {
  if (ops.length === 0) throw new EngineError("INVALID_LOG", "an edit needs at least one operation");
  const group = lastGroup(log) + 1;
  const entries: LogEntry[] = ops.map((op, i) => ({ seq: log.length + i, kind: "edit", group, op }));
  return { log: [...log, ...entries], group };
}

export function appendUndo(log: Log): Log {
  return [...log, { seq: log.length, kind: "undo" }];
}

export function appendRedo(log: Log): Log {
  return [...log, { seq: log.length, kind: "redo" }];
}

export interface LogAnalysis {
  /** Groups currently applied, oldest first. */
  active: number[];
  /** Groups that were undone and can be redone, next-to-redo last. */
  redo: number[];
  opsByGroup: Map<number, Operation[]>;
  /** Groups switched off by a `restore` op in a group that is itself in effect. */
  neutralized: Set<number>;
}

/**
 * Walk the log once and work out which groups are in effect.
 *  - edit: first entry of a new group pushes it on `active` and clears `redo`
 *          (a new edit clears redo); further entries join the same group.
 *  - undo: top of `active` moves to `redo`.   - redo: top of `redo` moves back.
 * Restore: going from the newest active group to the oldest, a group that is not
 * itself neutralized switches off the group its `restore` op points at. So
 * restoring a restore brings the original edit back.
 */
export function analyzeLog(log: Log): LogAnalysis {
  const active: number[] = [];
  let redo: number[] = [];
  const opsByGroup = new Map<number, Operation[]>();
  let current = 0; // group currently being filled
  let maxGroup = 0;

  log.forEach((e, i) => {
    if (e.seq !== i) throw new EngineError("INVALID_LOG", `entry ${i} has seq ${e.seq}`);
    if (e.kind === "edit") {
      if (e.group === current) {
        opsByGroup.get(e.group)!.push(e.op);
        return;
      }
      if (e.group !== maxGroup + 1) throw new EngineError("INVALID_LOG", `entry ${i}: group ${e.group} must be ${maxGroup + 1}`);
      maxGroup = e.group;
      current = e.group;
      active.push(e.group);
      redo = [];
      opsByGroup.set(e.group, [e.op]);
    } else if (e.kind === "undo") {
      const g = active.pop();
      if (g === undefined) throw new EngineError("NOTHING_TO_UNDO", `entry ${i}: nothing to undo`);
      redo.push(g);
      current = 0;
    } else {
      const g = redo.pop();
      if (g === undefined) throw new EngineError("NOTHING_TO_REDO", `entry ${i}: nothing to redo`);
      active.push(g);
      current = 0;
    }
  });

  const neutralized = new Set<number>();
  for (let k = active.length - 1; k >= 0; k--) {
    const g = active[k]!;
    if (neutralized.has(g)) continue;
    for (const op of opsByGroup.get(g)!) if (op.type === "restore") neutralized.add(op.targetGroup);
  }
  return { active, redo, opsByGroup, neutralized };
}
