import type { LlmCompletion, LlmProvider } from "./types.ts";

/**
 * Google Gemini over REST (generateContent). The key goes in the `x-goog-api-key` header, never in the URL, and any error text
 * is scrubbed of it, so it cannot reach a log line. Temperature 0, JSON output, a small output cap.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly hardTimeoutMs: number;
  constructor(o: { apiKey: string; model: string; baseUrl?: string; hardTimeoutMs?: number }) {
    this.key = o.apiKey;
    this.model = o.model;
    this.baseUrl = o.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.hardTimeoutMs = o.hardTimeoutMs ?? 20_000;
  }

  private scrub(s: string): string {
    return this.key ? s.split(this.key).join("<redacted>") : s;
  }

  async complete(req: { system: string; user: string }): Promise<LlmCompletion> {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: "user", parts: [{ text: req.user }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 600, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(this.hardTimeoutMs),
      });
    } catch (e) {
      throw new Error(this.scrub(`Gemini request failed: ${(e as Error).message}`));
    }
    const body = await res.text();
    if (!res.ok) throw new Error(this.scrub(`Gemini answered HTTP ${res.status}: ${body.slice(0, 300)}`));
    const j = JSON.parse(body) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const u = j.usageMetadata ?? {};
    return { text, inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), ms: Math.round(performance.now() - t0) };
  }
}
