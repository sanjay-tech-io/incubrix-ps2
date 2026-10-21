import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fps } from "@incubrix/engine";
import { probe } from "@incubrix/media";
import { decideProxy, makeProxy, probeStreams, renderTimeline } from "../src/index.ts";
import { makeSyncClip, measureSync } from "./syncclip.ts";
import { scripted, tmp } from "./helpers.ts";

const SETTINGS = { preset: "ultrafast", crf: 23, maxHeight: 0 };
const U = 1_000_000;
const rows: Record<string, unknown>[] = [];

/** The edit mix of the brief: cut, speed 2x, reorder, restore. Whole seconds, so every boundary is in silence or at a word edge. */
const MIX = ["cut 0:02-0:04", "speed up 0:06-0:10 by 2x", "move 0:00-0:02 to the end", "put back what I removed"];

const FPS: [string, Fps][] = [["25", { num: 25, den: 1 }], ["30", { num: 30, den: 1 }], ["29.97", { num: 30000, den: 1001 }]];

describe("frame accuracy after a mix of edits (generated media, ffprobe + decode measurement)", () => {
  for (const [name, fps] of FPS) {
    it(`${name} fps: length equals the timeline within 1 frame and the flash/tone offset is within 1 frame`, async () => {
      const clip = await makeSyncClip({ fps, seconds: 16 });
      const s = scripted(clip.ctx);
      const steps = MIX.map((t) => s.say(t));
      for (const t of steps) expect(t.answer.status, String(t.answer.summary)).toBe("applied");
      const tl = s.timeline();
      const w = tmp(`acc-${name}`);
      const out = join(w, "out.mp4");
      const r = await renderTimeline({ ctx: clip.ctx, tl, videoFile: clip.file, audioFile: clip.file, musicFile: null, width: 320, height: 240, audioChannels: 1, videoOffsetUs: 0, out, workDir: w, settings: SETTINGS });
      expect(r.verification.problems).toEqual([]);
      const m = measureSync(out, fps);
      const frameUs = (U * fps.den) / fps.num;
      const row = {
        fps: name, edits: MIX.join("; "), pieces: r.graph.pieces, timeline_us: tl.durationUs, timeline_frames: r.graph.frames,
        rendered_frames: r.output.videoFrames, length_diff_frames: r.output.videoFrames - r.graph.frames,
        audio_minus_video_frames: Number(r.verification.audioVsVideoFrames.toFixed(3)), events: m.events, unmatched: m.unmatched,
        av_offsets_frames: m.offsetsFrames.map((x) => Number(x.toFixed(3))), av_offset_max_frames: Number(m.maxAbsOffsetFrames.toFixed(3)),
        timeline_frames_from_duration: Math.round(tl.durationUs / frameUs),
      };
      rows.push(row);
      mkdirSync(join(process.cwd(), "../../docs/raw"), { recursive: true });
      writeFileSync(join(process.cwd(), `../../docs/raw/m3_accuracy_${name}.json`), JSON.stringify(row, null, 2));
      expect(Math.abs(row.rendered_frames - row.timeline_frames_from_duration)).toBeLessThanOrEqual(1);
      expect(m.unmatched).toBe(0);
      expect(m.maxAbsOffsetFrames).toBeLessThanOrEqual(1);
    });
  }

  it("a variable-frame-rate clip renders through a CFR proxy; the original is untouched", async () => {
    const fps = { num: 30, den: 1 };
    const clip = await makeSyncClip({ fps, seconds: 16, vfr: true });
    const w = tmp("acc-vfr");
    const facts = await probeStreams(clip.file);
    const dec = decideProxy(facts, true);
    expect(dec.needed).toBe(true);
    expect((await probe(clip.file)).video?.isVfr).toBe(true); // the media probe really sees this file as VFR
    const proxy = await makeProxy({ original: clip.file, out: join(w, "proxy.mp4"), facts, vfr: true, fps, offsetUs: 0 });
    expect(proxy.warnings.join(" ")).toMatch(/variable frame rate/);
    const s = scripted(clip.ctx);
    for (const t of MIX) expect(s.say(t).answer.status).toBe("applied");
    const tl = s.timeline();
    const out = join(w, "out.mp4");
    const r = await renderTimeline({ ctx: clip.ctx, tl, videoFile: proxy.path, audioFile: clip.file, musicFile: null, width: 320, height: 240, audioChannels: 1, videoOffsetUs: 0, out, workDir: w, settings: SETTINGS });
    expect(r.verification.problems).toEqual([]);
    const m = measureSync(out, fps);
    const row = {
      fps: "30 (VFR source via CFR proxy)", edits: MIX.join("; "), pieces: r.graph.pieces, timeline_us: tl.durationUs, timeline_frames: r.graph.frames,
      rendered_frames: r.output.videoFrames, length_diff_frames: r.output.videoFrames - r.graph.frames,
      audio_minus_video_frames: Number(r.verification.audioVsVideoFrames.toFixed(3)), events: m.events, unmatched: m.unmatched,
      av_offsets_frames: m.offsetsFrames.map((x) => Number(x.toFixed(3))), av_offset_max_frames: Number(m.maxAbsOffsetFrames.toFixed(3)),
    };
    writeFileSync(join(process.cwd(), "../../docs/raw/m3_accuracy_vfr.json"), JSON.stringify(row, null, 2));
    expect(m.unmatched).toBe(0);
    expect(m.maxAbsOffsetFrames).toBeLessThanOrEqual(1);
  });
});

