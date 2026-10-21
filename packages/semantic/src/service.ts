import type { Atom } from "@incubrix/engine";
import { getPassageVectors, getQueryVector, putPassageVectors, putQueryVector, type Db, type Logger } from "@incubrix/store";
import { buildPassages, type Passage } from "./passages.ts";
import { modelIdOf, type EmbeddingProvider } from "./provider.ts";
import { normalizeQuery, rankPassages, type Hit } from "./search.ts";

export interface SemanticResult {
  topic: string;
  hits: Hit[];
  modelId: string;
  /** What this search cost: lets the API report and the tests assert "no model call on a repeat". */
  timings: { passages: "cache" | "computed"; query: "cache" | "computed"; ms: number };
}

/**
 * Meaning search over a transcript. Vectors are cached in Postgres by (transcript, model+version) and (model+version, query), so
 * a repeated search needs no model call and gives the identical result. The score threshold and hit limit are settings.
 */
export class SemanticService {
  private readonly db: Db;
  private readonly provider: EmbeddingProvider;
  private readonly thresholdPermille: number;
  private readonly maxHits: number;
  private readonly log: Logger | undefined;
  constructor(o: { db: Db; provider: EmbeddingProvider; thresholdPermille: number; maxHits: number; log?: Logger }) {
    this.db = o.db;
    this.provider = o.provider;
    this.thresholdPermille = o.thresholdPermille;
    this.maxHits = o.maxHits;
    this.log = o.log;
  }

  get modelId(): string {
    return modelIdOf(this.provider);
  }

  /** Embed and store the passages of a transcript (intake calls this; a search calls it lazily for older transcripts). */
  async ensurePassages(transcriptKey: string, atoms: readonly Atom[]): Promise<{ passages: Passage[]; vectors: number[][]; from: "cache" | "computed" }> {
    await this.provider.ready?.();
    const cached = await getPassageVectors<Passage>(this.db, transcriptKey, this.modelId);
    if (cached) return { ...cached, from: "cache" };
    const passages = buildPassages(atoms);
    const vectors = await this.provider.embed(passages.map((p) => p.text));
    await putPassageVectors(this.db, transcriptKey, this.modelId, { passages, vectors });
    return { passages, vectors, from: "computed" };
  }

  async search(transcriptKey: string, atoms: readonly Atom[], topic: string): Promise<SemanticResult> {
    const t0 = performance.now();
    await this.provider.ready?.();
    const query = normalizeQuery(topic);
    const p = await this.ensurePassages(transcriptKey, atoms);
    let qv = await getQueryVector(this.db, this.modelId, query);
    const qFrom: "cache" | "computed" = qv ? "cache" : "computed";
    if (!qv) {
      qv = (await this.provider.embed([query]))[0]!;
      await putQueryVector(this.db, this.modelId, query, qv);
    }
    const hits = rankPassages(qv, p.passages, p.vectors, { thresholdPermille: this.thresholdPermille, maxHits: this.maxHits });
    const ms = Math.round(performance.now() - t0);
    this.log?.debug({ query, hits: hits.length, passages: p.from, query_vec: qFrom, ms }, "meaning search");
    return { topic: query, hits, modelId: this.modelId, timings: { passages: p.from, query: qFrom, ms } };
  }
}
