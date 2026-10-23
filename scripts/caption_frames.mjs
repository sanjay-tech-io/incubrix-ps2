// Finds the frames of a rendered video that show a caption of one known colour in the bottom band, so a test can say
// "the caption is on screen from frame X to frame Y" instead of someone looking at a still.
// Usage: node scripts/caption_frames.mjs <video.mp4> [r,g,b = 255,0,0] [minPixels = 25]
// Method: ffmpeg decodes the bottom 30% of every frame at 480x146 RGB; a frame counts when at least minPixels pixels are
// within 70 of the colour on every channel. Only reliable for a colour that is rare in the picture (red); not a general OCR.
import { spawn, spawnSync } from "node:child_process";

const [, , file, rgbArg = "255,0,0", minArg = "25"] = process.argv;
if (!file) { console.error("usage: node scripts/caption_frames.mjs <video> [r,g,b] [minPixels]"); process.exit(2); }
const [R, G, B] = rgbArg.split(",").map(Number);
const minPixels = Number(minArg);
const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", file], { encoding: "utf8" });
const [num, den] = probe.stdout.trim().split("/").map(Number);
const W = 480, H = 146, FRAME = W * H * 3;
const ff = spawn("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=iw:ih*0.3:0:ih*0.7,scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
let buf = Buffer.alloc(0), n = 0;
const hit = [];
ff.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= FRAME) {
    let c = 0;
    for (let i = 0; i < FRAME; i += 3) if (Math.abs(buf[i] - R) < 70 && Math.abs(buf[i + 1] - G) < 70 && Math.abs(buf[i + 2] - B) < 70) c++;
    if (c >= minPixels) hit.push(n);
    n++;
    buf = buf.subarray(FRAME);
  }
});
ff.on("close", () => {
  const runs = [];
  for (const f of hit) { const last = runs[runs.length - 1]; if (last && f === last[1] + 1) last[1] = f; else runs.push([f, f]); }
  const t = (f) => +(f * den / num).toFixed(3);
  console.log(JSON.stringify({ file, frames: n, fps: `${num}/${den}`, colour: [R, G, B], runs: runs.map(([a, b]) => ({ first_frame: a, last_frame: b, start_s: t(a), end_s: t(b + 1) })) }));
});
