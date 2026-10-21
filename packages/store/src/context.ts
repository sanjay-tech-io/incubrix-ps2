import { createContext, type EngineContext } from "@incubrix/engine";
import type { Atom, Source } from "@incubrix/contracts";
import type { VideoRow } from "./videos.ts";

/** MAX_SPEED (a decimal such as 4 or 2.5) -> the exact rational the engine wants. Min speed is fixed at 1/4. */
export function speedLimits(maxSpeed: number) {
  const scaled = Math.round(maxSpeed * 1000);
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
  const d = g(scaled, 1000);
  return { min: { num: 1, den: 4 }, max: { num: scaled / d, den: 1000 / d } };
}

/** The engine's Source, from what intake stored in videos.probe. */
export function sourceOf(v: VideoRow): Source {
  const p = v.probe as { duration_us: number; fps: { num: number; den: number } | null; has_audio: boolean; has_video: boolean; variable_frame_rate: boolean; sha256: string };
  return { sha256: p.sha256, durationUs: p.duration_us, fps: p.fps, hasAudio: p.has_audio, hasVideo: p.has_video, variableFrameRate: p.variable_frame_rate };
}

/** The same context for the API (instructions) and the worker (render): one place builds it. */
export function contextOf(v: VideoRow, atoms: readonly Atom[], maxSpeed: number): EngineContext {
  return createContext(sourceOf(v), atoms, speedLimits(maxSpeed));
}
