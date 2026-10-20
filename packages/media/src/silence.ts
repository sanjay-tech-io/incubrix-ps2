import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probe } from "./probe.ts";
import { secondsToUs, usToSecondsText } from "./time.ts";

const run = promisify(execFile);

export interface Interval {
  startUs: number;
  endUs: number;
}

export function parseSilenceDetect(log: string, durationUs: number): Interval[] {
  const out: Interval[] = [];
  let open: number | null = null;
  for (const line of log.split("\n")) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, secondsToUs(s[1]!));
    else if (e && open !== null) {
      out.push({ startUs: open, endUs: Math.min(durationUs, secondsToUs(e[1]!)) });
      open = null;
    }
  }
  // Why: ffmpeg prints no silence_end when the file finishes inside a silence.
  if (open !== null) out.push({ startUs: open, endUs: durationUs });
  return out;
}

/**
 * Silences measured on the AUDIO signal. Whisper word times are not a reliable source for pauses
 * (it stretches words into them), so cut/pad decisions must use these intervals.
 */
export async function detectSilence(file: string, opts: { noiseDb?: number; minDurationUs?: number } = {}): Promise<Interval[]> {
  const p = await probe(file);
  if (!p.hasAudio) throw new Error(`no audio stream in ${file}: cannot detect silence`);
  const noise = opts.noiseDb ?? -35;
  const d = usToSecondsText(opts.minDurationUs ?? 300_000);
  let stderr: string;
  try {
    ({ stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", `silencedetect=noise=${noise}dB:d=${d}`, "-f", "null", "-"], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    throw new Error(`ffmpeg silencedetect failed for ${file}: ${(e as Error).message}`);
  }
  return parseSilenceDetect(stderr, p.durationUs);
}
