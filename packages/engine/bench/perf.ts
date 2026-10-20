// Engine performance benchmark on a SYNTHETIC 60-minute source (24,000 atoms). Not a real video.
// Run:  npm run bench -w @incubrix/engine      (prints one JSON object; copy real runs into docs/PERF_ENGINE.md)
import { buildAtoms, type WordInput } from "../src/atoms";
import { createContext, type EngineContext } from "../src/context";
import { sha256Hex } from "../src/hash";
import { appendEdit, type Log } from "../src/log";
import { resolveEditedRange } from "../src/resolve";
import { duckingEnvelope } from "../src/music";
import { planMoveEdited, planRemoveFillers, planRemoveSilences } from "../src/plan";
import { findTopicParts } from "../src/search";
import { autoCaptionCues, effectDisplay } from "../src/timemap";
import { materialize } from "../src/replay";
import { currentTimeline, newSession, submitOperations, submitUndo, type SessionState } from "../src/session";
import type { Operation, Source } from "../src/types";
import { usToCursor } from "../src/cursor";

const FPS = { num: 30, den: 1 };
const WORDS = 12_000; // + 12,000 silences = 24,000 atoms
const WORD_US = 200_000; // 6 frames
const GAP_US = 100_000; // 3 frames
const DURATION_US = WORDS * (WORD_US + GAP_US); // exactly 3600 s

function makeContext(): EngineContext {
  const sha = sha256Hex("synthetic-60-minute-fixture-v1");
  const words: WordInput[] = [];
  for (let i = 0; i < WORDS; i++) {
    const startUs = i * (WORD_US + GAP_US) + GAP_US;
    // the last silence is shorter by construction; keep every word inside the duration
    // every 12th word ends a sentence; every 300th sentence-start mentions "pricing"; every 50th word is a filler "um"
    const text = i % 50 === 25 ? "um" : i % 300 === 12 ? "pricing" : `w${i}${i % 12 === 11 ? "." : ""}`;
    words.push({ text, startUs, endUs: startUs + WORD_US, speaker: "S1" });
  }
  const atoms = buildAtoms(sha, DURATION_US + GAP_US, words);
  const source: Source = { sha256: sha, durationUs: DURATION_US + GAP_US, fps: FPS, hasAudio: true, hasVideo: true, variableFrameRate: false };
  return createContext(source, atoms);
}

const ctx = makeContext();
const atoms = ctx.index.atoms;

/** Cut covering atoms [k, k+2): one silence and one word, disjoint for distinct k spaced >= 2 apart. */
function cutAt(k: number): Operation {
  return { type: "cut", reason: "user", span: { start: usToCursor(ctx.index, atoms[k]!.startUs, ctx.fps), end: usToCursor(ctx.index, atoms[k + 2]!.startUs, ctx.fps) } };
}

/** A state with n disjoint cuts, built straight in the log (cheap), one group each. */
function stateWithCuts(n: number, oneGroup: boolean): SessionState {
  let log: Log = [];
  if (oneGroup) {
    log = appendEdit(log, Array.from({ length: n }, (_, i) => cutAt(4 * i + 2))).log;
  } else {
    for (let i = 0; i < n; i++) log = appendEdit(log, [cutAt(4 * i + 2)]).log;
  }
  return { log, conversation: [] };
}

function time<T>(f: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = f();
  return { ms: performance.now() - t0, value };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function bench(runs: number, f: () => unknown): { medianMs: number; maxMs: number; runs: number } {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) ms.push(time(f).ms);
  return { medianMs: Math.round(median(ms) * 10) / 10, maxMs: Math.round(Math.max(...ms) * 10) / 10, runs };
}

const results: Record<string, unknown> = {
  note: "synthetic 60-minute source, 24,000 atoms; times in milliseconds; this machine only",
  atoms: atoms.length,
};

// COLD = a log object the engine has never seen (as after loading a session from the database):
// nothing is cached, the whole log is replayed. WARM = the next instruction in a running session
// (the previous answer's timeline is remembered). Cold is the honest worst case; both are reported.
const cold = (s: SessionState): SessionState => ({ log: [...s.log], conversation: [] });
const mid = Math.floor(atoms.length / 2);
const midCut = (): Operation => cutAt(mid % 2 === 0 ? mid + 1 : mid); // overlaps an existing cut, so it changes the timeline

results["one cut, empty session"] = bench(20, () => submitOperations(ctx, newSession(), "cut", [midCut()]));

const s1500 = stateWithCuts(1500, false);
results["one cut after 1,500 cuts - cold"] = bench(10, () => submitOperations(ctx, cold(s1500), "cut", [midCut()]));
submitOperations(ctx, s1500, "prime", [midCut()]); // fills the cache for s1500.log
results["one cut after 1,500 cuts - warm"] = bench(10, () => submitOperations(ctx, s1500, "cut", [midCut()]));

