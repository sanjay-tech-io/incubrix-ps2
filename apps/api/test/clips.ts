import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test clips are generated, never stored in git. Video: ffmpeg lavfi testsrc (a synthetic picture).
// Speech: espeak-ng (AI/synthetic speech, listed in SOURCES.md). Audio is silent after the speech so the silence detector has real input.
const dir = join(tmpdir(), "incubrix-test-clips");
mkdirSync(dir, { recursive: true });
const SCRIPT = "Hello everyone and welcome to the channel. Today I will show you something useful. Thanks for watching.";

export interface ClipOptions {
  seconds: number;
  audio?: boolean;
  /** Variable frame rate: about 40% of frames are dropped at random positions and the original timestamps are kept (gaps of 1, 2, 3... frames, like a phone recording). */
  vfr?: boolean;
  fps?: number;
  /** "speech" = espeak-ng then silence; "tone" = a sine wave. */
  voice?: "speech" | "tone";
}

export function makeClip(o: ClipOptions): string {
  const { seconds, audio = true, vfr = false, fps = 25, voice = "speech" } = o;
  const out = join(dir, `clip_${seconds}s_${audio ? voice : "noaudio"}_${vfr ? "vfr" : "cfr"}_${fps}.mp4`);
  if (existsSync(out)) return out;
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=160x120:rate=${fps}`];
  if (audio) {
    if (voice === "speech") {
      const wav = join(dir, "speech.wav");
      if (!existsSync(wav)) execFileSync("espeak-ng", ["-v", "en-us", "-s", "150", SCRIPT, "-w", join(dir, "speech_raw.wav")]);
      if (!existsSync(wav)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(dir, "speech_raw.wav"), "-ac", "1", "-ar", "16000", wav]);
      args.push("-i", wav, "-af", "apad");
    } else args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000");
  }
  if (vfr) args.push("-vf", "select='gt(random(1),0.4)'", "-fps_mode", "vfr");
  args.push("-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "40", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac", "-b:a", "32k");
  args.push(out);
  execFileSync("ffmpeg", args);
  return out;
}
