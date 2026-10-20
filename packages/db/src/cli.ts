import { loadConfig } from "@incubrix/config";
import { migrate } from "./index.ts";

const { applied } = await migrate(loadConfig(process.env).DATABASE_URL);
console.log(JSON.stringify({ level: "info", msg: "migrations done", applied }));