const s4000 = stateWithCuts(4000, true);
results["one cut with 4,000 segments - cold"] = bench(5, () => submitOperations(ctx, cold(s4000), "cut", [midCut()]));
submitOperations(ctx, s4000, "prime", [midCut()]);
results["one cut with 4,000 segments - warm"] = bench(5, () => submitOperations(ctx, s4000, "cut", [midCut()]));
results["undo with 4,000 segments - cold"] = bench(5, () => submitUndo(ctx, cold(s4000), "undo"));
results["current timeline with 4,000 segments - cold"] = bench(5, () => currentTimeline(ctx, cold(s4000)));
const tl4000 = currentTimeline(ctx, s4000);
results["resolve an edited range with 4,000 segments"] = bench(5, () => resolveEditedRange(ctx, tl4000, 1_000_000_000, 1_200_000_000));
const caption: Operation = {
  type: "add_effect",
  effectId: "fx_9999_0",
  range: { from: atoms[mid]!.id, to: atoms[mid + 40]!.id },
  params: { kind: "caption", text: "x", style: { color: "#ffffff", sizePt: 32, bold: true }, position: "bottom" },
};
results["add a caption with 4,000 segments - cold"] = bench(5, () => submitOperations(ctx, cold(s4000), "caption", [caption]));
results["add a caption with 4,000 segments - warm"] = bench(5, () => submitOperations(ctx, s4000, "caption", [caption]));

const fourThousandOps = Array.from({ length: 4000 }, (_, i) => cutAt(4 * i + 2));
results["one instruction carrying 4,000 cut ops"] = bench(3, () => submitOperations(ctx, newSession(), "cut many", fourThousandOps));

// ---- the new operations (M1c) ---------------------------------------------------------------------------
const midMove: Operation = { type: "move", span: { start: usToCursor(ctx.index, atoms[mid - 40]!.startUs, ctx.fps), end: usToCursor(ctx.index, atoms[mid]!.startUs, ctx.fps) }, before: null };
results["reorder: move 40 atoms to the end with 4,000 segments - cold"] = bench(5, () => submitOperations(ctx, cold(s4000), "move", [midMove]));
results["reorder: move 40 atoms to the end with 4,000 segments - warm"] = bench(5, () => submitOperations(ctx, s4000, "move", [midMove]));

const fresh = newSession();
const tlFresh = currentTimeline(ctx, fresh);
results["plan: remove fillers (240 'um' in 12,000 words)"] = bench(5, () => planRemoveFillers(ctx, tlFresh));
const fillerPlan = planRemoveFillers(ctx, tlFresh);
results["apply: remove fillers as one instruction - cold"] = bench(3, () => submitOperations(ctx, newSession(), "fillers", fillerPlan.operations));
results["plan: remove silences > 50 ms (pad 20 ms) = about 12,000 cuts"] = bench(3, () => planRemoveSilences(ctx, tlFresh, { minUs: 50_000, padUs: 20_000 }));
const silencePlan = planRemoveSilences(ctx, tlFresh, { minUs: 50_000, padUs: 20_000 });
results["counts: filler cuts / silence cuts planned"] = [fillerPlan.operations.length, silencePlan.operations.length];
results["apply: remove silences as ONE instruction of about 12,000 ops"] = bench(3, () => submitOperations(ctx, newSession(), "silences", silencePlan.operations));
results["plan: move edited 10 minutes to the end (4,000 segments)"] = bench(5, () => planMoveEdited(ctx, tl4000, 600_000_000, 1_200_000_000, null));

const music = { assetSha256: "e".repeat(64), gainCentiDb: -600, duckCentiDb: 1800, attackUs: 200_000, releaseUs: 500_000 };
results["ducking envelope, 4,000 segments"] = bench(5, () => duckingEnvelope(ctx, tl4000, music));
results["auto-caption cues, 4,000 segments"] = bench(5, () => autoCaptionCues(ctx, tl4000));

// 40 captions + 4,000 segments, then the topic search (follow-up 4: findTopicParts)
const captionOps: Operation[] = Array.from({ length: 40 }, (_, i) => ({
  type: "add_effect",
  effectId: `fx_${4000 + i}_0`,
  range: { from: atoms[2000 + i * 300]!.id, to: atoms[2000 + i * 300 + 24]!.id },
  params: { kind: "caption", text: `c${i}`, style: { color: "#ffffff", sizePt: 32, bold: true }, position: "bottom" },
}));
const s40 = { log: appendEdit(s4000.log, captionOps).log, conversation: [] } as SessionState;
const tl40 = currentTimeline(ctx, s40);
results["40 captions + 4,000 segments: effect displays (all 40)"] = bench(5, () => tl40.effects.map((e) => effectDisplay(ctx, tl40, e)));
results["findTopicParts('pricing'), 40 captions + 4,000 segments"] = bench(5, () => findTopicParts(ctx, tl40, "pricing"));
results["findTopicParts: matches found"] = findTopicParts(ctx, tl40, "pricing").length;
results["a caption instruction on top of 40 captions + 4,000 segments - cold"] = bench(5, () => submitOperations(ctx, cold(s40), "caption", [{ ...caption, effectId: "fx_9998_0" }]));
void materialize;

console.log(JSON.stringify(results, null, 2));
