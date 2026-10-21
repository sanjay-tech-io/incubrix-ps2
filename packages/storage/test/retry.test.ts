import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { putText, verifyBucketWritable, withS3Retry } from "../src/index.ts";

const err = (status: number) => Object.assign(new Error("We encountered an internal error, please try again."), { $metadata: { httpStatusCode: status } });

/** A client whose send() fails with the listed statuses (in order) and then succeeds. */
function flaky(statuses: number[]) {
  const calls: string[] = [];
  const client = {
    send: async (cmd: { constructor: { name: string } }) => {
      calls.push(cmd.constructor.name);
      const next = statuses.shift();
      if (next !== undefined) throw err(next);
      return {};
    },
  } as unknown as S3Client;
  return { client, calls };
}

describe("storage 5xx handling (SeaweedFS answers 500 when it has no writable volume)", () => {
  it("a write that fails twice with 500 and then works succeeds", async () => {
    const { client, calls } = flaky([500, 500]);
    await putText(client, "b", "k", "x");
    expect(calls.filter((c) => c === "PutObjectCommand")).toHaveLength(3);
  });

  it("gives up after the attempt limit and throws the last error (a full store does not heal)", async () => {
    const { client, calls } = flaky([500, 500, 500, 500, 500, 500]);
    await expect(putText(client, "b", "k", "x")).rejects.toThrow(/internal error/);
    expect(calls).toHaveLength(4);
  });

  it("does not retry a 4xx", async () => {
    let n = 0;
    await expect(withS3Retry(async () => { n++; throw err(403); })).rejects.toThrow();
    expect(n).toBe(1);
  });

  it("startup check: a store that cannot write makes verifyBucketWritable fail with a clear message", async () => {
    const { client } = flaky(Array(40).fill(500));
    // HeadBucket also fails (500), CreateBucket too: ensureBucket throws first; either way the start fails loudly
    await expect(verifyBucketWritable(client, "incubrix")).rejects.toThrow();
  });

  it("startup check passes on a healthy store and leaves no probe object behind", async () => {
    const { client, calls } = flaky([]);
    await verifyBucketWritable(client, "incubrix");
    expect(calls).toEqual(["HeadBucketCommand", "PutObjectCommand", "DeleteObjectCommand"]);
  });
});
