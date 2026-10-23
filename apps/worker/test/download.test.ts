import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadUrl } from "../src/download.ts";

// URL intake of large files: the cap is enforced twice (declared size, then while reading) and the total time allowed is a setting.
let server: Server;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "dl-test-"));
const body = Buffer.alloc(300_000, 7);

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") return void res.writeHead(200, { "content-length": body.length }).end(body);
    if (req.url === "/chunked") {
      // no Content-Length: only the streaming check can stop this one
      res.writeHead(200);
      res.write(body);
      return void res.end(body);
    }
    if (req.url === "/slow") {
      res.writeHead(200, { "content-length": 10 });
      res.write("12345");
      return void setTimeout(() => res.end("67890"), 1500);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("downloadUrl", () => {
  it("downloads, hashes and counts the bytes", async () => {
    const got = await downloadUrl(`${base}/ok`, join(dir, "ok"), { maxBytes: 1_000_000, allowPrivate: true });
    expect(got.size).toBe(body.length);
    expect(got.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(readFileSync(join(dir, "ok")).length).toBe(body.length);
  });
  it("rejects a file whose declared size is above the cap, with FILE_TOO_LARGE, before reading it", async () => {
    await expect(downloadUrl(`${base}/ok`, join(dir, "a"), { maxBytes: 100_000, allowPrivate: true })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
  it("rejects a download without Content-Length that grows above the cap while reading", async () => {
    await expect(downloadUrl(`${base}/chunked`, join(dir, "b"), { maxBytes: 400_000, allowPrivate: true })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
  it("the total time allowed is the timeoutMs option (a slow body is cut, DOWNLOAD_FAILED or an abort, never a hang)", async () => {
    await expect(downloadUrl(`${base}/slow`, join(dir, "c"), { maxBytes: 1_000_000, allowPrivate: true, timeoutMs: 300 })).rejects.toBeTruthy();
    const got = await downloadUrl(`${base}/slow`, join(dir, "d"), { maxBytes: 1_000_000, allowPrivate: true, timeoutMs: 5000 });
    expect(got.size).toBe(10);
  });
});
