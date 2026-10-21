import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../src/index.ts";

const KEY = "AIza-test-key-should-never-appear-anywhere";

function server(handler: (req: http.IncomingMessage, body: string) => { status: number; body: unknown }) {
  const seen: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const s = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: b ? JSON.parse(b) : null });
      const r = handler(req, b);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => void }>((resolve) => s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen, close: () => s.close() })));
}

describe("GeminiProvider (against a local fake server, no network)", () => {
  it("sends the key in a header (never the URL), temperature 0 and JSON output; reads text and token counts", async () => {
    const srv = await server(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: '{"commands":[{"op":"undo"}]}' }] } }], usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 12, thoughtsTokenCount: 8 } } }));
    const p = new GeminiProvider({ apiKey: KEY, model: "gemini-test", baseUrl: srv.url });
    const r = await p.complete({ system: "S", user: "U" });
    srv.close();
    expect(r).toMatchObject({ text: '{"commands":[{"op":"undo"}]}', inputTokens: 321, outputTokens: 20 });
    const q = srv.seen[0]!;
    expect(q.url).toBe("/models/gemini-test:generateContent");
    expect(q.url).not.toContain(KEY);
    expect(q.headers["x-goog-api-key"]).toBe(KEY);
    expect(q.body.generationConfig).toMatchObject({ temperature: 0, responseMimeType: "application/json" });
  });

  it("an error from the service never carries the key, even when the service echoes it back", async () => {
    const srv = await server(() => ({ status: 403, body: { error: { message: `API key ${KEY} is not valid` } } }));
    const p = new GeminiProvider({ apiKey: KEY, model: "m", baseUrl: srv.url });
    const err = await p.complete({ system: "S", user: "U" }).catch((e: Error) => e);
    srv.close();
    expect((err as Error).message).toMatch(/HTTP 403/);
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).toContain("<redacted>");
  });

  it("a connection failure message does not contain the key either", async () => {
    const p = new GeminiProvider({ apiKey: KEY, model: "m", baseUrl: "http://127.0.0.1:1" });
    const err = await p.complete({ system: "S", user: "U" }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(KEY);
  });
});
