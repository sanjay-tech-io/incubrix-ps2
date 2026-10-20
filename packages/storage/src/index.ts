import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "@incubrix/config";

// Why path-style: S3-compatible servers (SeaweedFS, MinIO, Garage) are addressed by host:port,
// not by <bucket>.host DNS names.
export function makeS3(c: Pick<Config, "S3_ENDPOINT" | "S3_REGION" | "S3_ACCESS_KEY" | "S3_SECRET_KEY" | "S3_FORCE_PATH_STYLE">): S3Client {
  return new S3Client({
    endpoint: c.S3_ENDPOINT,
    region: c.S3_REGION,
    forcePathStyle: c.S3_FORCE_PATH_STYLE,
    // Why: by default the SDK puts a CRC32 of the (empty, unknown at signing time) body into a presigned
    // PUT url, so the real upload fails with BadDigest on SeaweedFS. Only checksum when the API requires it.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
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

// Presigned URLs let a client upload/download without our credentials (large uploads bypass the API).
export function presignGet(s3: S3Client, bucket: string, key: string, expiresInS: number): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInS });
}

export function presignPut(s3: S3Client, bucket: string, key: string, expiresInS: number): Promise<string> {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInS });
}
