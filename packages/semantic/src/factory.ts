import type { Config } from "@incubrix/config";
import type { Db, Logger } from "@incubrix/store";
import { HttpEmbeddingProvider, MockEmbeddingProvider } from "./provider.ts";
import { SemanticService } from "./service.ts";

/** EMBED_PROVIDER -> service (null = meaning search is off and the answer says exact words only). */
export function createSemantic(cfg: Pick<Config, "EMBED_PROVIDER" | "EMBED_URL" | "ASR_URL" | "EMBED_THRESHOLD_PERMILLE" | "EMBED_MAX_HITS">, db: Db, log?: Logger): SemanticService | null {
  if (cfg.EMBED_PROVIDER === "none") return null;
  const provider = cfg.EMBED_PROVIDER === "mock" ? new MockEmbeddingProvider() : new HttpEmbeddingProvider(cfg.EMBED_URL ?? cfg.ASR_URL);
  return new SemanticService({ db, provider, thresholdPermille: cfg.EMBED_THRESHOLD_PERMILLE, maxHits: cfg.EMBED_MAX_HITS, ...(log ? { log } : {}) });
}
