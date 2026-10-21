import { describe, expect, it } from "vitest";
import { buildAtoms, sha256Hex } from "@incubrix/engine";
import { MockEmbeddingProvider, buildPassages, normalizeQuery, rankPassages } from "../src/index.ts";

const U = 1_000_000;
function atomsOf(sentences: [number, string, string?][]) {
  const words = sentences.flatMap(([start, text, speaker]) => text.split(" ").map((w, i) => ({ text: w, startUs: Math.round((start + i * 0.4) * U), endUs: Math.round((start + i * 0.4 + 0.35) * U), speaker: speaker ?? "A" })));
  return buildAtoms(sha256Hex("sem"), 200 * U, words);
}

describe("passages", () => {
  it("one passage per sentence; a long run without punctuation is cut at 30 words; a speaker change starts a new passage", () => {
    const atoms = atomsOf([[1, "Hello there. This is pricing."], [10, "How much does it cost?", "B"], [20, Array.from({ length: 40 }, () => "word").join(" ")]]);
    const ps = buildPassages(atoms);
    expect(ps.map((p) => p.text)).toEqual(["Hello there.", "This is pricing.", "How much does it cost?", Array(30).fill("word").join(" "), Array(10).fill("word").join(" ")]);
    expect(ps[2]!.speaker).toBe("B");
    expect(ps[1]!.startUs).toBe(Math.round(1.8 * U));
  });
});

describe("query normalisation and ranking", () => {
  it("lower-cases, drops punctuation and filler words so 'the part about Pricing?' and 'pricing' share one cache entry", () => {
    expect(normalizeQuery("the part about Pricing?")).toBe("pricing");
    expect(normalizeQuery("  How much it costs ")).toBe("how much it costs");
  });

  it("ranks by similarity, keeps only passages above the threshold, returns them in time order, ties broken by position", async () => {
    const atoms = atomsOf([[1, "The pricing is simple."], [10, "I walked my dog today."], [20, "It costs ten dollars a month."], [30, "The weather was nice."]]);
    const ps = buildPassages(atoms);
    const p = new MockEmbeddingProvider();
    const vecs = await p.embed(ps.map((x) => x.text));
    const [q] = await p.embed(["pricing"]);
    const hits = rankPassages(q!, ps, vecs, { thresholdPermille: 300, maxHits: 5 });
    expect(hits.map((h) => h.text)).toEqual(["The pricing is simple.", "It costs ten dollars a month."]);
    expect(rankPassages(q!, ps, vecs, { thresholdPermille: 300, maxHits: 5 })).toEqual(hits); // deterministic
    expect(rankPassages(q!, ps, vecs, { thresholdPermille: 300, maxHits: 1 })).toHaveLength(1);
  });
});
