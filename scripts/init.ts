// One-shot init used by docker compose: apply migrations, make sure the bucket exists.
import { loadConfig } from "@incubrix/config";
import { migrate } from "@incubrix/db";
import { ensureBucket, makeS3 } from "@incubrix/storage";

const cfg = loadConfig(process.env);
const { applied } = await migrate(cfg.DATABASE_URL);
await ensureBucket(makeS3(cfg), cfg.S3_BUCKET);
console.log(JSON.stringify({ level: "info", msg: "init done", applied, bucket: cfg.S3_BUCKET }));
