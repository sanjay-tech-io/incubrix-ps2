import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderTimeline, type RenderRequest } from "../src/index.ts";
import { makeSyncClip, measureSync } from "./syncclip.ts";
import { scripted, tmp } from "./helpers.ts";

const SETTINGS = { preset: "ultrafast", crf: 23, maxHeight: 0 };
const base = (clip: Awaited<ReturnType<typeof makeSyncClip>>, tl: ReturnType<ReturnType<typeof scripted>["timeline"]>, out: string, work: string): RenderRequest => ({
  ctx: clip.ctx, tl, videoFile: clip.file, audioFile: clip.file, musicFile: null, width: 320, height: 240, audioChannels: 1, videoOffsetUs: 0, out, workDir: work, settings: SETTINGS,
});

describe("render smoke", () => {
  it("an unedited timeline renders to the same frame count, with the flash and the tone together", async () => {
    const clip = await makeSyncClip({ fps: { num: 25, den: 1 }, seconds: 6 });
    const s = scripted(clip.ctx);
    const w = tmp("smoke");
    const r = await renderTimeline(base(clip, s.timeline(), join(w, "out.mp4"), w));
    expect(r.verification.problems).toEqual([]);
    const m = measureSync(join(w, "out.mp4"), clip.fps);
    console.log(JSON.stringify({ frames: r.graph.frames, verification: r.verification, m }));
    expect(m.events).toBe(6);
    expect(m.maxAbsOffsetFrames).toBeLessThanOrEqual(1);
  });
});
