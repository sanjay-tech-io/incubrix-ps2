// Poor man's mutation testing: break one thing in packages/engine/src at a time and
// require the engine's test suite to FAIL. A mutant that "survives" (suite still
// green) means a test is missing. Source files are always restored afterwards.
//
// Usage: node scripts/mutation-check.mjs        (exit code 1 if any mutant survives)
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const engine = `${root}packages/engine`;

const MUTANTS = [
  { name: "music dropped from the timeline", file: "src/replay.ts", from: "    music: raw.music,", to: "    music: null," },
  { name: "effect ids count log length instead of edit entries", file: "src/log.ts", from: 'return log.filter((e) => e.kind === "edit").length;', to: "return log.length;" },
  { name: "protected pauses dropped from the timeline", file: "src/replay.ts", from: "    protectedPauses: pauses,", to: "    protectedPauses: []," },
  { name: "auto-caption style dropped from the timeline", file: "src/replay.ts", from: "    autoCaption: raw.autoCaption,", to: "    autoCaption: null," },
  { name: "new edit no longer clears redo (incremental engine)", file: "src/incremental.ts", from: "this.redoStack = []; // a new edit clears redo", to: "// mutated" },
  { name: "new edit no longer clears redo (log analysis)", file: "src/log.ts", from: "      redo = [];\n", to: "" },
  { name: "speed overlap: left remainder of the earlier region dropped", file: "src/replay.ts", from: "if (first.s < iv.s) mid.push({ s: first.s, e: iv.s, rate: first.rate });", to: "" },
  { name: "speed overlap: right remainder of the earlier region dropped", file: "src/replay.ts", from: "if (last.e > iv.e) mid.push({ s: iv.e, e: last.e, rate: last.rate });", to: "" },
  { name: "restore ignored", file: "src/log.ts", from: "if (op.type === \"restore\") neutralized.add(op.targetGroup);", to: "void op;" },
  { name: "speed limits not enforced", file: "src/replay.ts", from: "if (cmpRate(rate, limits.min) < 0 || cmpRate(rate, limits.max) > 0) {", to: "if (false) {" },
  { name: "frames rounded per piece instead of cumulatively", file: "src/timemap.ts", from: "const r = (2n * cumN + cumD) / (2n * cumD); // round half up (all values are non-negative)", to: "const r = prevR + (2n * n + d) / (2n * d);" },
  { name: "floor/ceil snapping swapped (cut would clip words)", file: "src/cursor.ts", from: "const g = floorToFrameUs(t, fps);", to: "const g = ceilToFrameUs(t, fps);" },
  { name: "cache primed even when the instruction contains a restore", file: "src/session.ts", from: 'if (!ops.some((o) => o.type === "restore")) primeRaw(ctx, appended.log, rawAfter);', to: "primeRaw(ctx, appended.log, rawAfter);" },
  { name: "cache primed with the state BEFORE the new group", file: "src/session.ts", from: "primeRaw(ctx, appended.log, rawAfter);", to: "primeRaw(ctx, appended.log, rawFromLog(ctx, state.log));" },
  { name: "binary search finds segments by start instead of end", file: "src/replay.ts", from: "if (xs[mid]!.e > x) hi = mid;", to: "if (xs[mid]!.s > x) hi = mid;" },
  { name: "reorder: moved block inserted AFTER the target", file: "src/replay.ts", from: "const segs = mergeAdjacent([...rest.slice(0, at), ...moved, ...rest.slice(at)]);", to: "const segs = mergeAdjacent([...rest.slice(0, at + 1), ...moved, ...rest.slice(at + 1)]);" },
  { name: "reorder: moved material also left in place (duplicated)", file: "src/replay.ts", from: "moved.push({ s: a, e: b });", to: "moved.push({ s: a, e: b });\n    rest.push({ s: a, e: b });" },
  { name: "reorder: 'to the end' goes to the start", file: "src/replay.ts", from: "let at = rest.length;", to: "let at = 0;" },
  { name: "reorder: moving a section into itself allowed", file: "src/replay.ts", from: "if (before !== null && before > iv.s && before < iv.e) {", to: "if (false) {" },
  { name: "reorder: merge of source-contiguous neighbours removed (move and its inverse differ)", file: "src/replay.ts", from: "if (last && last.e === s.s) out[out.length - 1] = { s: last.s, e: s.e };", to: "if (false) out[out.length - 1] = { s: last!.s, e: s.e };" },
  { name: "reorder: cut after a move loses the right remainder", file: "src/replay.ts", from: "if (iv.e < s.e) out.push({ s: iv.e, e: s.e });", to: "" },
  { name: "reorder: source index never built (binary search over unsorted pieces)", file: "src/timemap.ts", from: "if (!sorted) {", to: "if (false) {" },
  { name: "reorder: speed regions looked up from the wrong index", file: "src/timemap.ts", from: "for (let k = firstSpeedEndingAfter(speed, seg.s);", to: "for (let k = 0;" },
  { name: "reorder: an effect split by a move is still treated as one run", file: "src/timemap.ts", from: "if (p.srcS < windowS || p.srcE > windowE) {", to: "if (false) {" },
  { name: "reorder: auto-caption cues in source order instead of output order", file: "src/timemap.ts", from: "for (const p of pieces) {\n    // first atom that ends after the piece starts", to: "for (const p of [...pieces].sort((x, y) => x.srcS - y.srcS)) {\n    // first atom that ends after the piece starts" },
  { name: "fillers: the filler flag is ignored", file: "src/plan.ts", from: "if (a.kind !== \"word\" || !a.filler) return;", to: "if (a.kind !== \"word\") return;" },
  { name: "fillers: a bleeped filler is removed anyway", file: "src/plan.ts", from: "const mask = masks.find((m) => i >= m.a && i <= m.b);", to: "const mask = undefined as (typeof masks)[number] | undefined;" },
  { name: "fillers: 'like' rule R1 (own comma) removed", file: "src/atoms.ts", from: "if (a.text.endsWith(\",\")) return true; // R1", to: "// R1 removed" },
  { name: "fillers: 'like' rule R4 (after um/uh) removed", file: "src/atoms.ts", from: "if (prevWord?.kind === \"word\" && prevWord.filler && pauseBefore <= LIKE_PAUSE_US) return true; // R4", to: "// R4 removed" },
  { name: "silences: pinned pauses are cut anyway", file: "src/plan.ts", from: "if (pinned.has(i)) {", to: "if (false) {" },
  { name: "silences: no pad kept next to speech", file: "src/plan.ts", from: "const padS = s0 === a.startUs && atoms[i - 1]?.kind === \"word\" ? pad : 0;", to: "const padS = 0;" },
  { name: "silences: 'longer than N' becomes 'at least N'", file: "src/plan.ts", from: "e0 - s0 <= options.minUs", to: "e0 - s0 < options.minUs" },
  { name: "music: ducked level at speech start replaced by the base level", file: "src/music.ts", from: "put(seg.startUs, low, true);", to: "put(seg.startUs, base, true);" },
  { name: "music: release uses the attack time", file: "src/music.ts", from: "put(seg.endUs + music.releaseUs, base);", to: "put(seg.endUs + music.attackUs, base);" },
  { name: "music: close speech is not merged (music would jump up between)", file: "src/music.ts", from: "speechSegments(ctx, tl, music.attackUs + music.releaseUs)", to: "speechSegments(ctx, tl, 0)" },
  { name: "warnings: bleep/mute no longer warns about low-confidence words", file: "src/session.ts", from: "rangeAtoms(ctx, op.range).forEach((i) => touched.add(i));", to: "void op;" },
  { name: "warnings: topic search drops the grid warnings", file: "src/search.ts", from: "warnings: gridWarnings(ctx, [startSnapped, endSnapped]),", to: "warnings: []," },
  { name: "warnings: filler removal drops the grid warnings", file: "src/plan.ts", from: "warnings.push(...gridWarnings(ctx, bounds.flatMap((b) => [b.s, b.e])));", to: "" },
  { name: "warnings: edited/original range resolution drops the grid warnings", file: "src/resolve.ts", from: "addGridWarnings(ctx, warnings, good.flatMap((iv) => [iv.s, iv.e]));", to: "" },
  { name: "immutability: a cut edits the previous state's list in place", file: "src/replay.ts", from: "return [...segs.slice(0, i), ...mid, ...segs.slice(j)];", to: "segs.splice(i, j - i, ...mid);\n  return segs as Interval[];" },
];

