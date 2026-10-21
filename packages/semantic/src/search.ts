import type { Passage } from "./passages.ts";

export interface Hit extends Passage {
  /** cosine similarity x 1000, rounded (vectors are unit length). An integer so it can be logged and compared exactly. */
  scorePermille: number;
}

const STOP = new Set(["the", "a", "an", "my", "our", "of", "about", "on", "part", "parts", "section", "sections", "bit", "bits", "talk", "talking", "i", "we"]);

/** Cache key of a query: lower case, letters/digits only, filler words dropped ("the part about Pricing?" -> "pricing"). */
export function normalizeQuery(q: string): string {
  const words = q.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !STOP.has(w));
  return (kept.length > 0 ? kept : words).join(" ");
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Passages with similarity >= threshold, the best maxHits of them, returned in TIME order. Ties go to the earlier passage. */
export function rankPassages(query: readonly number[], passages: readonly Passage[], vectors: readonly (readonly number[])[], o: { thresholdPermille: number; maxHits: number }): Hit[] {
  const scored = passages
    .map((p, i) => ({ p, i, score: Math.round(dot(query, vectors[i]!) * 1000) }))
    .filter((x) => x.score >= o.thresholdPermille && x.p.text.split(" ").length >= 3);
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored
    .slice(0, o.maxHits)
    .sort((a, b) => a.i - b.i)
    .map((x) => ({ ...x.p, scorePermille: Math.max(0, Math.min(1000, x.score)) }));
}
