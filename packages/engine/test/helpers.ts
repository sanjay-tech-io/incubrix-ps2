import { usToCursor } from "../src/cursor";
import type { EngineContext } from "../src/context";
import type { CaptionStyle, Operation, Span } from "../src/types";

export const WHITE: CaptionStyle = { color: "#ffffff", sizePt: 32, bold: true };
export const RED: CaptionStyle = { color: "#ff0000", sizePt: 32, bold: true };

/** A span from absolute source times. Test-side convenience; the engine itself never logs times. */
export function span(ctx: EngineContext, startUs: number, endUs: number): Span {
  return { start: usToCursor(ctx.index, startUs, ctx.fps), end: usToCursor(ctx.index, endUs, ctx.fps) };
}

export function cutOp(ctx: EngineContext, startUs: number, endUs: number): Operation {
  return { type: "cut", span: span(ctx, startUs, endUs), reason: "user" };
}

export function speedOp(ctx: EngineContext, startUs: number, endUs: number, num: number, den = 1): Operation {
  return { type: "set_speed", span: span(ctx, startUs, endUs), rate: { num, den } };
}

export function captionOp(effectId: string, from: string, to: string, text: string, style: CaptionStyle = WHITE): Operation {
  return { type: "add_effect", effectId, range: { from, to }, params: { kind: "caption", text, style, position: "bottom" } };
}
