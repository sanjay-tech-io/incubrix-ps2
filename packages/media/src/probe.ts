import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Fraction, parseFraction, secondsToUs } from "./time.ts";

const run = promisify(execFile);

export interface VideoInfo {
  width: number;
  height: number;
  /** Nominal rate (ffprobe r_frame_rate) as an exact fraction. For VFR this is the base rate only. */
  fps: Fraction;
  /** Average rate (avg_frame_rate) when ffprobe knows it. */
  avgFps: Fraction | null;
  isVfr: boolean;
}
export interface AudioInfo {
  sampleRate: number;
  channels: number;
}
export interface ProbeResult {
  durationUs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  video: VideoInfo | null;
  audio: AudioInfo | null;
}

/**
 * Variable frame rate from presentation timestamps (microseconds, any order).
 * Why not just compare avg_frame_rate and r_frame_rate: ffprobe often reports them equal for
 * files with dropped frames. Spacing is what matters: any gap that is not within 50% of the
 * median spacing means the frame times do not sit on a fixed grid.
 */
export function detectVfr(ptsUs: readonly number[]): boolean {
  if (ptsUs.length < 3) return false;
  const sorted = [...ptsUs].sort((a, b) => a - b);
  const deltas = sorted.slice(1).map((t, i) => t - sorted[i]!);
  const median = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)]!;
  if (median <= 0) return false;
  return deltas.some((d) => Math.abs(d - median) > median * 0.5);
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

async function ffprobe(args: string[], file: string): Promise<string> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", ...args, file], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    throw new Error(`ffprobe failed for ${file}: ${(e as { stderr?: string }).stderr?.trim() || (e as Error).message}`);
  }
}

/** `vfrWindowUs`: how much of the start of the file to scan for the VFR check (keeps long files fast). */
export async function probe(file: string, opts: { vfrWindowUs?: number } = {}): Promise<ProbeResult> {
  const info = JSON.parse(await ffprobe(["-print_format", "json", "-show_format", "-show_streams"], file)) as {
    format?: { duration?: string };
    streams?: FfprobeStream[];
  };
  const streams = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  if (!v && !a) throw new Error(`ffprobe found no audio or video stream in ${file}`);
  if (!info.format?.duration) throw new Error(`ffprobe reported no duration for ${file}`);

  let video: VideoInfo | null = null;
  if (v) {
    const window = Math.round((opts.vfrWindowUs ?? 120_000_000) / 1_000_000);
    const pts = (await ffprobe(["-select_streams", "v:0", "-read_intervals", `%+${window}`, "-show_entries", "packet=pts_time", "-of", "csv=p=0"], file))
      .split("\n")
      .filter((l) => /^-?\d/.test(l))
      .map((l) => secondsToUs(l.split(",")[0]!));
    let avgFps: Fraction | null = null;
    try {
      avgFps = parseFraction(v.avg_frame_rate ?? "0/0");
    } catch {
      /* ffprobe reports 0/0 when unknown */
    }
    video = { width: v.width ?? 0, height: v.height ?? 0, fps: parseFraction(v.r_frame_rate ?? "0/0"), avgFps, isVfr: detectVfr(pts) };
  }
  return {
    durationUs: secondsToUs(info.format.duration),
    hasVideo: !!v,
    hasAudio: !!a,
    video,
    audio: a ? { sampleRate: Number(a.sample_rate), channels: a.channels ?? 0 } : null,
  };
}
