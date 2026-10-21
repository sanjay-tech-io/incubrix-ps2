import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { duckingEnvelope, submitOperations, type Fps } from "@incubrix/engine";
import { BUILTIN_MUSIC_SHA256, builtinMusicWav } from "@incubrix/media";
import { atempoChain, renderTimeline } from "../src/index.ts";
import { beepOnsets, decodeAudio, frameRgb, frequency, makeSyncClip, rms, type SyncClip } from "./syncclip.ts";
import { scripted, tmp } from "./helpers.ts";
import { writeFileSync } from "node:fs";

const SETTINGS = { preset: "ultrafast", crf: 18, maxHeight: 0 };
const FPS: Fps = { num: 25, den: 1 };

async function render(clip: SyncClip, tl: ReturnType<ReturnType<typeof scripted>["timeline"]>, music: string | null = null) {
  const w = tmp("feat");
  const out = join(w, "out.mp4");
  const r = await renderTimeline({ ctx: clip.ctx, tl, videoFile: clip.file, audioFile: clip.file, musicFile: music, width: 320, height: 240, audioChannels: 1, videoOffsetUs: 0, out, workDir: w, settings: SETTINGS });
  expect(r.verification.problems).toEqual([]);
  return { out, r, w };
}

function newRed(a: Buffer, b: Buffer): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) {
    const was = b[i]! > 200 && b[i + 1]! < 80 && b[i + 2]! < 80;
    const is = a[i]! > 200 && a[i + 1]! < 80 && a[i + 2]! < 80;
    if (is && !was) n++;
  }
  return n;
}

function diffPixels(a: Buffer, b: Buffer): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 90) n++;
  return n;
}

describe("atempo chain (pitch-preserving speed, factors outside 0.5-2.0 are chained)", () => {
  it("chains 2x steps and keeps the product equal to the rate", () => {
    const product = (r: { num: number; den: number }) => atempoChain(r).reduce((p, s) => p * Number(s.split("=")[1]), 1);
    expect(atempoChain({ num: 2, den: 1 })).toEqual(["atempo=2.0000000000"]);
    expect(atempoChain({ num: 4, den: 1 })).toEqual(["atempo=2.0000000000", "atempo=2.0000000000"]);
    expect(atempoChain({ num: 1, den: 4 })).toEqual(["atempo=0.5000000000", "atempo=0.5000000000"]);
    expect(atempoChain({ num: 1, den: 1 })).toEqual([]);
    for (const r of [{ num: 3, den: 1 }, { num: 3, den: 2 }, { num: 1, den: 3 }, { num: 5, den: 2 }, { num: 7, den: 3 }]) {
      for (const s of atempoChain(r)) {
        const f = Number(s.split("=")[1]);
        expect(f).toBeGreaterThanOrEqual(0.5);
        expect(f).toBeLessThanOrEqual(2);
      }
      expect(product(r)).toBeCloseTo(r.num / r.den, 8);
    }
  });
});

describe("every effect the timeline holds renders", () => {
  it("speed keeps the pitch: a 1 kHz tone is still 1 kHz at 2x and at 4x (chained atempo)", async () => {
    const clip = await makeSyncClip({ fps: FPS, seconds: 12 });
    for (const [instr, minHz] of [["speed up 0:04-0:08 by 2x", 950], ["speed up 0:04-0:08 by 4x", 950]] as const) {
      const s = scripted(clip.ctx);
      expect(s.say(instr).answer.status).toBe("applied");
      const { out } = await render(clip, s.timeline());
      const x = decodeAudio(out);
      const on = beepOnsets(out).onsets;
      // events 4..7 are inside the sped-up region: output onsets at index >= 4
      const hz = frequency(x, on[5]! + 0.003, on[5]! + 0.013);
      expect(hz, instr).toBeGreaterThan(minHz);
      expect(hz, instr).toBeLessThan(1050);
    }
  });

  it("slow motion (0.5x) lengthens the video, keeps the pitch", async () => {
    const clip = await makeSyncClip({ fps: FPS, seconds: 12 });
    const s = scripted(clip.ctx);
    const t = s.say("slow down 0:04-0:06 by 2x");
    expect(t.answer.status, t.answer.summary).toBe("applied");
    const { out, r } = await render(clip, s.timeline());
    expect(r.output.videoFrames).toBe(14 * 25);
    const on = beepOnsets(out).onsets;
    expect(frequency(decodeAudio(out), on[4]! + 0.003, on[4]! + 0.013)).toBeGreaterThan(950);
  });

  it("mute silences exactly the word; bleep replaces it with a 1 kHz tone at the documented level", async () => {
    const clip = await makeSyncClip({ fps: FPS, seconds: 12 });
    const s = scripted(clip.ctx);
    expect(s.say('mute "delta"').answer.status).toBe("applied");
    expect(s.say('bleep "golf"').answer.status).toBe("applied");
    const { out } = await render(clip, s.timeline());
    const x = decodeAudio(out);
    expect(rms(x, 3.02, 3.14)).toBeLessThan(0.005); // delta (3.0 s): muted
    expect(rms(x, 4.02, 4.14)).toBeGreaterThan(0.3); // echo (4.0 s): untouched, 0.5/sqrt2 = 0.354 (a mono voice is copied to both channels, not attenuated)
    const bleep = rms(x, 6.02, 6.14); // golf (6.0 s): 0.25/sqrt2 = 0.177
    expect(bleep).toBeGreaterThan(0.15);
    expect(bleep).toBeLessThan(0.21); // 0.25 / sqrt(2) per channel
    expect(frequency(x, 6.02, 6.14)).toBeGreaterThan(950);
  });

  it("captions: colour, text window and removal after a cut; auto-captions follow the surviving words", async () => {
    const clip = await makeSyncClip({ fps: FPS, seconds: 12 });
    const plain = scripted(clip.ctx);
    const base = await render(clip, plain.timeline());

    const s = scripted(clip.ctx);
    expect(s.say('add a caption "HELLO WORLD" on "charlie"').answer.status).toBe("applied");
    expect(s.say("make that caption red").answer.status).toBe("applied");
    const { out } = await render(clip, s.timeline());
    const at = (f: string, sec: number) => frameRgb(f, Math.round(sec * 25), 320, 240);
    // charlie is 2.0-2.16 s, the caption is shown for at least 0.7 s (2.0-2.7): visible at 2.4 s, gone at 1.0 and 3.5 s
    expect(diffPixels(at(out, 2.4), at(base.out, 2.4))).toBeGreaterThan(150);
    expect(newRed(at(out, 2.4), at(base.out, 2.4))).toBeGreaterThan(40); // the caption is red: pixels that are red now and were not red before
    expect(diffPixels(at(out, 1.0), at(base.out, 1.0))).toBeLessThan(15);
    expect(diffPixels(at(out, 3.5), at(base.out, 3.5))).toBeLessThan(15);

    const a = scripted(clip.ctx);
    expect(a.say("add captions").answer.status).toBe("applied");
    expect(a.say("cut 0:04-0:06").answer.status).toBe("applied");
    const auto = await render(clip, a.timeline());
    const cut = scripted(clip.ctx);
    cut.say("cut 0:04-0:06");
    const cutBase = await render(clip, cut.timeline());
    // frame of event "alpha" (0.0-0.16 s) has a cue; a stretch with no word does not
    expect(diffPixels(frameRgb(auto.out, 3, 320, 240), frameRgb(cutBase.out, 3, 320, 240))).toBeGreaterThan(100);
    expect(diffPixels(frameRgb(auto.out, 14, 320, 240), frameRgb(cutBase.out, 14, 320, 240))).toBeLessThan(15);
  });

  it("long caption text is read from a file (quotes and colons cannot break the filter graph)", async () => {
    const clip = await makeSyncClip({ fps: FPS, seconds: 6 });
    const s = scripted(clip.ctx);
    expect(s.say(`add a caption "It's 5:30 - 100% 'sure', really, a very long caption that has to wrap onto several lines" on "bravo"`).answer.status).toBe("applied");
    await render(clip, s.timeline());
  });
});

