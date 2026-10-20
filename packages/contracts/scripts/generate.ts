import { writeFileSync } from "node:fs";
import { generateTimelineJsonSchema } from "../src/index";

// Writes schemas/timeline.schema.json from the zod schemas. Never edit that file by hand.
const out = new URL("../schemas/timeline.schema.json", import.meta.url);
writeFileSync(out, JSON.stringify(generateTimelineJsonSchema(), null, 2) + "\n");
console.log("wrote", out.pathname);
