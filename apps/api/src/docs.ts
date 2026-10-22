import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";

// Swagger UI for openapi.yaml (M7, deployed in M6a). Assets come from the swagger-ui-dist package (Apache-2.0, SOURCES.md).
// Why hand-written routes and not @fastify/swagger-ui: the spec is the committed openapi.yaml, served byte for byte,
// and a fixed allow-list of three asset files cannot be turned into a file server by a crafted path.

const ASSETS: Record<string, string> = {
  "swagger-ui-bundle.js": "application/javascript; charset=utf-8",
  "swagger-ui.css": "text/css; charset=utf-8",
  "favicon-32x32.png": "image/png",
};

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>IncuBrix API</title><link rel="stylesheet" href="/docs/swagger-ui.css"><link rel="icon" href="/docs/favicon-32x32.png"></head>
<body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script><script src="/docs/init.js"></script></body></html>`;

// "Try it out" needs the token: the Authorize button takes it. It is kept in the page only (persistAuthorization false).
const INIT = `window.ui = SwaggerUIBundle({ url: "/openapi.yaml", dom_id: "#swagger-ui", persistAuthorization: false, tryItOutEnabled: true });`;

/** Public routes (no token): the documentation itself is not secret; every API call made from it still needs the token. */
export function registerDocs(app: FastifyInstance, openapiPath: URL): void {
  const dist = dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));
  const files = new Map(Object.entries(ASSETS).map(([name, type]) => [name, { type, body: readFileSync(join(dist, name)) }]));
  const yaml = readFileSync(openapiPath);

  app.get("/docs", async (_req, reply) => reply.type("text/html; charset=utf-8").send(PAGE));
  app.get("/docs/init.js", async (_req, reply) => reply.type("application/javascript; charset=utf-8").send(INIT));
  app.get<{ Params: { name: string } }>("/docs/:name", async (req, reply) => {
    const f = files.get(req.params.name);
    if (!f) return reply.callNotFound();
    return reply.type(f.type).header("Cache-Control", "public, max-age=3600").send(f.body);
  });
  app.get("/openapi.yaml", async (_req, reply) => reply.type("application/yaml; charset=utf-8").send(yaml));
}

/** Paths served without a token and not part of the contract-tested API. */
export const DOC_PATHS = new Set(["/docs", "/docs/init.js", "/openapi.yaml"]);
export const isDocPath = (path: string): boolean => DOC_PATHS.has(path) || path.startsWith("/docs/");
