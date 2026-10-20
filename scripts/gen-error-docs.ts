// Regenerates the error table in README.md from packages/errors.
import { readFileSync, writeFileSync } from "node:fs";
import { renderReadme } from "@incubrix/errors";

const path = new URL("../README.md", import.meta.url);
writeFileSync(path, renderReadme(readFileSync(path, "utf8")));
console.log("README.md error table updated");
