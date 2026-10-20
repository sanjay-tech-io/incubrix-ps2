/**
 * Data model for the editing engine. Types only: no behaviour lives here.
 *
 * Mirrors schemas/timeline.schema.json (kept in sync by hand; test/schema.test.ts
 * checks that a sample document validates against the schema).
 *
 * Design rules baked into these types:
 *  - Time is integer microseconds. Never floats, never seconds.
 *  - Everything that edits or decorates refers to atom IDs, never to times.
 *  - Nothing here holds a wall-clock time, session id or random value, so the
 *    materialized timeline can be hashed (CLAUDE.md rule 6).
 */

/** Integer microseconds. Plain number so it serialises as-is; integrality is validated, not typed. */
export type Micros = number;

/** Stable atom id: "a_" + 12 hex chars derived from (source sha256, index, kind, text, start). */
export type AtomId = string;

/** Id of an effect, derived from the log seq that created it, e.g. "fx_12_0". */
export type EffectId = string;

/** Id of a segment in the materialized timeline, derived from a counter, e.g. "seg_3". */
export type SegmentId = string;

// ---------------------------------------------------------------------------
// Source and atoms
// ---------------------------------------------------------------------------

/** The untouched input file. Only facts about it; the file itself is never modified. */
export interface Source {
  /** sha256 of the file bytes, lowercase hex. Proves the original was never damaged. */
  sha256: string;
  durationUs: Micros;
  /** Rational fps so frame maths is exact (30000/1001, not 29.97). Used only by the renderer. */
  fps: { num: number; den: number } | null; // null for audio-only
  hasAudio: boolean;
  hasVideo: boolean;
  /** Variable frame rate source (phone video). Renderer must normalise or fail clearly. */
  variableFrameRate: boolean;
}

export type AtomKind = "word" | "silence";

/**
 * One piece of the source. Atoms are contiguous and tile [0, source.durationUs]
 * with no gaps and no overlaps: atoms[i].endUs === atoms[i+1].startUs.
 * Atom times are SOURCE times and never change after ingest.
 */
