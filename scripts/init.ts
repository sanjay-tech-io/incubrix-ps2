// One-shot init used by docker compose: apply migrations, make sure the bucket exists.
import { loadConfig } from "@incubrix/config";
import { migrate } from "@incubrix/db";
import { makeS3, verifyBucketWritable } from "@incubrix/storage";

const cfg = loadConfig(process.env);
const { applied } = await migrate(cfg.DATABASE_URL);
await verifyBucketWritable(makeS3(cfg), cfg.S3_BUCKET);
console.log(JSON.stringify({ level: "info", msg: "init done", applied, bucket: cfg.S3_BUCKET }));
