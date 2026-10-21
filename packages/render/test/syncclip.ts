import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, buildAtoms, frameStartUs, sha256Hex, type EngineContext, type Fps } from "@incubrix/engine";
import { probe } from "@incubrix/media";

/**
 * Generated test media (never stored in git): every second a "beep event" - a 2-frame white flash and a 4-frame 1 kHz
 * tone that START ON THE SAME FRAME. A visible frame counter is burned in. After any edit the flash and the tone must
 * still start together; the distance between them is the A/V offset the tests measure.
 */
export const dir = join(tmpdir(), "incubrix-render-clips");
mkdirSync(dir, { recursive: true });
export const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

export interface SyncClip {
  file: string;
  fps: Fps;
  seconds: number;
  /** Frame number of each event (event k is near second k). */
  eventFrames: number[];
  ctx: EngineContext;
}

/** Event k is the word NAMES[k], so instructions can point at one event ("mute delta"). */
export const NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa"];

const fpsName = (f: Fps) => (f.den === 1 ? `${f.num}` : `${f.num}_${f.den}`);

export function eventFrames(fps: Fps, seconds: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < seconds; k++) out.push(k * Math.round(fps.num / fps.den)); // every round(fps) frames: 30 frames at 29.97, so events drift by 1 ms per second
  return out;
}

export interface SyncClipOptions {
  fps: Fps;
  seconds: number;
  audio?: boolean;
  /** Drop ~30% of the NON-event frames at random, keeping the original timestamps (a phone-like VFR file). */
  vfr?: boolean;
  /** Audio track exists but is digital silence (the words still exist in the transcript): lets tests measure music alone. */
  silentAudio?: boolean;
}

export async function makeSyncClip(o: SyncClipOptions): Promise<SyncClip> {
  const { fps, seconds, audio = true, vfr = false, silentAudio = false } = o;
  const file = join(dir, `sync2_${seconds}s_${fpsName(fps)}_${audio ? (silentAudio ? "silent" : "av") : "video"}_${vfr ? "vfr" : "cfr"}.mp4`);
  const events = eventFrames(fps, seconds);
  if (!existsSync(file)) {
    const period = Math.round(fps.num / fps.den);
    const flash = `lt(mod(n,${period}),2)`;
    const rate = `${fps.num}/${fps.den}`;
    const vf = `drawtext=fontfile=${FONT}:text='%{frame_num}':start_number=0:x=10:y=10:fontsize=40:fontcolor=white:box=1:boxcolor=black,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${flash}'`;
    const keep = flash;
    const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=${rate}:duration=${seconds}`];
    if (audio && silentAudio) args.push("-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${seconds}`);
    else if (audio) {
      const wav = file.replace(/\.mp4$/, ".wav");
      writeFileSync(wav, beepWav(events, fps, seconds));
      args.push("-i", wav);
    }
    args.push("-vf", vfr ? `${vf},select='gt(random(1),0.3)+${keep}'` : vf);
    if (vfr) args.push("-fps_mode", "vfr");
    args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-g", "25");
    if (audio) args.push("-c:a", "aac", "-b:a", "128k");
    args.push(file);
    execFileSync("ffmpeg", args);
  }
  const p = await probe(file);
  // atoms: one 4-frame "word" per event, silence everywhere else, so cuts at k+0.5 s are in silence (exact, on the grid)
  const words = events.map((n, k) => ({ text: NAMES[k % NAMES.length]!, startUs: frameStartUs(n, fps), endUs: frameStartUs(n + 4, fps) }));
  const atoms = buildAtoms(sha256Hex(file), p.durationUs, words);
  const ctx = createContext({ sha256: sha256Hex(file), durationUs: p.durationUs, fps, hasAudio: audio, hasVideo: true, variableFrameRate: vfr }, atoms);
  return { file, fps, seconds, eventFrames: events, ctx };
}

