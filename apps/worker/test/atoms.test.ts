import { describe, expect, it } from "vitest";
import { atomsFromAsr } from "../src/atoms.ts";
import type { AsrWord } from "../src/asr.ts";

const SHA = "a".repeat(64);
const U = 1_000_000;
const w = (text: string, s: number, e: number, extra: Partial<AsrWord> = {}): AsrWord => ({ text, start_us: s * U, end_us: e * U, confidence_permille: 900, ...extra });
const opts = { clampMinWordUs: 20_000, lowConfidencePermille: 600 };

describe("atomsFromAsr", () => {
  it("tiles the whole duration with words and silences", () => {
    const { atoms } = atomsFromAsr(SHA, 10 * U, [w("hello", 1, 2), w("world", 3, 4)], [], opts);
    expect(atoms[0]!.startUs).toBe(0);
    expect(atoms[atoms.length - 1]!.endUs).toBe(10 * U);
    atoms.slice(1).forEach((a, i) => expect(a.startUs).toBe(atoms[i]!.endUs));
    expect(atoms.filter((a) => a.kind === "word").map((a) => a.text)).toEqual(["hello", "world"]);
  });

  it("pulls a word end that runs into a measured silence back to the silence start", () => {
    const { atoms, stats } = atomsFromAsr(SHA, 10 * U, [w("hello", 1, 3)], [{ startUs: 2 * U, endUs: 4 * U }], opts);
    expect(atoms.find((a) => a.text === "hello")!.endUs).toBe(2 * U);
    expect(stats.clamp_adjustments).toBe(1);
  });

  it("passes the possible-label-swap flag from the ASR service to the atoms", () => {
    const { atoms } = atomsFromAsr(SHA, 10 * U, [w("hi", 1, 2, { possible_label_swap: true }), w("there", 3, 4, { possible_label_swap: false }), w("you", 5, 6)], [], opts);
    expect(atoms.filter((a) => a.kind === "word").map((a) => a.possibleLabelSwap)).toEqual([true, false, false]);
  });

  it("drops words after the end and zero-length words, and says so; fixes overlaps", () => {
    const r = atomsFromAsr(SHA, 5 * U, [w("late", 6, 7), w("zero", 1, 1), w("a", 2, 3), w("b", 2.5, 3.5)], [], opts);
    expect(r.warnings.join(" ")).toMatch(/after the end/);
    expect(r.warnings.join(" ")).toMatch(/no length/);
    const words = r.atoms.filter((a) => a.kind === "word");
    expect(words.map((a) => a.text)).toEqual(["a", "b"]);
    expect(words[1]!.startUs).toBe(3 * U); // b starts where a ends
  });

  it("carries speaker, overlap and low-confidence flags", () => {
    const { atoms } = atomsFromAsr(SHA, 5 * U, [w("hi", 1, 2, { speaker: "SPEAKER_01", overlaps_speech: true, speaker_uncertain: true, confidence_permille: 300 })], [], opts);
    expect(atoms.find((a) => a.text === "hi")).toMatchObject({ speaker: "SPEAKER_01", overlapsSpeech: true, speakerUncertain: true, lowConfidence: true });
  });

  it("is deterministic: same input, same atom ids", () => {
    const a = atomsFromAsr(SHA, 5 * U, [w("hi", 1, 2)], [], opts).atoms.map((x) => x.id);
    const b = atomsFromAsr(SHA, 5 * U, [w("hi", 1, 2)], [], opts).atoms.map((x) => x.id);
    expect(a).toEqual(b);
    expect(atomsFromAsr("b".repeat(64), 5 * U, [w("hi", 1, 2)], [], opts).atoms.map((x) => x.id)).not.toEqual(a);
  });
});
