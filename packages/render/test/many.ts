import { currentTimeline, newSession, resolveOriginalRange, submitOperations, type Operation } from "@incubrix/engine";
import type { SyncClip } from "./syncclip.ts";

/** One instruction that cuts 0.1 s out of the silence three times a second (offsets 0.2, 0.35, ...): ~3 pieces per second of source. */
export function manyCuts(clip: SyncClip, seconds: number, perSecond = 3) {
  const ops: Operation[] = [];
  for (let k = 0; k < seconds; k++) {
    for (const off of [0.2, 0.35, 0.5, 0.65, 0.8].slice(0, perSecond)) {
      const a = Math.round((k + off) * 1e6);
      for (const span of resolveOriginalRange(clip.ctx, a, a + 100_000).spans) ops.push({ type: "cut", span, reason: "user" });
    }
  }
  const turn = submitOperations(clip.ctx, newSession(), `cut ${ops.length} bits`, ops);
  if (turn.answer.status !== "applied") throw new Error(`many cuts rejected: ${turn.answer.summary}`);
  return { timeline: currentTimeline(clip.ctx, turn.state), cuts: ops.length };
}
