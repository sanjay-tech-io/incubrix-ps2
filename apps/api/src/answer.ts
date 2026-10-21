import type { CallInfo } from "@incubrix/llm";
import type { Answer, TimePolicy } from "@incubrix/engine";
import { buildManifest, type Manifest } from "@incubrix/store";

// Change B: the summary TEXT says which time policy was used, not only the time_policy field.
export const POLICY_TEXT: Record<TimePolicy, string> = {
  current: "Time policy: current (times refer to the edited timeline as it is now).",
  original: "Time policy: original (times refer to the untouched source video).",
};

export function summaryText(a: Pick<Answer, "status" | "summary" | "timePolicy">): string {
  const policy = POLICY_TEXT[a.timePolicy];
  if (a.status === "applied") return `${a.summary ?? "Applied."} ${policy}`;
  if (a.status === "needs_clarification") return `Nothing changed yet; waiting for your choice. ${policy}`;
  return `Nothing changed. ${policy}`;
}

/** The API shape of an engine answer (snake_case). `manifest` is added for live answers. */
export function answerView(a: Answer, extra: { turn?: number; manifest?: Manifest } = {}) {
  return {
    status: a.status,
    operations: a.operations,
    summary: summaryText(a),
    question: a.question,
    options: a.options,
    reason: a.reason,
    time_policy: a.timePolicy,
    warnings: a.warnings,
    timeline_hash: a.timelineHash,
    duration_s: a.durationUs / 1_000_000,
    duration_us: a.durationUs,
    ...(extra.turn !== undefined ? { turn: extra.turn } : {}),
    ...(extra.manifest ? { manifest: extra.manifest } : {}),
  };
}

export function instructionManifest(o: { parser: { name: string; version: string }; llmProvider: string; maxSpeed: number; timePolicy: TimePolicy; instructionMs: number; cpuSeconds: number; warnings: string[]; rights: string | null; aiGenerated: boolean; semantic?: { model: string; ms: number; hits: number; passages: string; query: string } | null; llm?: CallInfo | null; llmOffNote?: string | null }) {
  return buildManifest({
    providers: { parser: { name: o.parser.name, version: o.parser.version }, engine: { name: "incubrix-engine", version: "0.0.0" }, embedding: o.semantic ? { model: o.semantic.model, hits: o.semantic.hits, passages: o.semantic.passages, query_vector: o.semantic.query } : "none (no meaning search was needed)", llm: o.llm ? { provider: o.llm.provider, model: o.llm.model, prompt_version: o.llm.promptVersion, cache: o.llm.cache, input_tokens: o.llm.inputTokens, output_tokens: o.llm.outputTokens, latency_ms: o.llm.latencyMs } : o.llmOffNote ? `off (${o.llmOffNote})` : "none (no LLM was called)" },
    settings: { llm_provider: o.llmProvider, time_policy: o.timePolicy, max_speed: o.maxSpeed, min_speed: 0.25, randomness: "none" },
    timings: { instruction_ms: Math.round(o.instructionMs * 100) / 100, ...(o.semantic ? { semantic_ms: o.semantic.ms } : {}), ...(o.llm ? { llm_ms: o.llm.latencyMs } : {}) },
    cpuSeconds: o.cpuSeconds,
    warnings: o.warnings,
    rights: o.rights,
    aiGeneratedInput: o.aiGenerated,
    aiFlags: { llm_used: !!o.llm && (o.llm.cache === "miss" || o.llm.cache === "hit"), transcript_words: true },
    ...(o.llm ? { usd: o.llm.costUsd, usdBasis: `Estimate: ${o.llm.inputTokens} input + ${o.llm.outputTokens} output tokens at the configured per-million prices (paid-tier rates; the key's actual tier is not known); 0 for a cache hit.` } : {}),
  });
}
