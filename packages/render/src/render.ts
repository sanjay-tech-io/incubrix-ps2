import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timelineHash, type EngineContext, type Timeline } from "@incubrix/engine";
import { buildRenderGraph, type RenderGraph } from "./graph.ts";
import { ffmpegVersion, probeOutput, runFfmpeg, type OutputFacts } from "./ffmpeg.ts";

/** A render failure with an API error code (see packages/errors). */
export class RenderError extends Error {
  constructor(readonly code: "NO_AUDIO_TRACK" | "RENDER_FAILED" | "RENDER_VERIFY_FAILED" | "SOURCE_CHANGED", message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface RenderSettings {
  preset: string;
  crf: number;
  maxHeight: number;
}

export interface RenderRequest {
  ctx: EngineContext;
  tl: Timeline;
  /** File the video is decoded from: the original, or the CFR proxy. */
  videoFile: string;
  /** Always the original (the audio is never taken from the proxy). */
  audioFile: string;
  musicFile: string | null;
  width: number;
  height: number;
  audioChannels: number;
  /** 0 when videoFile is a proxy (it is already on the atom clock). */
  videoOffsetUs: number;
  out: string;
  workDir: string;
  settings: RenderSettings;
  fonts?: { regular: string; bold: string };
  onProgress?: (percent: number) => void;
}

export const DEFAULT_FONTS = {
  regular: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  bold: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
};

export interface Verification {
  ok: boolean;
  timelineFrames: number;
  renderedFrames: number;
  frameDifference: number;
  audioVsVideoUs: number;
  audioVsVideoFrames: number;
  problems: string[];
}

export interface RenderResult {
  graph: Pick<RenderGraph, "frames" | "samples" | "pieces" | "outWidth" | "outHeight" | "warnings">;
  graphScriptSha256: string;
  ffmpeg: string;
  args: string[];
  elapsedMs: number;
  output: OutputFacts;
  verification: Verification;
  timelineHash: string;
}

/** Check the file against the timeline: frame count exact, audio within one frame of the video. */
export function verifyOutput(o: OutputFacts, frames: number, fps: { num: number; den: number }): Verification {
  const frameUs = (1_000_000 * fps.den) / fps.num;
  const problems: string[] = [];
  const frameDifference = o.videoFrames - frames;
  if (frameDifference !== 0) problems.push(`video has ${o.videoFrames} frames, the timeline has ${frames}`);
  const audioVsVideoUs = o.audioDurationUs - o.videoDurationUs;
  const audioVsVideoFrames = audioVsVideoUs / frameUs;
  if (Math.abs(audioVsVideoFrames) > 1) problems.push(`audio is ${audioVsVideoFrames.toFixed(2)} frames away from the video length`);
  return { ok: problems.length === 0, timelineFrames: frames, renderedFrames: o.videoFrames, frameDifference, audioVsVideoUs, audioVsVideoFrames, problems };
}

import { createHash } from "node:crypto";

/** One ffmpeg run for the whole timeline (see docs/RENDER_DESIGN.md), then ffprobe on the result. */
export async function renderTimeline(r: RenderRequest): Promise<RenderResult> {
  const fps = r.ctx.fps;
  if (!fps) throw new Error("source has no frame rate");
  if (!r.ctx.source.hasAudio) throw new RenderError("NO_AUDIO_TRACK", "the source has no audio track, so there is nothing to keep in sync; it cannot be rendered");
  mkdirSync(r.workDir, { recursive: true });
  const graph = buildRenderGraph({
    ctx: r.ctx, tl: r.tl, videoIndex: 0, audioIndex: r.videoFile === r.audioFile ? 0 : 1,
    musicIndex: r.musicFile ? (r.videoFile === r.audioFile ? 1 : 2) : null,
    videoOffsetUs: r.videoOffsetUs, audioChannels: r.audioChannels, width: r.width, height: r.height, maxHeight: r.settings.maxHeight,
    workDir: r.workDir, fonts: r.fonts ?? DEFAULT_FONTS,
  });
  for (const f of graph.files) writeFileSync(join(r.workDir, f.name), f.content);
  const scriptPath = join(r.workDir, "graph.ffscript");
  writeFileSync(scriptPath, graph.script);

  const inputs = ["-i", r.videoFile];
  if (r.videoFile !== r.audioFile) inputs.push("-i", r.audioFile);
  if (r.musicFile) inputs.push("-stream_loop", "-1", "-i", r.musicFile);
  const fpsText = `${fps.num}/${fps.den}`;
  const args = [
    ...inputs,
    "-filter_complex_script", scriptPath,
    "-map", `[${graph.labels.video}]`, "-map", `[${graph.labels.audio}]`,
    "-c:v", "libx264", "-preset", r.settings.preset, "-crf", String(r.settings.crf), "-pix_fmt", "yuv420p",
    "-r", fpsText, "-fps_mode", "cfr",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart", r.out,
  ];
  const total = graph.frames * (1_000_000 * fps.den) / fps.num;
  const t0 = process.hrtime.bigint();
  await runFfmpeg(args, r.onProgress ? { onProgress: (us) => r.onProgress!(Math.min(99, (us / total) * 100)) } : {});
  const elapsedMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
  const output = await probeOutput(r.out);
  return {
    graph: { frames: graph.frames, samples: graph.samples, pieces: graph.pieces, outWidth: graph.outWidth, outHeight: graph.outHeight, warnings: graph.warnings },
    graphScriptSha256: createHash("sha256").update(graph.script).digest("hex"),
    ffmpeg: await ffmpegVersion(),
    args,
    elapsedMs,
    output,
    verification: verifyOutput(output, graph.frames, fps),
    timelineHash: timelineHash(r.tl),
  };
}
