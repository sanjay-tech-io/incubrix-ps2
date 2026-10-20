import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Why: the parser must be a pure function of (text, session state), the same as the engine. Anything that
// reads the clock, randomness, disk, network or environment would break the
// "same session => same timeline_hash" guarantee (CLAUDE.md rule 5).
const forbiddenGlobals = ["Date", "process", "fetch", "XMLHttpRequest", "WebSocket", "performance", "require", "Buffer", "setTimeout", "setInterval", "crypto"].map(
  (name) => ({ name, message: `Forbidden in packages/nlu: ${name} makes the engine non-deterministic or impure.` }),
);

const forbiddenModules = ["fs", "fs/promises", "http", "https", "http2", "net", "tls", "dgram", "dns", "child_process", "worker_threads", "os", "path", "crypto", "undici", "axios", "node-fetch"];

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", ...forbiddenGlobals],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Forbidden in packages/nlu: use content-derived IDs or counters." },
        { object: "globalThis", property: "Date", message: "Forbidden in packages/nlu." },
        { object: "globalThis", property: "process", message: "Forbidden in packages/nlu." },
      ],
      "no-restricted-imports": [
        "error",
        { paths: forbiddenModules.flatMap((m) => [{ name: m, message: "Forbidden in packages/nlu." }, { name: `node:${m}`, message: "Forbidden in packages/nlu." }]) },
      ],
    },
  },
);
