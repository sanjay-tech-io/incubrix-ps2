import { createHash } from "node:crypto";
import { ApiError } from "@incubrix/errors";

export interface EmbeddingProvider {
  readonly name: string;
  /** Model id and version together identify the vectors: change either and every cached vector is ignored. */
  readonly model: string;
  readonly version: string;
  embed(texts: string[]): Promise<number[][]>;
  /** Optional: resolves once model/version are known (the HTTP provider asks the service). */
  ready?(): Promise<void>;
}

export const modelIdOf = (p: Pick<EmbeddingProvider, "model" | "version">): string => `${p.model}@${p.version}`;

/** The ASR service's /embed endpoint (all-MiniLM-L6-v2 ONNX on CPU). */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly name = "minilm-onnx";
  model = "sentence-transformers/all-MiniLM-L6-v2";
  version = "unknown";
  private readonly url: string;
  private readonly timeoutMs: number;
  constructor(url: string, timeoutMs = 5000) {
    this.url = url.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  private initialised = false;
  async ready(): Promise<void> {
    if (!this.initialised) {
      await this.init();
      this.initialised = true;
    }
  }

  /** Reads the model identity once from the service (the version includes the ONNX file hash). */
  async init(): Promise<this> {
    const r = await this.call(["version probe"]);
    this.model = r.model;
    this.version = r.version;
    return this;
  }

  private async call(texts: string[]): Promise<{ model: string; version: string; vectors: number[][] }> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts }), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new ApiError("SERVICE_UNAVAILABLE", `The meaning-search service did not answer: ${(e as Error).message}`);
    }
    if (!res.ok) throw new ApiError("SERVICE_UNAVAILABLE", `The meaning-search service answered HTTP ${res.status}`);
    return (await res.json()) as { model: string; version: string; vectors: number[][] };
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 128) out.push(...(await this.call(texts.slice(i, i + 128))).vectors);
    return out;
  }
}

/** Tests only: hashed bag of words with a tiny synonym table (the same idea as the Python mock). It is NOT a model. */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = "mock-bow";
  readonly version = "1";
  calls = 0;
  private static readonly SYN: Record<string, string> = { price: "pricing", prices: "pricing", cost: "pricing", costs: "pricing", pay: "pricing", plans: "pricing", fee: "pricing", subscription: "pricing", dollars: "pricing" };
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Array<number>(2048).fill(0);
      for (const w0 of t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)) {
        const w = MockEmbeddingProvider.SYN[w0] ?? w0;
        v[Number(BigInt("0x" + createHash("sha256").update(w).digest("hex")) % 2048n)]! += 1;
      }
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return v.map((x) => (n ? Math.round((x / n) * 1e6) / 1e6 : 0));
    });
  }
}
