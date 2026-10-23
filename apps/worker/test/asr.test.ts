import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpAsrClient } from "../src/asr.ts";

// The ASR call can take many minutes on a long video or a busy VM. Node's fetch cuts any request whose response headers take
// longer than 5 minutes (UND_ERR_HEADERS_TIMEOUT, whatever AbortSignal says: docs/raw/m5d_fetch_headers_timeout.txt), so the
// client uses node:http and only the configured ASR_TIMEOUT_S applies.
let server: Server;
let base = "";
let lastQuery = "";
let lastContentType = "";
let lastBytes = 0;
const reply = { words: [{ text: "hi", start_us: 0, end_us: 400000, confidence_permille: 900 }], adapter: "mock", model: "m", settings: { diarization: { speakers_found: 2 } }, timings: { transcribe_s: 1.5 } };

beforeAll(async () => {
  server = createServer((req, res) => {
    lastQuery = req.url ?? "";
    lastContentType = String(req.headers["content-type"] ?? "");
    let n = 0;
    req.on("data", (c: Buffer) => (n += c.length));
    req.on("end", () => {
      lastBytes = n;
      if (lastQuery.startsWith("/slow")) return void setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply)), 2500);
      if (lastQuery.startsWith("/boom")) return void res.writeHead(500).end("broken");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const client = (url: string, timeoutS: number) => new HttpAsrClient({ url, provider: "faster-whisper", model: "base.en", diarizationProvider: "sherpa", timeoutS });

describe("HttpAsrClient", () => {
  it("posts the audio as multipart with the diarize and num_speakers query and parses the answer", async () => {
    const r = await client(base, 30).transcribe(new Uint8Array(1000).fill(1), { numSpeakers: 2 });
    expect(lastQuery).toBe("/transcribe?diarize=true&num_speakers=2");
    expect(lastContentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(lastBytes).toBeGreaterThan(1000);
    expect(r.words).toHaveLength(1);
    expect(r.speakersFound).toBe(2);
    expect(r.serviceSeconds).toBe(1.5);
  });
  it("a service that answers HTTP 500 is ASR_UNAVAILABLE with the status", async () => {
    await expect(client(base + "/boom", 30).transcribe(new Uint8Array(10), { numSpeakers: null })).rejects.toMatchObject({ code: "ASR_UNAVAILABLE", message: expect.stringMatching(/HTTP 500/) });
  });
  it("a service that is not there is ASR_UNAVAILABLE", async () => {
    await expect(client("http://127.0.0.1:9", 30).transcribe(new Uint8Array(10), { numSpeakers: null })).rejects.toMatchObject({ code: "ASR_UNAVAILABLE" });
  });
  it("only ASR_TIMEOUT_S limits the wait: a 2.5 s answer is cut by a 1 s timeout and accepted by a 30 s one", async () => {
    await expect(client(base + "/slow", 1).transcribe(new Uint8Array(10), { numSpeakers: null })).rejects.toMatchObject({ code: "ASR_UNAVAILABLE", message: expect.stringMatching(/timed out|did not answer/) });
    const ok = await client(base + "/slow", 30).transcribe(new Uint8Array(10), { numSpeakers: null });
    expect(ok.words).toHaveLength(1);
  });
});
