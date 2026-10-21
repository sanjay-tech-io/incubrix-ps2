// Usage: node --import tsx scripts/voiced_report.ts <wav 16k mono> <atoms.json> <out.json>
// Runs the untranscribed-voiced-gap detector on a recording's atoms and prints every marker (number and times).
import { readFileSync, writeFileSync } from "node:fs";
import { findVoicedGaps, readWavPcm16 } from "../packages/media/src/index.ts";

const [wavPath, atomsPath, out] = process.argv.slice(2) as [string, string, string];
const atoms = JSON.parse(readFileSync(atomsPath, "utf8")) as { kind: string; startUs: number; endUs: number; text: string }[];
const wav = readWavPcm16(readFileSync(wavPath));
const r = findVoicedGaps({
  samples: wav.samples, sampleRate: wav.sampleRate,
  words: atoms.filter((a) => a.kind === "word"), gaps: atoms.filter((a) => a.kind === "silence"),
});
const fmt = (us: number) => `${Math.floor(us / 60e6)}:${((us % 60e6) / 1e6).toFixed(2).padStart(5, "0")}`;
const rows = r.markers.map((m) => ({ from: fmt(m.startUs), to: fmt(m.endUs), len_s: +((m.endUs - m.startUs) / 1e6).toFixed(2), levelDb: m.levelDb, zcr: m.zcr, touchesWord: m.touchesWord, confidencePermille: m.confidencePermille }));
writeFileSync(out, JSON.stringify({ markers: r.markers.length, tooLong: r.tooLong, stats: r.stats, rows }, null, 1));
console.log(JSON.stringify({ markers: r.markers.length, tooLong: r.tooLong, stats: r.stats }));
for (const x of rows) console.log(x.from, x.to, `${x.len_s}s`, `level ${x.levelDb} dB`, `zcr ${x.zcr}`, x.touchesWord ? "touches-word" : "", `conf ${x.confidencePermille}`);
