import { z } from "zod";

/**
 * Single source of truth for the shapes that cross module boundaries: atoms,
 * operations, the log, the materialized timeline, answers and the persisted
 * session document. The TypeScript types are inferred from these schemas
 * (packages/engine re-exports them) and schemas/timeline.schema.json is
 * GENERATED from them (`npm run generate -w @incubrix/contracts`); a test fails
 * if the committed file differs from the generated one.
 *
 * Time is integer microseconds everywhere; there are no float fields except none:
 * music gain is integer centi-dB, speed is a rational {num, den}.
 */

const micros = z.number().int().min(0);
const posInt = z.number().int().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Stable atom id: "a_" + 12 hex chars derived from (source sha256, position, kind, text, start). */
export const AtomId = z.string().regex(/^a_[0-9a-f]{12}$/).meta({ id: "AtomId" });
/** Effect id "fx_<ordinal of the edit entry that created it>_<sub-index>". */
export const EffectId = z.string().regex(/^fx_[0-9]+_[0-9]+$/).meta({ id: "EffectId" });
const SegmentId = z.string().regex(/^seg_[0-9]+$/).meta({ id: "SegmentId" });
const Color = z.string().regex(/^#[0-9a-f]{6}$/).meta({ id: "Color" });

export const Fps = z.strictObject({ num: posInt, den: posInt }).meta({ id: "Fps" });

/** The untouched input file: facts about it only. */
export const Source = z
  .strictObject({
    sha256,
    durationUs: micros,
    fps: Fps.nullable(),
    hasAudio: z.boolean(),
    hasVideo: z.boolean(),
    variableFrameRate: z.boolean(),
  })
  .meta({ id: "Source" });

/** One word or one silence. Atoms are contiguous and tile [0, source.durationUs]. */
export const Atom = z
  .strictObject({
    id: AtomId,
    kind: z.enum(["word", "silence"]),
    startUs: micros,
    endUs: micros,
    text: z.string(),
    speaker: z.string().nullable(),
    confidencePermille: z.number().int().min(0).max(1000),
    lowConfidence: z.boolean(),
    filler: z.boolean(),
    overlapsSpeech: z.boolean(),
    speakerUncertain: z.boolean(),
    /** The diarization label of this word's turn looks wrong: another speaker's voice is clearly closer (services/asr swap detection). Optional so atoms stored before this existed still validate. */
    possibleLabelSwap: z.boolean().optional(),
  })
  .meta({ id: "Atom" });

/** Inclusive range of atoms in source order. What effects anchor to. */
export const AtomRange = z.strictObject({ from: AtomId, to: AtomId }).meta({ id: "AtomRange" });

/** A point inside the source: (atom, offset from that atom's start). See cursor rules in docs/DESIGN.md. */
export const Cursor = z.strictObject({ atom: AtomId, offsetUs: micros }).meta({ id: "Cursor" });

/** Half-open region of the source [start, end). */
export const Span = z.strictObject({ start: Cursor, end: Cursor }).meta({ id: "Span" });

/** Positive rational: 2/1 = twice as fast, 1/2 = half speed. */
export const Rate = z.strictObject({ num: posInt, den: posInt }).meta({ id: "Rate" });

export const CaptionStyle = z.strictObject({ color: Color, sizePt: posInt, bold: z.boolean() }).meta({ id: "CaptionStyle" });

export const MusicParams = z
  .strictObject({
    assetSha256: sha256,
    gainCentiDb: z.number().int(),
    duckCentiDb: z.number().int().min(0),
    attackUs: micros,
    releaseUs: micros,
  })
  .meta({ id: "MusicParams" });

const Position = z.enum(["top", "center", "bottom"]).meta({ id: "Position" });

export const EffectParams = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("caption"), text: z.string(), style: CaptionStyle, position: Position }),
    z.strictObject({ kind: z.literal("text_overlay"), text: z.string(), style: CaptionStyle, position: Position }),
    z.strictObject({ kind: z.literal("mute") }),
    z.strictObject({ kind: z.literal("bleep") }),
  ])
  .meta({ id: "EffectParams" });

/** What gets logged. Every field is already resolved to atoms. */
export const Operation = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("cut"), span: Span, reason: z.enum(["user", "filler", "silence"]) }),
    z.strictObject({ type: z.literal("keep_only"), span: Span }),
    z.strictObject({ type: z.literal("move"), span: Span, before: Cursor.nullable() }),
    z.strictObject({ type: z.literal("set_speed"), span: Span, rate: Rate }),
    z.strictObject({ type: z.literal("add_effect"), effectId: EffectId, range: AtomRange, params: EffectParams }),
    z.strictObject({ type: z.literal("update_effect"), effectId: EffectId, params: EffectParams }),
    z.strictObject({ type: z.literal("remove_effect"), effectId: EffectId }),
    z.strictObject({ type: z.literal("auto_caption"), style: CaptionStyle }),
    z.strictObject({ type: z.literal("clear_auto_caption") }),
    z.strictObject({ type: z.literal("set_music"), music: MusicParams }),
    z.strictObject({ type: z.literal("clear_music") }),
    z.strictObject({ type: z.literal("protect_pause"), range: AtomRange }),
    z.strictObject({ type: z.literal("unprotect_pause"), range: AtomRange }),
    z.strictObject({ type: z.literal("restore"), targetGroup: posInt }),
  ])
  .meta({ id: "Operation" });

