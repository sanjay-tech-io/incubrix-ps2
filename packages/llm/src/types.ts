export interface LlmCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: { system: string; user: string }): Promise<LlmCompletion>;
}

/** Where every model reply is kept (the llm_cache table): a replay never needs the network. */
export interface LlmCache {
  get(key: string): Promise<{ provider: string; model: string; response: Record<string, unknown> } | null>;
  put(key: string, row: { provider: string; model: string; response: Record<string, unknown> }): Promise<void>;
}

/** What one fallback attempt cost, for the manifest. */
export interface CallInfo {
  provider: string;
  model: string;
  promptVersion: string;
  /** miss = the model was called; hit = answered from llm_cache (no network, no cost); timeout = the model was too slow. */
  cache: "miss" | "hit" | "timeout" | "error";
  inputTokens: number;
  outputTokens: number;
  /** Estimate at the configured per-token prices (the paid-tier rates); 0 for a cache hit. */
  costUsd: number;
  latencyMs: number;
}
