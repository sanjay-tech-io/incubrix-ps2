import { CopyObjectCommand, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

// File helpers: streams, so a multi-GB original never sits in memory.
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export async function putFile(s3: S3Client, bucket: string, key: string, path: string, contentType?: string): Promise<void> {
  // A new read stream per attempt: a stream that failed half way cannot be reused.
  await withS3Retry(() => s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(path), ContentLength: statSync(path).size, ...(contentType ? { ContentType: contentType } : {}) })));
}

export async function getToFile(s3: S3Client, bucket: string, key: string, path: string): Promise<void> {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(r.Body as Readable, createWriteStream(path));
}

export async function putText(s3: S3Client, bucket: string, key: string, body: string, contentType = "application/json"): Promise<void> {
  await withS3Retry(() => s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })));
}

/** sha256 of a stored object, streamed (never held in memory). Used to prove the original did not change. */
export async function sha256OfObject(s3: S3Client, bucket: string, key: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const h = createHash("sha256");
  for await (const c of r.Body as Readable) h.update(c as Buffer);
  return h.digest("hex");
}

/** The text of an object, or null when it does not exist. */
export async function getTextOrNull(s3: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return await (r.Body as { transformToString(): Promise<string> }).transformToString();
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound" || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/** Server-side copy inside one bucket (no download). */
export async function copyObject(s3: S3Client, bucket: string, fromKey: string, toKey: string): Promise<void> {
  await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: toKey, CopySource: `${bucket}/${fromKey}` }));
}

const isServerError = (e: unknown): boolean => ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0) >= 500;

/**
 * Retry a storage call that failed with an HTTP 5xx, at most `attempts` times in total with a growing pause. 4xx (a real
 * mistake) is never retried. SeaweedFS answers 500 when it has no writable volume yet (first write into a new bucket or a
 * volume that is just growing); a short retry covers that, a full disk does not go away, so the last error is thrown.
 */
export async function withS3Retry<T>(fn: () => Promise<T>, o: { attempts?: number; baseMs?: number } = {}): Promise<T> {
  const attempts = o.attempts ?? 4;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isServerError(e)) throw e;
      await new Promise((r) => setTimeout(r, (o.baseMs ?? 250) * 2 ** (i - 1)));
    }
  }
}

/**
 * Startup check: the bucket exists AND accepts a write (put + delete of a probe object). Fails with a message that says what
 * was tried, so a full or broken store is found when the service starts, not at the first user upload.
 */
export async function verifyBucketWritable(s3: S3Client, bucket: string): Promise<void> {
  await ensureBucket(s3, bucket);
  const key = ".probe/startup-check";
  try {
    await withS3Retry(() => s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "ok" })));
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    throw new Error(`storage bucket "${bucket}" is not writable: ${(e as Error).message}`);
  }
}
