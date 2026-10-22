import { describe, expect, it } from "vitest";
import { currentTimeline, newSession, timelineHash, timelinePieces, effectDisplay, type EngineContext, type SessionState } from "@incubrix/engine";
import { RulesParser, runInstruction } from "@incubrix/nlu";
import { makeFixture } from "../../engine/test/fixtures/transcript.ts";
import { buildOtioPayload, mockOtioJson, type OtioPayload } from "../src/index.ts";

const U = 1_000_000;
const parser = new RulesParser();

/** Cut + speed + reorder + a caption + auto captions, through the real rules parser and engine. */
function edited(): { ctx: EngineContext; state: SessionState } {
  const { ctx } = makeFixture();
  let state = newSession();
  const say = (text: string, answer?: string): void => {
    const t = runInstruction(ctx, state, answer === undefined ? { text, side: {} } : { text, side: {}, answer }, parser);
    expect(t.answer.status, `${text}: ${t.answer.reason ?? t.answer.question ?? ""}`).toBe("applied");
    state = t.state;
  };
  say('add a caption "Welcome!" on "welcome to the channel"');
  say("cut the first 30 seconds");
  say("speed up 1:00-1:30 by 2x");
  say("move 0:20-0:30 to the end");
  say("add captions");
  return { ctx, state };
}

const frames = (us: number, fps = { num: 30, den: 1 }): number => Math.round((us * fps.num) / (fps.den * U));

describe("buildOtioPayload on a timeline with cut + speed + reorder", () => {
  const { ctx, state } = edited();
  const tl = currentTimeline(ctx, state);
  const p: OtioPayload = buildOtioPayload(ctx, tl, { name: "session ses_test", sourceName: "original.mp4", aiGenerated: false });
  const pieces = timelinePieces(ctx, tl);

  it("has one clip per piece, in OUTPUT order, and their output durations add up to exactly the timeline length in frames", () => {
    expect(p.clips).toHaveLength(pieces.length);
    expect(p.clips.map((c) => c.src_start_us)).toEqual(pieces.map((x) => x.srcS)); // output order, not source order
    expect(pieces.some((x, i) => i > 0 && x.srcS < pieces[i - 1]!.srcS)).toBe(true); // the move really reordered something
    expect(p.clips.reduce((s, c) => s + c.out_duration, 0)).toBe(frames(tl.durationUs));
    expect(p.clips.reduce((s, c) => s + c.out_duration, 0)).toBe(pieces.reduce((s, x) => s + x.outFrames!, 0));
  });

  it("each clip reads (output length x speed) of source, within 1 frame of its source span; speed is kept as a rational", () => {
    const frameUs = U / 30;
    for (const [i, c] of p.clips.entries()) {
      const piece = pieces[i]!;
      expect(c.speed).toEqual(piece.rate);
      const readUs = (c.out_duration * frameUs * piece.rate.num) / piece.rate.den;
      expect(Math.abs(readUs - (piece.srcE - piece.srcS)), `clip ${i}`).toBeLessThanOrEqual(frameUs * Math.max(1, piece.rate.num / piece.rate.den));
      expect(c.src_start).toBe(frames(piece.srcS));
    }
    expect(p.clips.some((c) => c.speed.num === 2 && c.speed.den === 1)).toBe(true);
  });

  it("the caption is a marker at its output time; auto captions are markers too; nothing else is invented", () => {
    const e = tl.effects.find((x) => x.params.kind === "caption")!;
    const d = effectDisplay(ctx, tl, e)!;
    const m = p.markers.find((x) => x.kind === "caption")!;
    expect(m).toMatchObject({ name: "Welcome!", text: "Welcome!", effect_id: e.id, start: frames(d.startUs) });
    expect(m.duration).toBe(Math.max(1, frames(d.endUs) - frames(d.startUs)));
    expect(m.color).toMatch(/^#[0-9a-f]{6}$/);
    const auto = p.markers.filter((x) => x.kind === "auto_caption");
    expect(auto.length).toBeGreaterThan(3);
    expect(auto.every((x) => x.start >= 0 && x.start + x.duration <= frames(tl.durationUs) + 1)).toBe(true);
  });

  it("carries the timeline hash, the source and the rate; building twice gives the same payload", () => {
    expect(p.rate).toEqual({ num: 30, den: 1 });
    expect(p.source).toMatchObject({ name: "original.mp4", has_video: true, has_audio: true, duration_units: 200 * 30 });
    expect(p.metadata).toMatchObject({ timeline_hash: timelineHash(tl), duration_us: tl.durationUs, ai_generated: false });
    expect(buildOtioPayload(ctx, tl, { name: "session ses_test", sourceName: "original.mp4", aiGenerated: false })).toEqual(p);
  });

  it("the mock exporter writes OTIO JSON of the same shape as the library (schema names, ranges, LinearTimeWarp, markers)", () => {
    const j = JSON.parse(mockOtioJson(p));
    expect(j.OTIO_SCHEMA).toBe("Timeline.1");
    const v = j.tracks.children.find((t: any) => t.kind === "Video");
    expect(v.children).toHaveLength(p.clips.length);
    expect(v.children[0]).toMatchObject({ OTIO_SCHEMA: "Clip.2", source_range: { OTIO_SCHEMA: "TimeRange.1", start_time: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: p.clips[0]!.src_start } } });
    const warped = v.children.filter((c: any) => c.effects.length > 0);
    expect(warped.length).toBeGreaterThan(0);
    expect(warped[0].effects[0]).toMatchObject({ OTIO_SCHEMA: "LinearTimeWarp.1", effect_name: "LinearTimeWarp" });
    expect(v.markers.some((m: any) => m.OTIO_SCHEMA === "Marker.2" && m.name === "Welcome!")).toBe(true);
    expect(j.tracks.children.map((t: any) => t.kind)).toEqual(["Video", "Audio"]);
    expect(mockOtioJson(p)).toBe(mockOtioJson(p)); // deterministic
  });
});

describe("edge cases", () => {
  it("an untouched timeline is one clip of the whole source;", () => {
    const { ctx } = makeFixture();
    const tl = currentTimeline(ctx, newSession());
    const p = buildOtioPayload(ctx, tl, { name: "x", sourceName: "a.mp4", aiGenerated: true });
    expect(p.clips).toHaveLength(1);
    expect(p.clips[0]).toMatchObject({ src_start: 0, out_duration: 6000, speed: { num: 1, den: 1 } });
    expect(p.metadata).toMatchObject({ ai_generated: true });
  });
});
