import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectSilence, probe } from "../src/index.ts";

// All media is generated here with ffmpeg lavfi; nothing binary is committed.
let dir: string;
const f = (n: string) => join(dir, n);
const ff = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "media-"));
  // 1 s tone, 1 s silence, 1 s tone => silence is exactly [1.0, 2.0)
  ff("-filter_complex", "sine=f=440:d=1[a];anullsrc=r=16000:cl=mono:d=1[b];sine=f=440:d=1[c];[a][b][c]concat=n=3:v=0:a=1", "-ar", "16000", f("gap.wav"));
  // constant 30000/1001 video + audio
  ff("-f", "lavfi", "-i", "testsrc=s=160x120:r=30000/1001:d=2", "-f", "lavfi", "-i", "sine=f=300:d=2", "-shortest", "-pix_fmt", "yuv420p", f("ntsc.mp4"));
  // video only, 25 fps
  ff("-f", "lavfi", "-i", "testsrc=s=160x120:r=25:d=2", "-pix_fmt", "yuv420p", f("silentvideo.mp4"));
  // variable frame rate: drop frames in bursts and keep original timestamps
  ff("-f", "lavfi", "-i", "testsrc=s=160x120:r=30:d=4", "-vf", "select='lt(mod(n,30),10)+gt(mod(n,30),24)'", "-fps_mode", "vfr", "-pix_fmt", "yuv420p", f("vfr.mp4"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("probe", () => {
  it("audio-only file: duration, audio yes, video no", async () => {
    const p = await probe(f("gap.wav"));
    expect(p.hasAudio).toBe(true);
    expect(p.hasVideo).toBe(false);
    expect(p.durationUs).toBe(3_000_000);
    expect(p.video).toBeNull();
    expect(p.audio).toMatchObject({ sampleRate: 16000, channels: 1 });
  });

  it("NTSC video: fps is the exact fraction 30000/1001, not a float", async () => {
    const p = await probe(f("ntsc.mp4"));
    expect(p.hasVideo && p.hasAudio).toBe(true);
    expect(p.video!.fps).toEqual({ num: 30000, den: 1001 });
    expect(p.video).toMatchObject({ width: 160, height: 120, isVfr: false });
  });

  it("video without audio", async () => {
    const p = await probe(f("silentvideo.mp4"));
    expect(p.hasAudio).toBe(false);
    expect(p.hasVideo).toBe(true);
    expect(p.video!.fps).toEqual({ num: 25, den: 1 });
  });

  it("detects variable frame rate", async () => {
    expect((await probe(f("vfr.mp4"))).video!.isVfr).toBe(true);
  });

  it("a missing or non-media file is a clear error", async () => {
    await expect(probe(f("nope.mp4"))).rejects.toThrow(/ffprobe/);
  });
});

describe("detectSilence (from the AUDIO, not from the transcript)", () => {
  it("finds the 1 s gap with integer-microsecond bounds (within one analysis frame)", async () => {
    const s = await detectSilence(f("gap.wav"));
    expect(s).toHaveLength(1);
    expect(Math.abs(s[0]!.startUs - 1_000_000)).toBeLessThan(25_000);
    expect(Math.abs(s[0]!.endUs - 2_000_000)).toBeLessThan(25_000);
    expect(Number.isInteger(s[0]!.startUs)).toBe(true);
  });

  it("min duration filters out short pauses", async () => {
    expect(await detectSilence(f("gap.wav"), { minDurationUs: 1_500_000 })).toEqual([]);
  });

  it("a file with no audio stream is an error, not 'no silence'", async () => {
    await expect(detectSilence(f("silentvideo.mp4"))).rejects.toThrow(/no audio/i);
  });
});
