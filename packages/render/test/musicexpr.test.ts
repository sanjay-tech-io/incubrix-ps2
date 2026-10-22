import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { musicGainExpr } from "../src/index.ts";

/**
 * Regression (found by the CI scenarios, s39): a few minutes of speech with pauses in between gives hundreds of ducking keyframes, and the
 * old "term + term + term ..." expression made ffmpeg stop with "Error initializing complex filters" (its expression parser nests one level
 * per operator and gives up at about 100). The expression must work for any number of keyframes AND give the same gain as the envelope.
 */
const U = 1_000_000;

/** A ducking-like envelope: base -18 dB, ducked to -30 dB around speech every `period` seconds. */
function envelope(stretches: number, period = 4): { timeUs: number; gainCentiDb: number }[] {
  const kf = [{ timeUs: 0, gainCentiDb: -1800 }];
  for (let k = 0; k < stretches; k++) {
    const t = (k * period + 1) * U;
    kf.push({ timeUs: t, gainCentiDb: -1800 }, { timeUs: t + 200_000, gainCentiDb: -3000 }, { timeUs: t + 1_400_000, gainCentiDb: -3000 }, { timeUs: t + 2_000_000, gainCentiDb: -1800 });
  }
  return kf;
}

/** Reference: linear interpolation in dB between keyframes, like the engine's envelope. */
function ref(kf: ReturnType<typeof envelope>, tUs: number): number {
  if (tUs < kf[0]!.timeUs) return 0;
  for (let i = 0; i + 1 < kf.length; i++) {
    const a = kf[i]!;
    const b = kf[i + 1]!;
    if (tUs >= a.timeUs && tUs < b.timeUs) return a.gainCentiDb + ((b.gainCentiDb - a.gainCentiDb) * (tUs - a.timeUs)) / (b.timeUs - a.timeUs);
  }
  return kf[kf.length - 1]!.gainCentiDb;
}

/** Let ffmpeg itself evaluate the expression: aevalsrc outputs the value as audio samples (float32). The graph goes through a script file, like in the renderer
 *  (a command-line argument is limited to 128 KB, and a long envelope is longer than that). */
function evalWithFfmpeg(expr: string, seconds: number, rate: number): Float32Array {
  const script = join(mkdtempSync(join(tmpdir(), "musicexpr-")), "graph.txt");
  writeFileSync(script, `aevalsrc=exprs='${expr}':sample_rate=${rate}:duration=${seconds}[out]\n`);
  const r = spawnSync("ffmpeg", ["-v", "error", "-filter_complex_script", script, "-map", "[out]", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString().slice(-300)}`);
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
}

describe("musicGainExpr", () => {
  for (const stretches of [3, 60, 700]) {
    it(`${stretches} speech stretches (${stretches * 4 + 1} keyframes): ffmpeg accepts it and its value equals the envelope (within 0.05 dB) at every probe`, () => {
      const kf = envelope(stretches);
      const rate = 100; // one value per 10 ms
      const seconds = Math.min(60, stretches * 4 + 1);
      const values = evalWithFfmpeg(musicGainExpr(kf), seconds, rate);
      expect(values.length).toBe(seconds * rate);
      let worst = 0;
      for (let i = 0; i < values.length; i += 7) {
        const tUs = (i / rate) * U;
        const expectedDb = ref(kf, tUs) / 100;
        const measuredDb = 20 * Math.log10(values[i]!);
        worst = Math.max(worst, Math.abs(measuredDb - expectedDb));
      }
      expect(worst).toBeLessThan(0.05);
    }, 60_000);
  }

  it("also for the last part of a long envelope (a probe window far from the start, 2,801 keyframes)", () => {
    const kf = envelope(700);
    const expr = musicGainExpr(kf);
    // evaluate near the end only: shift the clock by building a copy of the envelope that starts 2,700 s later is not needed, ffmpeg can seek in t
    const v = evalWithFfmpeg(expr.replaceAll("(t", "(t+2790").replaceAll(",t,", ",t+2790,"), 8, 100);
    for (let i = 0; i < v.length; i += 5) expect(Math.abs(20 * Math.log10(v[i]!) - ref(kf, (2790 + i / 100) * U) / 100)).toBeLessThan(0.05);
  }, 60_000);
});
