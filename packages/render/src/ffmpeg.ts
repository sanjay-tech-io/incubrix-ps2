import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class FfmpegError extends Error {
  constructor(message: string, readonly stderrTail: string, readonly exitCode: number | null) {
    super(message);
  }
}

export async function ffmpegVersion(): Promise<string> {
  const { stdout } = await exec("ffmpeg", ["-version"]);
  return stdout.split("\n")[0]!.trim();
}

/**
 * Run ffmpeg with `-progress pipe:1`. `onProgress` gets the output position in microseconds as ffmpeg writes it.
 * stderr is kept (last 4 KB) so a failure says WHY, not just "exit 1".
 */
export function runFfmpeg(args: string[], o: { onProgress?: (outTimeUs: number) => void; signal?: AbortSignal } = {}): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(o.signal ? { signal: o.signal } : {}),
    });
    let stderr = "";
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        const m = /^out_time_us=(\d+)/.exec(l);
        if (m) o.onProgress?.(Number(m[1]));
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4096);
    });
    child.on("error", (e) => reject(new FfmpegError(`could not start ffmpeg: ${e.message}`, stderr, null)));
    child.on("close", (code) => (code === 0 ? resolve({ stderr }) : reject(new FfmpegError(`ffmpeg exited with code ${code}`, stderr, code))));
  });
}

export interface OutputFacts {
  videoFrames: number;
  fps: string;
  videoDurationUs: number;
  audioDurationUs: number;
  formatDurationUs: number;
  pixFmt: string;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
}

/** Decode-count the frames of a finished file (ffprobe -count_frames): the number that matters is what is really in the file. */
export async function probeOutput(file: string): Promise<OutputFacts> {
  const { stdout } = await exec(
    "ffprobe",
    ["-v", "error", "-count_frames", "-print_format", "json", "-show_entries", "stream=codec_type,codec_name,nb_read_frames,r_frame_rate,pix_fmt,width,height,duration:format=duration", file],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const j = JSON.parse(stdout) as { streams: Record<string, string | number>[]; format: { duration: string } };
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error("rendered file has no video stream");
  const us = (x: unknown): number => Math.round(Number(x) * 1_000_000);
  return {
    videoFrames: Number(v.nb_read_frames),
    fps: String(v.r_frame_rate),
    videoDurationUs: us(v.duration),
    audioDurationUs: a ? us(a.duration) : 0,
    formatDurationUs: us(j.format.duration),
    pixFmt: String(v.pix_fmt),
    width: Number(v.width),
    height: Number(v.height),
    videoCodec: String(v.codec_name),
    audioCodec: a ? String(a.codec_name) : "",
  };
}

export interface StreamFacts {
  codec: string;
  pixFmt: string;
  colorTransfer: string;
  colorPrimaries: string;
  colorSpace: string;
  bitsPerRawSample: number | null;
  width: number;
  height: number;
  videoStartUs: number;
  audioStartUs: number;
  hasAudio: boolean;
  hasVideo: boolean;
  audioChannels: number;
}

/** Facts the renderer needs about an input: pixel format/colour (for the proxy) and stream start times (for sync). */
export async function probeStreams(file: string): Promise<StreamFacts> {
  const { stdout } = await exec(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_entries", "stream=codec_type,codec_name,pix_fmt,color_transfer,color_primaries,color_space,bits_per_raw_sample,width,height,start_time,channels", file],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const j = JSON.parse(stdout) as { streams: Record<string, string | number>[] };
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  const us = (x: unknown): number => (x === undefined || x === "N/A" ? 0 : Math.round(Number(x) * 1_000_000));
  const bits = v?.bits_per_raw_sample;
  return {
    codec: String(v?.codec_name ?? ""),
    pixFmt: String(v?.pix_fmt ?? ""),
    colorTransfer: String(v?.color_transfer ?? "unknown"),
    colorPrimaries: String(v?.color_primaries ?? "unknown"),
    colorSpace: String(v?.color_space ?? "unknown"),
    bitsPerRawSample: bits === undefined || bits === "N/A" ? null : Number(bits),
    width: Number(v?.width ?? 0),
    height: Number(v?.height ?? 0),
    videoStartUs: us(v?.start_time),
    audioStartUs: us(a?.start_time),
    hasAudio: !!a,
    hasVideo: !!v,
    audioChannels: Number(a?.channels ?? 0),
  };
}
