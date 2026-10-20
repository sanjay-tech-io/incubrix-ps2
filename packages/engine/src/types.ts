/**
 * Shapes shared with the rest of the system come from @incubrix/contracts, where
 * they are zod schemas (the single source of truth). This file re-exports their
 * types and adds the few engine-only definitions.
 *
 * Design rules baked into the shapes (see docs/DESIGN.md):
 *  - Time is integer microseconds. Never floats, never seconds.
 *  - Everything that edits or decorates refers to atom IDs, never to times.
 *  - Nothing in a Timeline holds a wall-clock time, session id or random value,
 *    so it can be hashed (CLAUDE.md rule 6).
 */
export type {
  Answer,
  AnswerStatus,
  Atom,
  AtomId,
  AtomKind,
  AtomRange,
  CaptionStyle,
  ConversationEntry,
  Cursor,
  EditEntry,
  Effect,
  EffectId,
  EffectParams,
  LogEntry,
  Micros,
  MusicParams,
  Operation,
  PendingQuestion,
  Rate,
  Segment,
  SessionDocument,
  Source,
  Span,
  SpeedRegion,
  Timeline,
} from "@incubrix/contracts";

import type { Rate } from "@incubrix/contracts";

/**
 * Allowed speed range. The engine takes the limits as a parameter (it cannot read env);
 * the API layer fills them from MAX_SPEED (default 4) and the fixed minimum 0.25.
 * Outside the range an instruction is rejected with the reason and the allowed range.
 */
export interface SpeedLimits {
  min: Rate;
  max: Rate;
}
export const DEFAULT_SPEED_LIMITS: SpeedLimits = { min: { num: 1, den: 4 }, max: { num: 4, den: 1 } };

/**
 * Documented rule for overlapping speed changes (decided once, here):
 * the later op wins on the atoms it covers. It REPLACES the earlier rate on the
 * overlap (rates never multiply) and splits the earlier region around it.
 * Rate 1/1 clears the speed. So "2x on 1:00-1:30" then "1x on 1:10-1:20"
 * leaves 2x on 1:00-1:10 and 1:20-1:30.
 */
export const SPEED_OVERLAP_RULE = "later-wins-replace" as const;
