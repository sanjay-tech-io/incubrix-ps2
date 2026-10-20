import type { S3Client } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@incubrix/config";
import { ensureBucket, makeS3 } from "../src/index.ts";

// Integration: needs the S3 store from compose (TEST_S3=1 is set by the tests service).
const run = process.env.TEST_S3 ? describe : describe.skip;

run("S3 store", () => {
  // Why in beforeAll: a skipped describe still runs its body, and loadConfig throws without env.
  let cfg: ReturnType<typeof loadConfig>;
  let s3: S3Client;
  beforeAll(() => {
    cfg = loadConfig(process.env);
    s3 = makeS3(cfg);
  });

  it("ensureBucket creates the bucket and is idempotent", async () => {
    await ensureBucket(s3, cfg.S3_BUCKET);
    await ensureBucket(s3, cfg.S3_BUCKET);
  });

  it("round-trips an object", async () => {
    const { PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
    await s3.send(new PutObjectCommand({ Bucket: cfg.S3_BUCKET, Key: "test/hello.txt", Body: "hello" }));
    const r = await s3.send(new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: "test/hello.txt" }));
    expect(await r.Body!.transformToString()).toBe("hello");
  });
});
