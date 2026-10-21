// npm run bench -w @incubrix/render : how does ONE filter graph scale with the number of pieces? Real runs, written to docs/raw.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentTimeline, newSession } from "@incubrix/engine";
import { renderTimeline } from "../src/index.ts";
import { manyCuts } from "./many.ts";
import { makeSyncClip } from "./syncclip.ts";
import { tmp } from "./helpers.ts";

const size = process.env.BENCH_SIZE ?? "1920x1080";
const seconds = Number(process.env.BENCH_SECONDS ?? 120);
const [w, h] = size.split("x").map(Number) as [number, number];
const clip = await makeSyncClip({ fps: { num: 30, den: 1 }, seconds, size });
const rows: unknown[] = [];
for (const perSecond of (process.env.BENCH_LEVELS ?? "0,1,2,3").split(",").map(Number)) {
  const tl = perSecond === 0 ? currentTimeline(clip.ctx, newSession()) : manyCuts(clip, seconds, perSecond).timeline;
  const dir = tmp("bench");
  const r = await renderTimeline({ ctx: clip.ctx, tl, videoFile: clip.file, audioFile: clip.file, musicFile: null, width: w, height: h, audioChannels: 1, videoOffsetUs: 0, out: join(dir, "o.mp4"), workDir: dir, groupPieces: Number(process.env.BENCH_GROUP ?? 30), settings: { preset: process.env.RENDER_PRESET ?? "veryfast", crf: 20, maxHeight: 0 } });
  const outMin = tl.durationUs / 60e6;
  const row = {
    size, source_seconds: seconds, pieces: r.graph.pieces, groups: r.graph.groups, group_pieces: Number(process.env.BENCH_GROUP ?? 30), output_seconds: Number((tl.durationUs / 1e6).toFixed(1)), render_s: Number((r.elapsedMs / 1000).toFixed(1)),
    render_s_per_output_minute: Number((r.elapsedMs / 1000 / outMin).toFixed(1)), ffmpeg_peak_rss_mb: r.peakRssMb, graph_script_kb: null, frames_ok: r.verification.ok, ffmpeg: r.ffmpeg.split(" ").slice(0, 3).join(" "),
  };
  console.log(JSON.stringify(row));
  rows.push(row);
}
writeFileSync(process.env.BENCH_OUT ?? "bench_render.json", JSON.stringify(rows, null, 2));
