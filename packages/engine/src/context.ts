import { indexAtoms, type AtomIndex } from "./atoms";
import type { Fps } from "./frames";
import { DEFAULT_SPEED_LIMITS, type Atom, type Source, type SpeedLimits } from "./types";

/**
 * Everything that is fixed for a session and needed by every engine function:
 * the source facts, the atoms (with a lookup index) and the speed limits.
 * Limits are passed in because the engine cannot read env (MAX_SPEED is read by the API layer).
 */
export interface EngineContext {
  source: Source;
  index: AtomIndex;
  fps: Fps | null;
  limits: SpeedLimits;
}

export function createContext(source: Source, atoms: readonly Atom[], limits: SpeedLimits = DEFAULT_SPEED_LIMITS): EngineContext {
  return { source, index: indexAtoms(atoms, source.durationUs), fps: source.fps, limits };
}
