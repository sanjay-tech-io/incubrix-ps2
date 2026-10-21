import { currentTimeline, newSession, resolveOriginalRange, submitOperations, type Operation } from "@incubrix/engine";
import type { SyncClip } from "./syncclip.ts";

/** One instruction that cuts 0.1 s out of the silence three times a second (at k+0.3, k+0.5, k+0.7): ~3 pieces per second of source. */
export function manyCuts(clip: SyncClip, seconds: number) {
  const ops: Operation[] = [];
  for (let k = 0; k < seconds; k++) {
    for (const off of [0.3, 0.5, 0.7]) {
      const a = Math.round((k + off) * 1e6);
      for (const span of resolveOriginalRange(clip.ctx, a, a + 100_000).spans) ops.push({ type: "cut", span, reason: "user" });
    }
  }
  const turn = submitOperations(clip.ctx, newSession(), `cut ${ops.length} bits`, ops);
  if (turn.answer.status !== "applied") throw new Error(`many cuts rejected: ${turn.answer.summary}`);
  return { timeline: currentTimeline(clip.ctx, turn.state), cuts: ops.length };
}
