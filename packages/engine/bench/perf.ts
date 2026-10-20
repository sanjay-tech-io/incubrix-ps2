// Engine performance benchmark on a SYNTHETIC 60-minute source (24,000 atoms). Not a real video.
// Run:  npm run bench -w @incubrix/engine      (prints one JSON object; copy real runs into docs/PERF_ENGINE.md)
import { buildAtoms, type WordInput } from "../src/atoms";
import { createContext, type EngineContext } from "../src/context";
import { sha256Hex } from "../src/hash";
import { appendEdit, type Log } from "../src/log";
import { resolveEditedRange } from "../src/resolve";
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
    words.push({ text: `w${i}`, startUs, endUs: startUs + WORD_US, speaker: "S1" });
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

console.log(JSON.stringify(results, null, 2));
