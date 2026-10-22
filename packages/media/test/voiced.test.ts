import { describe, expect, it } from "vitest";
import { findVoicedGaps, readWavPcm16 } from "../src/index.ts";

const RATE = 16000;
const US = 1_000_000;

/** A signal built from segments: [startS, endS, kind]. speech = 150 Hz + harmonics at 0.3; voiced = 200 Hz tone at 0.25; breath = noise at 0.02; room = noise at 0.001. */
function make(seconds: number, segs: [number, number, "speech" | "voiced" | "breath"][]): Float32Array {
  const x = new Float32Array(Math.round(seconds * RATE));
  let seed = 12345; // deterministic noise: the test must never be flaky
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < x.length; i++) x[i] = 0.001 * rnd();
  for (const [a, b, k] of segs) {
    for (let i = Math.round(a * RATE); i < Math.min(x.length, Math.round(b * RATE)); i++) {
      const t = i / RATE;
      x[i] = (x[i] ?? 0) + (k === "speech" ? 0.3 * Math.sin(2 * Math.PI * 150 * t) + 0.15 * Math.sin(2 * Math.PI * 300 * t) : k === "voiced" ? 0.25 * Math.sin(2 * Math.PI * 200 * t) : 0.02 * rnd());
    }
  }
  return x;
}

const words = [{ startUs: 0.5 * US, endUs: 1.2 * US }, { startUs: 3.0 * US, endUs: 3.6 * US }, { startUs: 5.0 * US, endUs: 5.5 * US }];
const gaps = [{ startUs: 0, endUs: 0.5 * US }, { startUs: 1.2 * US, endUs: 3.0 * US }, { startUs: 3.6 * US, endUs: 5.0 * US }, { startUs: 5.5 * US, endUs: 8 * US }];

describe("untranscribed voiced gaps (possible fillers Whisper dropped)", () => {
  it("finds a 0.4 s voiced sound inside a gap between words, with its time and a LOW confidence", () => {
    const x = make(8, [[0.5, 1.2, "speech"], [2.0, 2.4, "voiced"], [3.0, 3.6, "speech"], [5.0, 5.5, "speech"]]);
    const r = findVoicedGaps({ samples: x, sampleRate: RATE, words, gaps });
    expect(r.markers).toHaveLength(1);
    const m = r.markers[0]!;
    expect(m.startUs / US).toBeCloseTo(2.0, 1);
    expect(m.endUs / US).toBeCloseTo(2.4, 1);
    expect(m.confidencePermille).toBeLessThanOrEqual(600);
    expect(m.confidencePermille).toBeGreaterThan(0);
  });

  it("ignores a gap that is really silent, and a voiced sound outside the 0.15-1.2 s range", () => {
    const x = make(8, [[0.5, 1.2, "speech"], [2.0, 2.08, "voiced"], [3.0, 3.6, "speech"], [5.0, 5.5, "speech"], [6.0, 8.0, "voiced"]]);
    const r = findVoicedGaps({ samples: x, sampleRate: RATE, words, gaps });
    expect(r.markers).toHaveLength(0); // 0.08 s too short, 2 s too long (that is noise/music/laughter, reported as a count, not cut)
    expect(r.tooLong).toBe(1);
  });

  it("a quiet breath is reported with a lower confidence than a speech-level sound (the caller decides)", () => {
    const x = make(8, [[0.5, 1.2, "speech"], [2.0, 2.4, "voiced"], [3.0, 3.6, "speech"], [4.0, 4.4, "breath"], [5.0, 5.5, "speech"]]);
    const r = findVoicedGaps({ samples: x, sampleRate: RATE, words, gaps });
    const voiced = r.markers.find((m) => m.startUs < 3 * US)!;
    const breath = r.markers.find((m) => m.startUs > 3.6 * US && m.startUs < 5 * US);
    if (breath) expect(breath.confidencePermille).toBeLessThan(voiced.confidencePermille);
    expect(breath?.levelDb ?? -99).toBeLessThan(voiced.levelDb);
  });

  it("is deterministic and reads a 16-bit WAV", () => {
    const x = make(8, [[0.5, 1.2, "speech"], [2.0, 2.4, "voiced"]]);
    const a = findVoicedGaps({ samples: x, sampleRate: RATE, words, gaps });
    const b = findVoicedGaps({ samples: x, sampleRate: RATE, words, gaps });
    expect(b).toEqual(a);
    const pcm = new Int16Array(x.length);
    for (let i = 0; i < x.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, x[i]!)) * 32767);
    const wav = Buffer.alloc(44 + pcm.length * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcm.length * 2, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcm.length * 2, 40);
    Buffer.from(pcm.buffer).copy(wav, 44);
    const w = readWavPcm16(wav);
    expect(w.sampleRate).toBe(RATE);
    expect(w.samples.length).toBe(x.length);
  });
});
