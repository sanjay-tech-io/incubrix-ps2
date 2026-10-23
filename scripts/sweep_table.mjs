// Prints the diarization sweep (docs/raw/m5d_diarization_sweep.jsonl) as a table: "labels / labels with at least 5% of the speech".
// A cell is OK when the count of labels that hold at least 5% of the speech equals the expected number of speakers.
import { readFileSync } from "node:fs";
const rows = readFileSync(process.argv[2] ?? "docs/raw/m5d_diarization_sweep.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const clips = [...new Set(rows.map((r) => r.clip))];
const thr = [...new Set(rows.map((r) => r.threshold))].sort((a, b) => a - b);
console.log("| clip (expected) | " + thr.join(" | ") + " |");
console.log("|---|" + thr.map(() => "---").join("|") + "|");
for (const c of clips) {
  const e = rows.find((r) => r.clip === c).expected;
  console.log(`| ${c} (${e}) | ` + thr.map((t) => { const r = rows.find((x) => x.clip === c && x.threshold === t); return r ? `${r.labels_ge_5pct === e ? "**" : ""}${r.labels}/${r.labels_ge_5pct}${r.labels_ge_5pct === e ? "**" : ""}` : "-"; }).join(" | ") + " |");
}
const ok = (t) => clips.every((c) => { const r = rows.find((x) => x.clip === c && x.threshold === t); return r && r.labels_ge_5pct === r.expected; });
const okRaw = (t) => clips.every((c) => { const r = rows.find((x) => x.clip === c && x.threshold === t); return r && r.labels === r.expected; });
console.log("\nthresholds where every clip is right, counting labels with >= 5% of the speech: " + (thr.filter(ok).join(", ") || "none"));
console.log("thresholds where every clip is right, counting every label (what the pipeline reports today): " + (thr.filter(okRaw).join(", ") || "none"));