function runTests() {
  const extra = process.env.MUTATION_EXCLUDE ? ["--exclude", process.env.MUTATION_EXCLUDE] : [];
  const r = spawnSync("npx", ["vitest", "run", ...extra], { cwd: engine, encoding: "utf8", shell: true, env: { ...process.env, NO_COLOR: "1" } });
  return r.status;
}

let survivors = 0;
for (const m of MUTANTS) {
  if (process.env.ONLY && !m.name.includes(process.env.ONLY)) continue;
  const path = `${engine}/${m.file}`;
  const original = readFileSync(path, "utf8");
  const normalized = original.split("\r\n").join("\n"); // match patterns regardless of the checkout line endings
  if (!normalized.includes(m.from)) {
    console.log(`SKIPPED (pattern not found, update the script): ${m.name}`);
    survivors++;
    continue;
  }
  try {
    if (process.env.DRY) {
      console.log(`pattern ok: ${m.name}`);
      continue;
    }
    writeFileSync(path, normalized.replace(m.from, () => m.to));
    const status = runTests();
    const killed = status !== 0;
    if (!killed) survivors++;
    console.log(`${killed ? "killed  " : "SURVIVED"}  ${m.name}`);
  } finally {
    writeFileSync(path, original);
  }
}
console.log(`\n${MUTANTS.length - survivors}/${MUTANTS.length} mutants killed`);
process.exit(survivors === 0 ? 0 : 1);
