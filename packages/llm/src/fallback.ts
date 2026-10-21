import { createHash } from "node:crypto";
import { currentTimeline, type EngineContext, type SessionState } from "@incubrix/engine";
import type { InstructionParser, ParseInput, Parsed } from "@incubrix/nlu";
import { Commands, commandsToText, contextSummary, type ContextSummary } from "./commands.ts";
import { PROMPT_VERSION, SYSTEM_PROMPT, userPrompt } from "./prompt.ts";
import type { CallInfo, LlmCache, LlmProvider } from "./types.ts";

export const normalizeInstruction = (t: string): string => t.toLowerCase().replace(/[^a-z0-9\s':.,"-]/g, " ").replace(/\s+/g, " ").trim();

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/** The llm_cache key: provider, model, prompt version, the normalised instruction and the timeline context. Any change = a miss. */
export function cacheKeyOf(o: { provider: string; model: string; promptVersion: string; instruction: string; context: ContextSummary }): string {
  return createHash("sha256").update(canonical({ ...o, instruction: normalizeInstruction(o.instruction) })).digest("hex");
}

export interface Price {
  inputPerM: number;
  outputPerM: number;
}

export interface FallbackResult {
  parsed: Parsed;
  call: CallInfo;
}

/**
 * Language-model fallback for instructions the rules parser does not understand. The model only translates text into
 * `Commands` (validated with zod); the commands are turned into sentences and parsed by the rules parser, so the engine decides
 * everything. Every reply is cached by (provider, model, prompt version, instruction, context) so a replay needs no network.
 */
export class LlmFallback {
  private readonly o: { provider: LlmProvider; cache: LlmCache; rules: InstructionParser; timeoutMs: number; price: Price };
  constructor(o: { provider: LlmProvider; cache: LlmCache; rules: InstructionParser; timeoutMs: number; price: Price }) {
    this.o = o;
  }

  get provider(): LlmProvider {
    return this.o.provider;
  }

  /** Parse with the rules; only when they do not understand the text, ask the model. null = the rules handled it. */
  async parseUnparsed(input: Pick<ParseInput, "ctx" | "state" | "text">): Promise<FallbackResult | null> {
    const first = this.o.rules.parse(input as ParseInput);
    if (!(first.kind === "reject" && first.unparsed)) return null;
    return this.translate(input.ctx, input.state, input.text);
  }

  async translate(ctx: EngineContext, state: SessionState, text: string): Promise<FallbackResult> {
    const { provider, cache, timeoutMs, price } = this.o;
    const context = contextSummary(ctx, currentTimeline(ctx, state));
    const key = cacheKeyOf({ provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION, instruction: text, context });
    const info = (p: Partial<CallInfo>): CallInfo => ({ provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION, cache: "miss", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, ...p });
    const timePolicy = /\boriginal\b/i.test(text) ? "original" : "current";
    const reject = (reason: string, call: CallInfo): FallbackResult => ({ parsed: { kind: "reject", reason, timePolicy, warnings: [] }, call });

    let reply: string;
    let call: CallInfo;
    const t0 = performance.now();
    const cached = await cache.get(key);
    if (cached) {
      reply = String(cached.response.text ?? "");
      call = info({ cache: "hit", latencyMs: Math.round(performance.now() - t0) });
    } else {
      // The request keeps running after a timeout and its reply is stored, so asking again a moment later is a cache hit.
      const inflight = provider
        .complete({ system: SYSTEM_PROMPT, user: userPrompt(text, context) })
        .then(async (c) => {
          await cache.put(key, { provider: provider.name, model: provider.model, response: { text: c.text, inputTokens: c.inputTokens, outputTokens: c.outputTokens, promptVersion: PROMPT_VERSION } });
          return c;
        });
      inflight.catch(() => undefined);
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
      let c: Awaited<typeof inflight> | "timeout";
      try {
        c = await Promise.race([inflight, timeout]);
      } catch (e) {
        return reject(`The language-model fallback failed (${(e as Error).message.slice(0, 160)}), so nothing was changed.`, info({ cache: "error", latencyMs: Math.round(performance.now() - t0) }));
      }
      if (c === "timeout") {
        return reject(
          `I did not understand that, and the language model did not answer within ${timeoutMs / 1000} s. Nothing was changed. Say it again in a few seconds: its answer will be ready then.`,
          info({ cache: "timeout", latencyMs: timeoutMs }),
        );
      }
      reply = c.text;
      call = info({ cache: "miss", inputTokens: c.inputTokens, outputTokens: c.outputTokens, costUsd: (c.inputTokens * price.inputPerM + c.outputTokens * price.outputPerM) / 1e6, latencyMs: c.ms });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(reply);
    } catch {
      return reject("I did not understand that, and the language model's reply was not valid JSON, so nothing was changed.", call);
    }
    const v = Commands.safeParse(parsedJson);
    if (!v.success) return reject(`I did not understand that, and the language model's reply did not match the allowed commands (${v.error.issues[0]?.message ?? "invalid"}), so nothing was changed.`, call);
    const unsupported = v.data.commands.find((c) => c.op === "unsupported");
    if (unsupported && unsupported.op === "unsupported") return reject(`I did not understand that. ${unsupported.reason}`, call);

    const sentence = commandsToText(v.data.commands);
    const parsed = this.o.rules.parse({ ctx, state, text: sentence });
    const note = `Interpreted by the language model (${provider.name} ${provider.model}) as: ${sentence}`;
    if (parsed.kind === "reject") return { parsed: { ...parsed, reason: `${parsed.reason} (the language model read your instruction as: ${sentence})` }, call };
    if (parsed.kind === "plan" || parsed.kind === "clarify") return { parsed: { ...parsed, warnings: [note, ...parsed.warnings] }, call };
    return { parsed, call };
  }
}
