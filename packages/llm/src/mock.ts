import type { LlmCompletion, LlmProvider } from "./types.ts";

type Reply = { commands?: unknown[]; raw?: string; usage?: { inputTokens: number; outputTokens: number } };

/** Tests only. `script` maps a normalised instruction (or "*") to the reply; `calls` counts how often the model was asked. */
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock-llm";
  calls = 0;
  private readonly script: Record<string, Reply>;
  private readonly delayMs: number;
  constructor(script: Record<string, Reply> = {}, delayMs = 0) {
    this.script = script;
    this.delayMs = delayMs;
  }
  async complete(req: { system: string; user: string }): Promise<LlmCompletion> {
    this.calls++;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const instruction = (/Instruction: (.*)$/s.exec(req.user)?.[1] ?? "").trim().toLowerCase();
    const r = this.script[instruction] ?? this.script["*"];
    if (!r) return { text: JSON.stringify({ commands: [{ op: "unsupported", reason: "the mock has no reply for this" }] }), inputTokens: 10, outputTokens: 5, ms: this.delayMs };
    return { text: r.raw ?? JSON.stringify({ commands: r.commands }), inputTokens: r.usage?.inputTokens ?? 100, outputTokens: r.usage?.outputTokens ?? 20, ms: this.delayMs };
  }
}