/** Append-only log. Undo/redo are markers; one instruction = one `group`. */
export const LogEntry = z
  .discriminatedUnion("kind", [
    z.strictObject({ seq: micros, kind: z.literal("edit"), group: posInt, op: Operation }),
    z.strictObject({ seq: micros, kind: z.literal("undo") }),
    z.strictObject({ seq: micros, kind: z.literal("redo") }),
  ])
  .meta({ id: "LogEntry" });

// --- materialized timeline (what timeline_hash is computed over) ---------------

export const Segment = z.strictObject({ id: SegmentId, span: Span }).meta({ id: "Segment" });
export const SpeedRegion = z.strictObject({ span: Span, rate: Rate }).meta({ id: "SpeedRegion" });

export const Effect = z
  .strictObject({
    id: EffectId,
    range: AtomRange,
    params: EffectParams,
    /** inactive: every anchored atom is cut. Kept (never deleted) so restoring the words brings it back. */
    state: z.enum(["active", "inactive"]),
    /** Some, not all, anchored words are cut. */
    partial: z.boolean(),
    /** Surviving anchored words are not all in one run in the output (a reorder split them): a caption shows on the first run only. */
    fragmented: z.boolean(),
    createdInGroup: posInt,
  })
  .meta({ id: "Effect" });

export const Timeline = z
  .strictObject({
    sourceSha256: sha256,
    segments: z.array(Segment),
    speedRegions: z.array(SpeedRegion),
    effects: z.array(Effect),
    protectedPauses: z.array(AtomRange),
    music: MusicParams.nullable(),
    autoCaption: CaptionStyle.nullable(),
    durationUs: micros,
  })
  .meta({ id: "Timeline", description: "Materialized result of replay(source, atoms, log). timeline_hash is the sha256 of its canonical JSON." });

// --- answers and the conversation log -----------------------------------------

export const AnswerStatus = z.enum(["applied", "needs_clarification", "rejected"]);

/** Exactly one of three outcomes for every instruction. */
export const Answer = z
  .strictObject({
    status: AnswerStatus,
    operations: z.array(Operation),
    summary: z.string().nullable(),
    question: z.string().nullable(),
    options: z.array(z.string()),
    reason: z.string().nullable(),
    timePolicy: z.enum(["current", "original"]),
    warnings: z.array(z.string()),
    timelineHash: sha256,
    durationUs: micros,
  })
  .meta({ id: "Answer" });

export const PendingQuestion = z
  .strictObject({
    originalText: z.string(),
    question: z.string(),
    options: z.array(z.strictObject({ label: z.string(), operations: z.array(Operation), warnings: z.array(z.string()) })),
  })
  .meta({ id: "PendingQuestion" });

export const ConversationEntry = z
  .strictObject({
    turn: micros,
    text: z.string(),
    answer: Answer,
    appliedGroup: posInt.nullable(),
    pending: PendingQuestion.nullable(),
  })
  .meta({ id: "ConversationEntry" });

/** The whole persisted session. */
export const SessionDocument = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: Source,
    atoms: z.array(Atom),
    log: z.array(LogEntry),
    conversation: z.array(ConversationEntry),
  })
  .meta({ id: "SessionDocument", title: "IncuBrix session document" });

// --- inferred types ------------------------------------------------------------

export type Micros = number;
export type AtomId = z.infer<typeof AtomId>;
export type EffectId = z.infer<typeof EffectId>;
export type Fps = z.infer<typeof Fps>;
export type Source = z.infer<typeof Source>;
export type Atom = z.infer<typeof Atom>;
export type AtomKind = Atom["kind"];
export type AtomRange = z.infer<typeof AtomRange>;
export type Cursor = z.infer<typeof Cursor>;
export type Span = z.infer<typeof Span>;
export type Rate = z.infer<typeof Rate>;
export type CaptionStyle = z.infer<typeof CaptionStyle>;
export type MusicParams = z.infer<typeof MusicParams>;
export type EffectParams = z.infer<typeof EffectParams>;
export type Operation = z.infer<typeof Operation>;
export type LogEntry = z.infer<typeof LogEntry>;
export type EditEntry = Extract<LogEntry, { kind: "edit" }>;
export type Segment = z.infer<typeof Segment>;
export type SpeedRegion = z.infer<typeof SpeedRegion>;
export type Effect = z.infer<typeof Effect>;
export type Timeline = z.infer<typeof Timeline>;
export type AnswerStatus = z.infer<typeof AnswerStatus>;
export type Answer = z.infer<typeof Answer>;
export type PendingQuestion = z.infer<typeof PendingQuestion>;
export type ConversationEntry = z.infer<typeof ConversationEntry>;
export type SessionDocument = z.infer<typeof SessionDocument>;

// --- JSON Schema generation ----------------------------------------------------

/**
 * The JSON Schema (draft 2020-12) generated from the zod schemas.
 * Root = a session document; every named shape (including the materialized Timeline,
 * which a session document does not contain) is available under $defs.
 */
export function generateTimelineJsonSchema(): Record<string, unknown> {
  const both = z.object({ session: SessionDocument, timeline: Timeline });
  const generated = z.toJSONSchema(both, { target: "draft-2020-12", io: "output" }) as { $defs?: Record<string, unknown> };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://incubrix.example/schemas/timeline.schema.json",
    $ref: "#/$defs/SessionDocument",
    $defs: generated.$defs ?? {},
  };
}