describe("background music follows the engine's ducking envelope", () => {
  it("rendered music level equals the timeline envelope (base, ducked and mid-ramp) within 1 dB", async () => {
    const clip = await makeSyncClip({ fps: FPS, seconds: 16, silentAudio: true });
    const wav = join(tmp("music"), "builtin.wav");
    writeFileSync(wav, builtinMusicWav());
    const s = scripted(clip.ctx);
    const music = { assetSha256: BUILTIN_MUSIC_SHA256, gainCentiDb: -1800, duckCentiDb: 1200, attackUs: 200_000, releaseUs: 600_000 };
    const turn = submitOperations(clip.ctx, s.state, "add music", [{ type: "set_music", music }]);
    expect(turn.answer.status).toBe("applied");
    // use the engine's state for the timeline
    const sc = scripted(clip.ctx);
    sc.say("cut 0:02-0:04"); // some editing so the envelope is built from the final output
    const t2 = submitOperations(clip.ctx, sc.state, "add music", [{ type: "set_music", music }]);
    const tl = (await import("@incubrix/engine")).currentTimeline(clip.ctx, t2.state);
    const { out } = await render(clip, tl, wav);
    const env = duckingEnvelope(clip.ctx, tl, music);
    const x = decodeAudio(out);
    const ref = decodeAudio(wav2mp4(wav));
    // expected level (dB) at output time t = envelope(t) + level of the raw music at that moment (its loop position)
    const gainAt = (tUs: number): number => {
      for (let i = 0; i + 1 < env.length; i++) {
        const a = env[i]!;
        const b = env[i + 1]!;
        if (tUs >= a.timeUs && tUs < b.timeUs) return a.gainCentiDb + ((b.gainCentiDb - a.gainCentiDb) * (tUs - a.timeUs)) / (b.timeUs - a.timeUs);
      }
      return env[env.length - 1]!.gainCentiDb;
    };
    const dbRatio = (t: number): number => 20 * Math.log10(rms(x, t - 0.02, t + 0.02) / rms(ref, t % 10 - 0.02, (t % 10) + 0.02));
    const probes: number[] = [];
    for (const k of env) probes.push(k.timeUs / 1e6);
    for (let i = 0; i + 1 < env.length; i++) probes.push((env[i]!.timeUs + env[i + 1]!.timeUs) / 2e6);
    const checked: { t: number; expected: number; measured: number }[] = [];
    for (const t of probes.filter((p) => p > 0.05 && p < tl.durationUs / 1e6 - 0.05)) {
      const expected = gainAt(t * 1e6) / 100;
      const measured = dbRatio(t);
      checked.push({ t, expected, measured });
    }
    writeFileSync(join(process.cwd(), "../../docs/raw/m3_music_envelope.json"), JSON.stringify(checked, null, 1));
    expect(checked.length).toBeGreaterThan(8);
    for (const c of checked) expect(Math.abs(c.measured - c.expected), JSON.stringify(c)).toBeLessThan(1.0);
    expect(Math.max(...checked.map((c) => c.expected)) - Math.min(...checked.map((c) => c.expected))).toBeGreaterThan(10); // it really ducks
  });
});

function wav2mp4(wav: string): string {
  return wav;
}