/** Mono 48 kHz 16-bit WAV: a 1 kHz tone of 4 frames starting at each event frame (sample-exact, written by arithmetic). */
function beepWav(events: number[], fps: Fps, seconds: number): Buffer {
  const n = 48000 * seconds;
  const pcm = Buffer.alloc(n * 2);
  for (const f of events) {
    const a = Math.round((f * fps.den * 48000) / fps.num);
    const b = Math.min(n, Math.round(((f + 4) * fps.den * 48000) / fps.num));
    for (let i = a; i < b; i++) pcm.writeInt16LE(Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / 48000)), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(48000, 24); h.writeUInt32LE(96000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---- measurement ----

/** Frame numbers (0-based, in the file) where a white flash starts, and the frame count. */
export function flashStarts(file: string): { frames: number; starts: number[] } {
  const w = 32;
  const h = 24;
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-an", "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
  const buf = r.stdout;
  const size = w * h;
  const frames = Math.floor(buf.length / size);
  const starts: number[] = [];
  let prev = false;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += buf[f * size + i]!;
    const flash = sum / size > 200;
    if (flash && !prev) starts.push(f);
    prev = flash;
  }
  return { frames, starts };
}

/** Times (seconds) where a 1 kHz tone starts: first sample above 0.25 after at least 10 ms below 0.05. */
export function beepOnsets(file: string): { seconds: number; onsets: number[] } {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-af", "pan=mono|c0=c0", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
  const x = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
  const onsets: number[] = [];
  let quiet = 480; // the file starts in "silence", so a tone at t=0 counts
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]!);
    if (a < 0.05) quiet++;
    else if (a > 0.25) {
      if (quiet >= 480) onsets.push(i / 48000);
      quiet = 0;
    }
  }
  return { seconds: x.length / 48000, onsets };
}

export interface SyncMeasure {
  videoFrames: number;
  events: number;
  /** Per event: (tone onset - flash start) in frames. */
  offsetsFrames: number[];
  maxAbsOffsetFrames: number;
  unmatched: number;
}

export function measureSync(file: string, fps: Fps): SyncMeasure {
  const v = flashStarts(file);
  const a = beepOnsets(file);
  const frameS = fps.den / fps.num;
  const offsets: number[] = [];
  let unmatched = 0;
  for (const f of v.starts) {
    const t = f * frameS;
    let best: number | null = null;
    for (const o of a.onsets) if (Math.abs(o - t) < 0.25 && (best === null || Math.abs(o - t) < Math.abs(best - t))) best = o;
    if (best === null) unmatched++;
    else offsets.push((best - t) / frameS);
  }
  return { videoFrames: v.frames, events: v.starts.length, offsetsFrames: offsets, maxAbsOffsetFrames: offsets.reduce((m, x) => Math.max(m, Math.abs(x)), 0), unmatched };
}

// ---- raw decoding for feature tests ----

export function decodeAudio(file: string): Float32Array {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-af", "pan=mono|c0=c0", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
  const b = Buffer.from(r.stdout);
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
}

export function rms(x: Float32Array, fromS: number, toS: number): number {
  const a = Math.max(0, Math.round(fromS * 48000));
  const b = Math.min(x.length, Math.round(toS * 48000));
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, b - a));
}

/** Zero-crossing frequency of a stretch of mono audio (Hz). */
export function frequency(x: Float32Array, fromS: number, toS: number): number {
  const a = Math.round(fromS * 48000);
  const b = Math.min(x.length, Math.round(toS * 48000));
  let c = 0;
  for (let i = a + 1; i < b; i++) if (x[i - 1]! < 0 && x[i]! >= 0) c++;
  return c / ((b - a) / 48000);
}

/** One decoded frame as RGB (width*height*3 bytes). */
export function frameRgb(file: string, index: number, w: number, h: number): Buffer {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-an", "-vf", `select=eq(n\\,${index}),scale=${w}:${h}`, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1 << 26 });
  if (r.status !== 0 || r.stdout.length < w * h * 3) throw new Error(`frame ${index} not decodable: ${r.stderr}`);
  return Buffer.from(r.stdout);
}

/** Number of strongly red pixels (r high, g/b low) in the frame. */
export function redPixels(rgb: Buffer): number {
  let n = 0;
  for (let i = 0; i < rgb.length; i += 3) if (rgb[i]! > 200 && rgb[i + 1]! < 80 && rgb[i + 2]! < 80) n++;
  return n;
}
