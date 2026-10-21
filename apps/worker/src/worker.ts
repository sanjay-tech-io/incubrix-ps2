import { claimNextJob, failJob, requeueStale } from "@incubrix/store";
import { errorBody } from "@incubrix/errors";
import { runIntake, type WorkerDeps } from "./intake.ts";
import { runRender } from "./render.ts";

/** Take one queued job and run it. Returns false when the queue was empty. */
export async function processOneJob(d: WorkerDeps): Promise<boolean> {
  const job = await claimNextJob(d.pool);
  if (!job) return false;
  d.log.info({ job_id: job.id, type: job.type }, "job claimed");
  if (job.type === "ingest" || job.type === "transcribe") await runIntake(d, job);
  else if (job.type === "render") await runRender(d, job);
  else await failJob(d.pool, job.id, errorBody("NOT_IMPLEMENTED", `jobs of type ${job.type} are not built yet`));
  return true;
}

/** Polling loop. Stops when the signal aborts. Stale jobs of crashed workers are re-queued every 30 s. */
export async function workerLoop(d: WorkerDeps, signal: AbortSignal): Promise<void> {
  let lastSweep = 0;
  while (!signal.aborted) {
    if (Date.now() - lastSweep > 30_000) {
      lastSweep = Date.now();
      const n = await requeueStale(d.pool, d.cfg.JOB_STALE_S).catch(() => 0);
      if (n > 0) d.log.warn({ requeued: n }, "re-queued stale jobs");
    }
    let worked = false;
    try {
      worked = await processOneJob(d);
    } catch (e) {
      d.log.error({ err: (e as Error).message }, "worker iteration failed");
    }
    if (!worked) await new Promise((r) => setTimeout(r, d.cfg.WORKER_POLL_MS));
  }
}