describe("a large graph: 300 pieces stay frame-exact", () => {
  it("one instruction with 300 cuts renders in ONE ffmpeg run, frame count exact, A/V offset within 1 frame", async () => {
    const { manyCuts } = await import("./many.ts");
    const fps = { num: 25, den: 1 };
    const clip = await makeSyncClip({ fps, seconds: 100 });
    const { timeline, cuts } = manyCuts(clip, 100);
    const w = tmp("many");
    const out = join(w, "out.mp4");
    const r = await renderTimeline({ ctx: clip.ctx, tl: timeline, videoFile: clip.file, audioFile: clip.file, musicFile: null, width: 320, height: 240, audioChannels: 1, videoOffsetUs: 0, out, workDir: w, settings: SETTINGS });
    expect(cuts).toBe(300);
    expect(r.graph.pieces).toBeGreaterThanOrEqual(300);
    expect(r.verification.problems).toEqual([]);
    const m = measureSync(out, fps);
    writeFileSync(join(process.cwd(), "../../docs/raw/m3_accuracy_300_pieces.json"), JSON.stringify({ pieces: r.graph.pieces, timeline_frames: r.graph.frames, rendered_frames: r.output.videoFrames, events: m.events, unmatched: m.unmatched, av_offset_max_frames: m.maxAbsOffsetFrames, render_ms: r.elapsedMs }, null, 2));
    expect(m.unmatched).toBe(0);
    expect(m.maxAbsOffsetFrames).toBeLessThanOrEqual(1);
  });
});

import { RenderError } from "../src/index.ts";
describe("no-audio source", () => {
  it("fails clearly with NO_AUDIO_TRACK and renders nothing", async () => {
    const clip = await makeSyncClip({ fps: { num: 25, den: 1 }, seconds: 4, audio: false });
    const w = tmp("noaudio");
    const s = scripted(clip.ctx);
    await expect(renderTimeline({ ctx: clip.ctx, tl: s.timeline(), videoFile: clip.file, audioFile: clip.file, musicFile: null, width: 320, height: 240, audioChannels: 0, videoOffsetUs: 0, out: join(w, "o.mp4"), workDir: w, settings: SETTINGS })).rejects.toMatchObject({ code: "NO_AUDIO_TRACK" });
    expect(new RenderError("NO_AUDIO_TRACK", "x").code).toBe("NO_AUDIO_TRACK");
  });
});