export interface Atom {
  id: AtomId;
  kind: AtomKind;
  startUs: Micros;
  endUs: Micros;
  /** Spoken text, exactly as transcribed. Empty string for silence. */
  text: string;
  /** Speaker label from diarization, null if unknown/none (always null for silence). */
  speaker: string | null;
  /** ASR confidence as integer 0..1000 (permille). Integers keep the hash float-free. */
  confidencePermille: number;
  /** Confidence below the ingest threshold. Such words are flagged, not bleeped blindly. */
  lowConfidence: boolean;
  /** Candidate filler (um, uh, or "like" judged to be a filler from context). Set at ingest. */
  filler: boolean;
  /** Word overlaps another speaker's speech. Edits touching it produce a warning. */
  overlapsSpeech: boolean;
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/** Inclusive range of atoms in source order. What effects anchor to. */
export interface AtomRange {
  from: AtomId;
  to: AtomId;
}

/**
 * A point inside the source, as (atom, offset from that atom's start).
 * Needed because a cut may fall in the middle of a silence atom (cut rule:
 * exact inside silence). For a word atom offsetUs must be 0, so a cut can
 * never land inside a word (it snaps to silence first and warns).
 * Canonical form: a boundary between two atoms is {nextAtom, 0}; offset equal
 * to the atom's length is allowed only on the last atom (the end of the source).
 * The offset is already snapped to a frame boundary when the op is resolved.
 */
export interface Cursor {
  atom: AtomId;
  offsetUs: Micros;
}

/** Half-open region of the source [start, end), for cuts, keeps, moves and speed. */
export interface Span {
  start: Cursor;
  end: Cursor;
}

// ---------------------------------------------------------------------------
// Operations (what gets logged). All fields are already resolved to atoms.
// ---------------------------------------------------------------------------

/** Positive rational so speed maths is exact. 2/1 = 2x faster, 1/2 = half speed. */
export interface Rate {
  num: number;
  den: number;
}

export type EffectParams =
  | { kind: "caption"; text: string; style: CaptionStyle }
  | { kind: "text_overlay"; text: string; style: CaptionStyle; position: "top" | "center" | "bottom" }
  | { kind: "mute" }
  | { kind: "bleep" };

export interface CaptionStyle {
  color: string; // "#rrggbb"
  sizePt: number;
  bold: boolean;
}

export interface MusicParams {
  /** Reference to a stored music asset (by content hash), never a path. */
  assetSha256: string;
  /** Music level in dB relative to its source. */
  gainDb: number;
  /** How far music drops while someone speaks, in dB (positive number). */
  duckDb: number;
  attackUs: Micros;
  releaseUs: Micros;
}

export type Operation =
  /** Remove a span from the output. Ranges for filler/silence removal are resolved into many of these. */
  | { type: "cut"; span: Span; reason: "user" | "filler" | "silence" }
  /** Keep only this span. Its own op (not logged as many cuts) so history and restore read naturally. */
  | { type: "keep_only"; span: Span }
  /** Move a span so it plays immediately before `before`, or at the end when null. */
  | { type: "move"; span: Span; before: Cursor | null }
  /** Set playback speed over a span. Overlap rule: see SPEED_OVERLAP_RULE. */
  | { type: "set_speed"; span: Span; rate: Rate }
  | { type: "add_effect"; effectId: EffectId; range: AtomRange; params: EffectParams }
  | { type: "update_effect"; effectId: EffectId; params: EffectParams }
  | { type: "remove_effect"; effectId: EffectId }
  /** Captions generated from the atoms for the whole timeline (follow the words). */
  | { type: "auto_caption"; style: CaptionStyle }
  | { type: "set_music"; music: MusicParams }
  | { type: "clear_music" }
  /** A deliberate pause: silence removal must leave these atoms alone. */
  | { type: "protect_pause"; range: AtomRange }
  | { type: "unprotect_pause"; range: AtomRange }
  /**
   * "Restore edit N": undo the effect of one earlier instruction group while
   * keeping every later one. It is a NEW op that points at the old group; the
   * old entries stay in the log untouched.
   */
  | { type: "restore"; targetGroup: number };

/**
 * Documented rule for overlapping speed changes (decided once, here):
 * the later op wins on the atoms it covers. It REPLACES the earlier rate on the
 * overlap (rates never multiply) and splits the earlier region around it.
 * Rate 1/1 clears the speed. So "2x on 1:00-1:30" then "1x on 1:10-1:20"
 * leaves 2x on 1:00-1:10 and 1:20-1:30.
 */
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

export const SPEED_OVERLAP_RULE = "later-wins-replace" as const;

// ---------------------------------------------------------------------------
// Append-only operation log
// ---------------------------------------------------------------------------

/**
 * One instruction that changes the timeline = one group = one undo step.
 * `group` is a counter (1, 2, 3...) of timeline-changing instructions.
 * Clarification turns and rejections never create a group.
 */
export interface EditEntry {
  seq: number; // position in the log, 0-based, strictly increasing
  kind: "edit";
  group: number;
  op: Operation;
}

/**
 * Undo/redo are markers, not deletions. Replay walks the log keeping a stack of
 * active groups and a redo stack:
 *   edit  -> push its group on active (once per group), clear redo stack
 *   undo  -> move the top active group to redo
 *   redo  -> move the top redo group back to active
 * Markers carry no target; the stacks decide. Undo with nothing active, or redo
 * with nothing to redo, is rejected before it is ever logged.
 */
export interface UndoEntry {
  seq: number;
  kind: "undo";
}
export interface RedoEntry {
  seq: number;
  kind: "redo";
}

export type LogEntry = EditEntry | UndoEntry | RedoEntry;

// ---------------------------------------------------------------------------
// Materialized timeline = replay(source, atoms, log). Derived, never stored as truth.
// ---------------------------------------------------------------------------

/** A contiguous piece of the source, in output order. Cuts split segments; moves reorder them. */
export interface Segment {
  id: SegmentId;
  span: Span;
}

export interface SpeedRegion {
  span: Span;
  rate: Rate;
}

export interface Effect {
  id: EffectId;
  range: AtomRange;
  params: EffectParams;
  /**
   * active: at least one anchored atom is in the output.
   * dormant: every anchored atom is currently cut. It is kept (not deleted), so
   * restoring the cut brings the caption back, and the user is told it is hidden.
   */
  state: "active" | "dormant";
  /**
   * Partial-cut rule (proposed): if only some anchored atoms survive, the effect
   * stays on the survivors and `partial` is true so the answer can warn.
   */
  partial: boolean;
  /** Group that created it (for "undo that caption", history display). */
  createdInGroup: number;
}

export interface Timeline {
  sourceSha256: string;
  /** Output order. Concatenating these (with speed applied) is the edited video. */
  segments: Segment[];
  speedRegions: SpeedRegion[]; // non-overlapping, source order
  effects: Effect[]; // ordered by id creation
  protectedPauses: AtomRange[];
  music: MusicParams | null;
  autoCaption: CaptionStyle | null;
  /** Output length in microseconds after cuts and speed changes. */
  durationUs: Micros;
}

// ---------------------------------------------------------------------------
// Conversation log (separate from the operation log)
// ---------------------------------------------------------------------------

export type AnswerStatus = "applied" | "needs_clarification" | "rejected";

/** Mirrors the answer contract in CLAUDE.md. Operations are not repeated here; the group points to them. */
export interface Answer {
  status: AnswerStatus;
  summary: string | null;
  question: string | null;
  options: string[];
  reason: string | null;
  timePolicy: "current" | "original";
  warnings: string[];
  timelineHash: string;
  durationUs: Micros;
}

/** An unanswered question. The next user turn is interpreted against it. */
export interface PendingQuestion {
  /** The instruction that triggered the question, verbatim. */
  originalText: string;
  question: string;
  /** Candidate choices, each with the already-resolved operations it would log. */
  options: { label: string; operations: Operation[] }[];
}

/**
 * Every user turn is logged here, whatever the outcome. This log is how
 * "that caption", "the second one", "put back what I removed" get resolved.
 * It never feeds the timeline hash: a clarification turn changes nothing.
 * No timestamps in the engine; the API layer may store them beside, not inside.
 */
export interface ConversationEntry {
  turn: number; // 0-based
  text: string;
  answer: Answer;
  /** The edit group this turn created; null unless status is "applied". */
  appliedGroup: number | null;
  /** Set when status is needs_clarification; cleared by the next turn. */
  pending: PendingQuestion | null;
}

// ---------------------------------------------------------------------------
// The whole persisted session document
// ---------------------------------------------------------------------------

export interface SessionDocument {
  schemaVersion: 1;
  source: Source;
  atoms: Atom[];
  log: LogEntry[];
  conversation: ConversationEntry[];
}
