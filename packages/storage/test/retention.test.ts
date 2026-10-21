import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { isExpirable, sweepExpired } from "../src/index.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 21);

function fake(objects: Record<string, number>) {
  const deleted: string[] = [];
  const client = {
    send: async (cmd: { constructor: { name: string }; input: { Prefix?: string; Key?: string } }) => {
      if (cmd.constructor.name === "ListObjectsV2Command") {
        return { Contents: Object.entries(objects).filter(([k]) => k.startsWith(cmd.input.Prefix ?? "")).map(([Key, t]) => ({ Key, LastModified: new Date(t) })), IsTruncated: false };
      }
      deleted.push(cmd.input.Key!);
      return {};
    },
  } as unknown as S3Client;
  return { client, deleted };
}

describe("retention", () => {
  it("only renders and proxies are expirable, never an original or a transcript", () => {
    expect(isExpirable("renders/job_1/output.mp4")).toBe(true);
    expect(isExpirable("renders/job_1/render_manifest.json")).toBe(true);
    expect(isExpirable("videos/vid_1/proxy_cfr_30-1_v1.mp4")).toBe(true);
    expect(isExpirable("videos/vid_1/proxy_cfr_30-1_v1.json")).toBe(true);
    expect(isExpirable("videos/vid_1/original.mp4")).toBe(false);
    expect(isExpirable("videos/vid_1/original.mov")).toBe(false);
    expect(isExpirable("assets/music/abc")).toBe(false);
  });

  it("deletes only expirable objects that are older than the limit; originals of any age stay", async () => {
    const { client, deleted } = fake({
      "renders/old/output.mp4": NOW - 20 * DAY,
      "renders/new/output.mp4": NOW - 1 * DAY,
      "videos/a/original.mp4": NOW - 400 * DAY,
      "videos/a/proxy_cfr_30-1_v1.mp4": NOW - 20 * DAY,
      "videos/b/proxy_cfr_30-1_v1.mp4": NOW - 2 * DAY,
    });
    const gone = await sweepExpired(client, "b", { prefixes: ["renders/", "videos/"], olderThanMs: 14 * DAY, now: NOW, shouldDelete: isExpirable });
    expect(gone.sort()).toEqual(["renders/old/output.mp4", "videos/a/proxy_cfr_30-1_v1.mp4"]);
    expect(deleted.sort()).toEqual(gone.sort());
  });
});
