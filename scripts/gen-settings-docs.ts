// Regenerates the settings table in README.md from .env.example (packages/config/src/envdoc.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { renderSettings } from "@incubrix/config";

const readme = new URL("../README.md", import.meta.url);
const env = new URL("../.env.example", import.meta.url);
writeFileSync(readme, renderSettings(readFileSync(readme, "utf8"), readFileSync(env, "utf8")));
console.log("README.md settings table updated");
