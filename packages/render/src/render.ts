import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timelineHash, timelinePieces, type EngineContext, type Timeline } from "@incubrix/engine";
import { buildRenderGraph, type RenderGraph } from "./graph.ts";
import { ffmpegVersion, peakRssMb, probeOutput, runFfmpeg, type OutputFacts } from "./ffmpeg.ts";

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
  /** Container time in videoFile / audioFile of atom time 0 (0 for a CFR proxy, which is on the atom clock). */
  videoBaseUs?: number;
  audioBaseUs?: number;
  /** Single-group mode only: video start - audio start of the original. */
  videoOffsetUs?: number;
  /** Pieces per seeked input pair; 0 = one group over the whole file. Default RENDER_GROUP_PIECES. */
  groupPieces?: number;
  groupMaxSpanUs?: number;
  maxGroups?: number;
  out: string;
  workDir: string;
  settings: RenderSettings;
  fonts?: { regular: string; bold: string };
  onProgress?: (percent: number) => void;
}

/** Pieces per seeked input pair (see RenderGraphInput.groupPieces). Chosen from docs/raw/m3_bench_*: the cost per piece stops growing around here. */
export const DEFAULT_GROUP_PIECES = 30;

export const DEFAULT_MAX_GROUPS = 64;

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
  graph: Pick<RenderGraph, "frames" | "samples" | "pieces" | "groups" | "outWidth" | "outHeight" | "warnings">;
  graphScriptSha256: string;
  ffmpeg: string;
  args: string[];
  elapsedMs: number;
  /** Peak resident memory of the ffmpeg process in MB (polled every 200 ms; null if /proc is unreadable). */
  peakRssMb: number | null;
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
  // Memory grows with the number of OPEN input pairs (about 125 MB per pair at 1080p, measured), so the group size is raised
  // when a timeline has so many pieces that the default size would open more than maxGroups pairs.
  const pieceCount = timelinePieces(r.ctx, r.tl).length;
  const groupPieces = Math.max(r.groupPieces ?? DEFAULT_GROUP_PIECES, Math.ceil(pieceCount / (r.maxGroups ?? DEFAULT_MAX_GROUPS)));
  const graph = buildRenderGraph({
    ctx: r.ctx, tl: r.tl, videoBaseUs: r.videoBaseUs ?? 0, audioBaseUs: r.audioBaseUs ?? 0, videoOffsetUs: r.videoOffsetUs ?? 0,
    groupPieces: (r.videoOffsetUs ?? 0) !== 0 ? 0 : groupPieces, groupMaxSpanUs: r.groupMaxSpanUs ?? 30_000_000,
    audioChannels: r.audioChannels, hasMusic: r.musicFile !== null, width: r.width, height: r.height, maxHeight: r.settings.maxHeight,
    workDir: r.workDir, fonts: r.fonts ?? DEFAULT_FONTS,
  });
  for (const f of graph.files) writeFileSync(join(r.workDir, f.name), f.content);
  const scriptPath = join(r.workDir, "graph.ffscript");
  writeFileSync(scriptPath, graph.script);

  const inputs: string[] = [];
  for (const i of graph.inputs) {
    if (i.seekUs !== null && i.seekUs > 0) inputs.push("-ss", (i.seekUs / 1e6).toFixed(6));
    if (i.durationUs !== null) inputs.push("-t", (i.durationUs / 1e6).toFixed(6));
    if (i.role === "music") inputs.push("-stream_loop", "-1");
    inputs.push("-i", i.role === "video" ? r.videoFile : i.role === "audio" ? r.audioFile : r.musicFile!);
  }
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
  let peak: number | null = null;
  let timer: NodeJS.Timeout | undefined;
  await runFfmpeg(args, {
    ...(r.onProgress ? { onProgress: (us: number) => r.onProgress!(Math.min(99, (us / total) * 100)) } : {}),
    onSpawn: (pid) => {
      timer = setInterval(() => {
        const m = peakRssMb(pid);
        if (m !== null) peak = Math.max(peak ?? 0, m);
      }, 200);
    },
  }).finally(() => clearInterval(timer));
  const elapsedMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
  const output = await probeOutput(r.out);
  return {
    graph: { frames: graph.frames, samples: graph.samples, pieces: graph.pieces, groups: graph.groups, outWidth: graph.outWidth, outHeight: graph.outHeight, warnings: graph.warnings },
    graphScriptSha256: createHash("sha256").update(graph.script).digest("hex"),
    ffmpeg: await ffmpegVersion(),
    args,
    elapsedMs,
    peakRssMb: peak === null ? null : Math.round(peak),
    output,
    verification: verifyOutput(output, graph.frames, fps),
    timelineHash: timelineHash(r.tl),
  };
}
