import type { Interval } from "./silence.ts";

/**
 * "Untranscribed voiced gaps": stretches inside a GAP between ASR words where the audio is clearly not quiet, so
 * something was said or made (an "um" Whisper dropped, a breath, a laugh, a cough, background noise) but no word covers it.
 * They are possible fillers, nothing more: a heuristic over short-time energy cannot tell an "um" from a breath, so every
 * marker carries a LOW confidence and the features it was judged by, and callers must ask before cutting one.
 * Pure: the same samples and intervals always give the same markers.
 */
export interface VoicedGap {
  startUs: number;
  endUs: number;
  /** Mean level of the stretch relative to the median level of the transcribed speech, in dB (0 = as loud as speech). */
  levelDb: number;
  /** Zero-crossing rate (crossings per sample): low = periodic/voiced, high = noise-like (breath). */
  zcr: number;
  /** The stretch begins or ends within 40 ms of a gap edge: it may be the tail of a neighbouring word. */
  touchesWord: boolean;
  confidencePermille: number;
}

export interface VoicedGapResult {
  markers: VoicedGap[];
  /** Voiced stretches longer than the maximum (music, laughter, long noise): counted, never offered as fillers. */
  tooLong: number;
  stats: { speechDb: number; floorDb: number; thresholdDb: number; frames: number };
}

export const VOICED_DEFAULTS = { minUs: 150_000, maxUs: 1_200_000, frameMs: 20, holeMs: 60, aboveFloorDb: 12, minRelDb: -30 };

const db = (rms: number): number => 20 * Math.log10(Math.max(rms, 1e-6));

export function findVoicedGaps(o: {
  samples: Float32Array;
  sampleRate: number;
  /** ASR words (after clamping), in microseconds. */
  words: readonly Interval[];
  /** The gap atoms between words (leading and trailing silence included). */
  gaps: readonly Interval[];
  minUs?: number;
  maxUs?: number;
}): VoicedGapResult {
  const cfg = { ...VOICED_DEFAULTS, minUs: o.minUs ?? VOICED_DEFAULTS.minUs, maxUs: o.maxUs ?? VOICED_DEFAULTS.maxUs };
  const hop = Math.round((o.sampleRate * cfg.frameMs) / 1000);
  const frames = Math.floor(o.samples.length / hop);
  const energy = new Float64Array(frames);
  const zc = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    let z = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const v = o.samples[i]!;
      s += v * v;
      if (i > 0 && o.samples[i - 1]! < 0 !== v < 0) z++;
    }
    energy[f] = db(Math.sqrt(s / hop));
    zc[f] = z / hop;
  }
  const frameOf = (us: number): number => Math.min(frames, Math.max(0, Math.round((us / 1e6) * (o.sampleRate / hop))));
  const median = (xs: number[]): number => (xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!);

  const inWords: number[] = [];
  for (const w of o.words) for (let f = frameOf(w.startUs); f < frameOf(w.endUs); f++) inWords.push(energy[f]!);
  const speechDb = Number.isNaN(median(inWords)) ? -20 : median(inWords);
  const inGaps: number[] = [];
  for (const g of o.gaps) for (let f = frameOf(g.startUs); f < frameOf(g.endUs); f++) inGaps.push(energy[f]!);
  // floor = the quiet end of the gaps (20th percentile), so a gap that is mostly noise does not raise the bar
  const sortedGaps = [...inGaps].sort((a, b) => a - b);
  const floorDb = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length * 0.2)]! : -70;
  const thresholdDb = Math.max(floorDb + cfg.aboveFloorDb, speechDb + cfg.minRelDb);

  const markers: VoicedGap[] = [];
  let tooLong = 0;
  const holes = Math.round(cfg.holeMs / cfg.frameMs);
  const frameUs = (cfg.frameMs * 1000);
  for (const g of o.gaps) {
    const a = frameOf(g.startUs);
    const b = frameOf(g.endUs);
    let f = a;
    while (f < b) {
      if (energy[f]! <= thresholdDb) {
        f++;
        continue;
      }
      let end = f + 1;
      let quiet = 0;
      for (let k = f + 1; k < b; k++) {
        if (energy[k]! > thresholdDb) {
          end = k + 1;
          quiet = 0;
        } else if (++quiet > holes) break;
      }
      const startUs = f * frameUs;
      const endUs = end * frameUs;
      const len = endUs - startUs;
      if (len > cfg.maxUs) tooLong++;
      else if (len >= cfg.minUs) {
        let sum = 0;
        let zsum = 0;
        for (let k = f; k < end; k++) {
          sum += energy[k]!;
          zsum += zc[k]!;
        }
        const levelDb = sum / (end - f) - speechDb;
        const zcr = zsum / (end - f);
        const touchesWord = startUs - g.startUs < 40_000 || g.endUs - endUs < 40_000;
        // Confidence is deliberately low and only orders markers: 300 base; +150 when about as loud as speech and periodic
        // (um/uh are voiced); -100 when it touches a word edge (a word's tail); -150 when much quieter than speech or noise-like.
        let c = 300;
        if (levelDb >= -12 && zcr < 0.12) c += 150;
        if (touchesWord) c -= 100;
        if (levelDb < -20 || zcr >= 0.25) c -= 150;
        markers.push({ startUs, endUs, levelDb: Math.round(levelDb * 10) / 10, zcr: Math.round(zcr * 1000) / 1000, touchesWord, confidencePermille: Math.max(50, Math.min(600, c)) });
      }
      f = end;
    }
  }
  return { markers, tooLong, stats: { speechDb: Math.round(speechDb * 10) / 10, floorDb: Math.round(floorDb * 10) / 10, thresholdDb: Math.round(thresholdDb * 10) / 10, frames } };
}

/** Samples of a 16-bit mono PCM WAV (what intake writes for the ASR): finds the `fmt ` and `data` chunks, does not assume 44 bytes. */
export function readWavPcm16(buf: Uint8Array): { sampleRate: number; samples: Float32Array } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(...buf.subarray(0, 4)) !== "RIFF") throw new Error("not a WAV file");
  let pos = 12;
  let rate = 0;
  let channels = 1;
  while (pos + 8 <= buf.length) {
    const id = String.fromCharCode(...buf.subarray(pos, pos + 4));
    const size = v.getUint32(pos + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(pos + 10, true);
      rate = v.getUint32(pos + 12, true);
      if (v.getUint16(pos + 22, true) !== 16) throw new Error("only 16-bit PCM WAV is supported");
    } else if (id === "data") {
      const n = Math.floor(Math.min(size, buf.length - pos - 8) / 2 / channels);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(pos + 8 + i * 2 * channels, true) / 32768;
      return { sampleRate: rate, samples: out };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}
