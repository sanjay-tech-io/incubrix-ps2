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
  { name: "later speed change multiplies instead of replacing", file: "src/replay.ts", from: "const kept = raw.speed.flatMap((r) => subtract(r, iv).map((p) => ({ ...p, rate: r.rate })));", to: "const kept = raw.speed;" },
  { name: "restore ignored", file: "src/log.ts", from: "if (op.type === \"restore\") neutralized.add(op.targetGroup);", to: "void op;" },
  { name: "speed limits not enforced", file: "src/replay.ts", from: "if (cmpRate(rate, limits.min) < 0 || cmpRate(rate, limits.max) > 0) {", to: "if (false) {" },
  { name: "frames rounded per piece instead of cumulatively", file: "src/timemap.ts", from: "const r = (2n * cumN + cumD) / (2n * cumD); // round half up (all values are non-negative)", to: "const r = prevR + (2n * n + d) / (2n * d);" },
  { name: "floor/ceil snapping swapped (cut would clip words)", file: "src/cursor.ts", from: "const g = floorToFrameUs(t, fps);", to: "const g = ceilToFrameUs(t, fps);" },
];

function runTests() {
  const extra = process.env.MUTATION_EXCLUDE ? ["--exclude", process.env.MUTATION_EXCLUDE] : [];
  const r = spawnSync("npx", ["vitest", "run", ...extra], { cwd: engine, encoding: "utf8", shell: true, env: { ...process.env, NO_COLOR: "1" } });
  return r.status;
}

let survivors = 0;
for (const m of MUTANTS) {
  const path = `${engine}/${m.file}`;
  const original = readFileSync(path, "utf8");
  if (!original.includes(m.from)) {
    console.log(`SKIPPED (pattern not found, update the script): ${m.name}`);
    survivors++;
    continue;
  }
  try {
    writeFileSync(path, original.replace(m.from, m.to));
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
