/**
 * Frame-grid maths with an exact rational fps (e.g. 30000/1001), integers only.
 * Why here and not only in the renderer: cursors that fall inside a silence must
 * be stored already snapped, so the log never contains an off-grid cut point.
 * (The renderer still does the final frame conversion; see DESIGN.md.)
 */
export interface Fps {
  num: number;
  den: number;
}

const US_PER_S = 1_000_000;

/** Integer division of a/b rounded half up, for non-negative a and positive b. */
export function divRound(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

/** Start time of frame k in microseconds, rounded to the nearest microsecond. */
export function frameStartUs(k: number, fps: Fps): number {
  return divRound(k * fps.den * US_PER_S, fps.num);
}

/** Nearest frame start to t. Idempotent: snapping an on-grid time returns it unchanged. */
export function snapToFrameUs(t: number, fps: Fps): number {
  const k = divRound(t * fps.num, fps.den * US_PER_S);
  return frameStartUs(k, fps);
}
