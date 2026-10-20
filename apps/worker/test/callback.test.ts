import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { sendCallback, signBody, verifySignature } from "../src/callback.ts";

const SECRET = "test-secret-at-least-16-chars";

describe("callback signing", () => {
  it("is sha256= plus the HMAC-SHA256 hex of the exact body, recomputed here independently", () => {
    const body = '{"job_id":"job_1","status":"succeeded"}';
    expect(signBody(SECRET, body)).toBe("sha256=" + createHmac("sha256", SECRET).update(body).digest("hex"));
    expect(verifySignature(SECRET, body, signBody(SECRET, body))).toBe(true);
    expect(verifySignature(SECRET, body + " ", signBody(SECRET, body))).toBe(false);
    expect(verifySignature("another-secret-16-chars", body, signBody(SECRET, body))).toBe(false);
  });

  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let fail = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      received.push({ headers: req.headers, body });
      res.statusCode = fail-- > 0 ? 500 : 200;
      res.end();
    });
  });
  const ready = new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  afterAll(() => void server.close());

  it("sends X-IncuBrix-Signature that the receiver can verify; retries on 5xx", async () => {
    await ready;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    fail = 1;
    const r = await sendCallback(url, { job_id: "job_1", status: "succeeded" }, SECRET, async () => undefined);
    expect(r).toMatchObject({ delivered: true, attempts: 2 });
    const last = received[received.length - 1]!;
    expect(verifySignature(SECRET, last.body, String(last.headers["x-incubrix-signature"]))).toBe(true);
    expect(JSON.parse(last.body)).toEqual({ job_id: "job_1", status: "succeeded" });
  });

  it("no secret -> no signature header; an unreachable receiver does not throw", async () => {
    await ready;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    fail = 0;
    await sendCallback(url, { a: 1 }, undefined, async () => undefined);
    expect(received[received.length - 1]!.headers["x-incubrix-signature"]).toBeUndefined();
    const dead = await sendCallback("http://127.0.0.1:9/hook", { a: 1 }, SECRET, async () => undefined);
    expect(dead.delivered).toBe(false);
    expect(dead.attempts).toBe(3);
  });
});
