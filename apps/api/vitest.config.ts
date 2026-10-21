import { defineConfig } from "vitest/config";

// The API tests run real ffmpeg (clip generation, renders) against one Postgres and one S3. Running the files side by side
// on a 4-core machine made the timing-sensitive ones exceed the default 5 s, so the files run one after the other.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 60_000, hookTimeout: 120_000 } });
