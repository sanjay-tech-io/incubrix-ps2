import { z } from "zod";
import type { EngineContext, Timeline } from "@incubrix/engine";

/**
 * The ONLY thing the model may return: a short list of commands in a closed vocabulary. They carry no atom ids and no
 * operations; each one is turned into a plain sentence and parsed by our own rules parser and engine, so every limit
 * (speed range, out of range, whole-video cut, destructive questions) is enforced by code we test, not by the model.
 */
const sec = z.number().min(0).max(86_400);
const range = { start_s: sec, end_s: sec };
const Color = z.enum(["red", "blue", "green", "yellow", "white", "black", "orange", "purple", "pink"]);

const Command = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("cut"), ...range, original: z.boolean().optional() }),
  z.strictObject({ op: z.literal("keep_only"), ...range }),
  z.strictObject({ op: z.literal("speed"), ...range, rate: z.number().min(0.1).max(16) }),
  z.strictObject({ op: z.literal("move"), ...range, to: z.union([z.literal("end"), z.literal("start"), sec]) }),
  z.strictObject({ op: z.literal("caption"), text: z.string().min(1).max(200), on_phrase: z.string().min(1).max(200).optional(), at_s: sec.optional() }),
  z.strictObject({ op: z.literal("caption_style"), color: Color.optional(), size: z.enum(["bigger", "smaller"]).optional(), position: z.enum(["top", "center", "bottom"]).optional(), bold: z.boolean().optional() }),
  z.strictObject({ op: z.literal("mute"), phrase: z.string().min(1).max(200) }),
  z.strictObject({ op: z.literal("bleep"), phrase: z.string().min(1).max(200) }),
  z.strictObject({ op: z.literal("remove_fillers") }),
  z.strictObject({ op: z.literal("remove_silences"), min_s: sec.optional() }),
  z.strictObject({ op: z.literal("auto_captions") }),
  z.strictObject({ op: z.literal("music"), on: z.boolean() }),
  z.strictObject({ op: z.literal("undo") }),
  z.strictObject({ op: z.literal("redo") }),
  z.strictObject({ op: z.literal("restore"), edit: z.number().int().min(1).optional(), what: z.enum(["intro", "outro", "any"]).optional() }),
  z.strictObject({ op: z.literal("unsupported"), reason: z.string().min(1).max(300) }),
]);
export type Command = z.infer<typeof Command>;

export const Commands = z.strictObject({ commands: z.array(Command).min(1).max(5) });
export type CommandList = z.infer<typeof Commands>;

const t = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;

export function commandText(c: Command): string {
  switch (c.op) {
    case "cut": return `cut ${t(c.start_s)}-${t(c.end_s)}${c.original ? " of the original" : ""}`;
    case "keep_only": return `keep only ${t(c.start_s)}-${t(c.end_s)}`;
    case "speed": return c.rate >= 1 ? `speed up ${t(c.start_s)}-${t(c.end_s)} by ${c.rate}x` : `slow down ${t(c.start_s)}-${t(c.end_s)} to ${c.rate}x`;
    case "move": return `move ${t(c.start_s)}-${t(c.end_s)} to ${typeof c.to === "number" ? t(c.to) : `the ${c.to}`}`;
    case "caption": return c.on_phrase ? `add a caption "${c.text}" on "${c.on_phrase}"` : c.at_s !== undefined ? `add a caption "${c.text}" at ${t(c.at_s)}` : `add a caption "${c.text}"`;
    case "caption_style": return `make that caption ${[c.color, c.size, c.position, c.bold ? "bold" : ""].filter(Boolean).join(" and ")}`.trim();
    case "mute": return `mute "${c.phrase}"`;
    case "bleep": return `bleep "${c.phrase}"`;
    case "remove_fillers": return "remove filler words";
    case "remove_silences": return c.min_s !== undefined ? `remove silences longer than ${t(c.min_s)}` : "remove silences";
    case "auto_captions": return "add captions";
    case "music": return c.on ? "add background music" : "remove the music";
    case "undo": return "undo";
    case "redo": return "redo";
    case "restore": return c.edit !== undefined ? `restore edit ${c.edit}` : c.what === "intro" ? "put the intro back" : c.what === "outro" ? "put the outro back" : "put back what I removed";
    case "unsupported": return "";
  }
}

export const commandsToText = (cs: readonly Command[]): string => cs.map(commandText).filter(Boolean).join("; ");

/**
 * What the model is told about the session. Small, no transcript text, no media, no file names: the length, what effects exist
 * (kind, state, start time; NOT their text) and whether music or auto-captions are on.
 */
export function contextSummary(ctx: EngineContext, tl: Timeline) {
  return {
    durationS: Math.round(tl.durationUs / 1000) / 1000,
    sourceDurationS: Math.round(ctx.source.durationUs / 1000) / 1000,
    effects: tl.effects.map((e) => ({ id: e.id, kind: e.params.kind, state: e.state })),
    music: tl.music !== null,
    autoCaption: tl.autoCaption !== null,
    segments: tl.segments.length,
  };
}
export type ContextSummary = ReturnType<typeof contextSummary>;
