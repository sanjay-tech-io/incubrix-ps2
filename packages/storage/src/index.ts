import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "@incubrix/config";

// Why path-style: S3-compatible servers (SeaweedFS, MinIO, Garage) are addressed by host:port,
// not by <bucket>.host DNS names.
export function makeS3(c: Pick<Config, "S3_ENDPOINT" | "S3_REGION" | "S3_ACCESS_KEY" | "S3_SECRET_KEY" | "S3_FORCE_PATH_STYLE">): S3Client {
  return new S3Client({
    endpoint: c.S3_ENDPOINT,
    region: c.S3_REGION,
    forcePathStyle: c.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: c.S3_ACCESS_KEY, secretAccessKey: c.S3_SECRET_KEY },
  });
}

export async function ensureBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}
