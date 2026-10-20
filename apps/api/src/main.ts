// PLACEHOLDER (api): validates config, connects to Postgres and answers /health and /ready.
// The real api arrives in milestone M2.
import http from "node:http";
import pg from "pg";
import { loadConfig } from "@incubrix/config";

const cfg = loadConfig(process.env);
const port = Number(process.env.API_PORT ?? 8080);
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 2 });
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", service: "api", msg, ...extra }));

http
  .createServer(async (req, res) => {
    const send = (code: number, body: object) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
    if (req.url === "/health") return send(200, { status: "ok", service: "api" });
    if (req.url === "/ready") {
      try {
        await pool.query("select 1");
        return send(200, { status: "ready", service: "api" });
      } catch {
        return send(503, { status: "not_ready", service: "api" });
      }
    }
    send(404, { error: { code: "NOT_FOUND", message: "placeholder service", retryable: false, details: {} } });
  })
  .listen(port, () => log("listening", { port, placeholder: true }));
