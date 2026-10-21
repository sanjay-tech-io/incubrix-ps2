import { isExpirable, sweepExpired } from "@incubrix/storage";
import type { WorkerDeps } from "./intake.ts";

const DAY_MS = 86_400_000;

/**
 * Delete renders and CFR proxies older than RETENTION_DAYS (originals are never matched), forget them in the database
 * (the job says `expired`, the video loses its `proxy` note), then ask SeaweedFS to give the disk space back.
 */
export async function runRetention(d: WorkerDeps, now = Date.now()): Promise<{ deleted: string[] }> {
  if (d.cfg.RETENTION_DAYS <= 0) return { deleted: [] };
  const deleted = await sweepExpired(d.s3, d.cfg.S3_BUCKET, {
    prefixes: ["renders/", "videos/"], olderThanMs: d.cfg.RETENTION_DAYS * DAY_MS, now, shouldDelete: isExpirable,
  });
  if (deleted.length === 0) return { deleted };
  await d.pool.query("update jobs set result = result || '{\"expired\": true}'::jsonb where type='render' and result->'outputs'->>'video' = any($1)", [deleted]);
  await d.pool.query("update videos set probe = probe - 'proxy' where probe->'proxy'->>'storage_key' = any($1)", [deleted]);
  d.log.info({ deleted: deleted.length, retention_days: d.cfg.RETENTION_DAYS }, "retention: expired renders/proxies deleted");
  if (d.cfg.S3_VACUUM_URL) {
    try {
      const r = await fetch(d.cfg.S3_VACUUM_URL);
      d.log.info({ status: r.status }, "storage vacuum requested");
    } catch (e) {
      d.log.warn({ err: (e as Error).message }, "storage vacuum request failed (space is freed later)");
    }
  }
  return { deleted };
}
