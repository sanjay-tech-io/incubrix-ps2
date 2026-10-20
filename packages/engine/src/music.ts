import type { EngineContext } from "./context";
import { atomOutSpan, timelinePieces, type OutSpan } from "./timemap";
import type { Micros, MusicParams, Timeline } from "./types";

/**
 * Background music is a timeline track (set_music: asset by sha256, gain, duck settings). The renderer needs to
 * know WHEN to lower it, so this pure code turns the final speech into a gain envelope.
 */

/** Where someone is speaking in the OUTPUT, in output order. Gaps of at most `mergeGapUs` are bridged into one segment. */
export function speechSegments(ctx: EngineContext, tl: Timeline, mergeGapUs = 0): OutSpan[] {
  const pieces = timelinePieces(ctx, tl);
  const atoms = ctx.index.atoms;
  const out: OutSpan[] = [];
  for (const p of pieces) {
    let lo = 0;
    let hi = atoms.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (atoms[mid]!.endUs > p.srcS) hi = mid;
      else lo = mid + 1;
    }
    for (let i = lo; i < atoms.length && atoms[i]!.startUs < p.srcE; i++) {
      const a = atoms[i]!;
      if (a.kind !== "word") continue;
      const o = atomOutSpan(pieces, a);
      if (!o) continue;
      const last = out[out.length - 1];
      if (last && o.startUs - last.endUs <= mergeGapUs) last.endUs = Math.max(last.endUs, o.endUs);
      else out.push({ startUs: o.startUs, endUs: o.endUs });
    }
  }
  return out;
}

export interface GainKeyframe {
  /** Output time. */
  timeUs: Micros;
  /** Music gain from this moment, in centi-dB (hundredths of a dB); linear ramp to the next keyframe. */
  gainCentiDb: number;
}

/**
 * Ducking envelope: keyframes of music gain over the output.
 *  - base gain = music.gainCentiDb; ducked gain = base - music.duckCentiDb;
 *  - the music is fully ducked when speech STARTS (it begins falling attackUs earlier) and starts rising when
 *    speech ENDS, back to base after releaseUs;
 *  - speech separated by less than attackUs + releaseUs keeps the music ducked in between (it could not
 *    recover), so such speech is treated as one segment;
 *  - times are clamped to [0, duration]; keyframe times strictly increase; the first is at 0, the last at the end.
 * Pure integer arithmetic; a sped-up or reordered timeline is handled because speech is read from the final output.
 */
export function duckingEnvelope(ctx: EngineContext, tl: Timeline, music: MusicParams): GainKeyframe[] {
  const base = music.gainCentiDb;
  const low = base - music.duckCentiDb;
  const speech = speechSegments(ctx, tl, music.attackUs + music.releaseUs);
  const frames: GainKeyframe[] = [{ timeUs: 0, gainCentiDb: base }];
  // A keyframe at the same time as the previous one is dropped, except where noted: the ducked value at the moment
  // speech starts wins over the "still at base" keyframe before it, and a release clamped to the end of the video
  // must not undo the ducked value that speech running to the end has.
  const put = (timeUs: Micros, gainCentiDb: number, overwrite = false): void => {
    const t = Math.min(tl.durationUs, Math.max(0, timeUs));
    const last = frames[frames.length - 1]!;
    if (t === last.timeUs) {
      if (overwrite) frames[frames.length - 1] = { timeUs: t, gainCentiDb };
    } else if (t > last.timeUs) frames.push({ timeUs: t, gainCentiDb });
  };
  for (const seg of speech) {
    put(seg.startUs - music.attackUs, base);
    put(seg.startUs, low, true);
    put(seg.endUs, low);
    put(seg.endUs + music.releaseUs, base);
  }
  const last = frames[frames.length - 1]!;
  if (last.timeUs < tl.durationUs) frames.push({ timeUs: tl.durationUs, gainCentiDb: last.gainCentiDb });
  return frames;
}
