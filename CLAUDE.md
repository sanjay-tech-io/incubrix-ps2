# IncuBrix Assessment 2: Prompt-Based Video Editing Engine

Goal: pass every must-have, verify the Core, Advanced and Outstanding levels, and follow all 10 Integration Standard points. Full checklist: docs/REQUIREMENTS.md (read the relevant section before starting each milestone). The brief says one false claim disqualifies, so never claim anything we have not run.

## Stack (fixed; ask before changing)
- Monorepo, npm workspaces, Node 20, TypeScript strict everywhere.
- packages/engine: pure deterministic core (timeline, operations, replay, hash, time mapping, search, filler/silence logic).
- apps/api: Fastify 5 + zod. apps/worker: pg-boss jobs (ingest, transcribe, render, export).
- No custom UI. The API serves Swagger UI/Redoc generated from openapi.yaml (decision, see Decisions).
- services/asr: Python FastAPI + faster-whisper (CPU, int8). Adapters: mock (fixture transcripts) and faster-whisper.
- Postgres 16 via DATABASE_URL (plain SQL migrations, `pg`). No Supabase SDK/Auth/Storage/Realtime. A Supabase Postgres URL may be used as DATABASE_URL for the demo only.
- S3-compatible storage via @aws-sdk/client-s3 (MinIO in docker-compose). ffmpeg/ffprobe for all media.
- Logging: pino JSON. Tests: vitest plus scripted session scenarios plus a compose end-to-end test.

## Core architecture (never violate)
1. The source file is never modified; store its sha256. Rendering is a separate step from editing.
2. The source is a sequence of atoms (words and silence gaps) with stable IDs covering the full duration. Effects (captions, mutes, bleeps) anchor to atom ID ranges, never seconds.
3. Edits are an append-only operation log. timeline = replay(log). One instruction = one undo group. A new edit clears redo. "Restore edit N" is a new op that references N.
4. Engine time is integer microseconds. Frame conversion happens only in the renderer with rational fps. Cut points snap to frame boundaries.
5. packages/engine has NO LLM, network, fs, Date, Math.random or process access (enforce with ESLint no-restricted-globals/imports). IDs derive from content or counters.
6. timeline_hash = sha256 of canonical JSON (sorted keys) of the materialized timeline, excluding anything time-of-day dependent.
7. The LLM only translates text into a structured operation list validated by zod. Invalid output becomes needs_clarification or rejected, never a guess. Order: rule-based parser first, LLM only as fallback, temperature 0, cache by hash of (model, prompt, relevant state). Adapters: rules, mock, groq, gemini.
8. Time policy: times in instructions refer to the CURRENT edited timeline, unless the user says "original". Every answer states which policy was used.
9. Never guess on anything destructive: ambiguous destructive instructions return needs_clarification with specific options.

## Answer contract (every instruction, exactly one of three)
{ status: applied|needs_clarification|rejected, operations, summary (before/after length, what moved), question, options, reason, time_policy, warnings[], timeline_hash, duration_s }
Rejected covers impossible, out of range, or contradicts an earlier edit (name which one). Rejection is a normal 200 answer, not an HTTP error.

## API (all under /api/v1; openapi.yaml is the source of truth and is contract-tested against the running service)
POST /sessions (upload or URL, returns 202 job), POST /sessions/{id}/instructions (synchronous answer), GET /sessions/{id}/timeline, GET /sessions/{id}/history, POST /sessions/{id}/render (202 job), GET /jobs/{job_id}, GET /health, GET /ready.
Every POST accepts Idempotency-Key. Same key + same body returns the same result and never repeats work. Same key + different body returns 409 IDEMPOTENCY_KEY_REUSED.
Errors: {"error":{"code","message","retryable","details"}}, UPPER_SNAKE_CASE, all listed in README. Jobs: queued|running|succeeded|failed, progress 0-100, result links, optional callback_url signed HMAC-SHA256 in X-IncuBrix-Signature.

## Engineering rules
- Test first, then code. Run `npm test` before every commit. Small commits with clear messages (real history is graded).
- Every external service sits behind an adapter selected by env config, with a mock. All tests run with no keys and no network.
- All settings come from env, validated by zod at startup; .env.example lists every one. No secrets in code, logs, repo or screenshots; redact tokens in logs.
- Logs: JSON with timestamp, level, job_id, correlation_id (generate X-Correlation-Id if missing and echo it).
- Every result ships a manifest: providers/models + versions, settings, seed, timings, cost estimate, warnings, licence/rights, AI-generated flags.
- Only use media we own, CC0/public-domain, or with written consent. Record every source in SOURCES.md; record every AI tool use in AI_USE.md.
- Never invent numbers. Metrics, latencies and screenshots must come from real runs saved under test-pack/.
- Prefer clear code I can explain live over clever code. Comment the why of each design decision.

## Build order (do not gold-plate; finish each milestone before the next)
M1 engine core + the 8-step worked example as tests. M2 API, jobs, idempotency, errors, health, manifest, compose. M3 ASR adapter + ffmpeg render + A/V sync tests. M4 Advanced level items. M5 Outstanding items (snapping, low confidence, OTIO export, scale, 40+ CI scenarios). M6 deploy demo, session pack, metrics, docs, demo video. M7 serve Swagger UI/Redoc from openapi.yaml.

## Commands
npm test | npm run test:e2e | docker compose up | npm run session -- <file.yaml> | npm run batch -- <dir> | npm run metrics

## Amendments
- Use Node 22. Add `docker compose run tests` as the single test command (unit + integration + e2e, no keys).
- Transcript and atoms are cached by source sha256; atom IDs derive from that hash plus content. No timestamps, session IDs or random UUIDs in the timeline or hash.
- Diarization sits behind an adapter with a mock. Speaker is stored per atom.
- Logged operations store resolved atom-ID ranges, never seconds.
- Keep a separate conversation log (text, answer, status, pending question). Clarification turns do not change the timeline hash and are not undo groups.
- Cut rule: cut exactly if inside a silence atom; if inside a word, snap to nearby silence and warn.
- Instruction responses must be fast (<2 s). The LLM fallback has a short timeout and falls back to needs_clarification.
- Scale test uses synthetic data and is labelled as such.
## Decisions
- Node 22 everywhere.
- The live demo uses REAL ASR (faster-whisper) and REAL diarization by default, as background jobs with progress, because hidden tests will likely use videos we have never seen. Mocks are for tests only. Env switches: ASR_PROVIDER, DIARIZATION_PROVIDER, LLM_PROVIDER.
- The session runner accepts a video as URL, local path or upload.
- Speed changes are limited to a documented range: MAX_SPEED env (default 4x), minimum 0.25x. Beyond it the instruction is rejected with the reason and the allowed range. The engine receives the limits as a parameter (it cannot read env).
- Logged operations store resolved atom-ID ranges (plus an in-atom offset only inside silence atoms), never seconds.
- Separate conversation log. Clarification turns do not change the timeline hash.
- Cut rule: cut exactly if inside a silence atom; if inside a word, snap to nearby silence and warn.
- M7 is NOT a React UI. It is serving Swagger UI/Redoc from openapi.yaml; there is no apps/web.
- Cursors: a cursor is (atomId, offsetUs) with 0 <= offsetUs < atom length. A non-zero offset is allowed only inside silence atoms and must sit on the frame grid (source fps as an integer rational). SUPERSEDED in M1b: source-side cut boundaries must lie on the frame grid everywhere. A boundary between a silence and a word moves INTO the silence (floor when the silence is before the word, ceil when after), never into the word. Only a boundary between two touching words (or a silence too short to hold a grid point) stays off-grid, and the cut-rule warning says so. The end of the source is (last atom, its length), allowed only as an END cursor. Tests reject invalid cursors.
- Partial cut of a captioned phrase: the caption keeps its literal text on the surviving words and the answer lists the cut words. If ALL anchor words are cut, the effect becomes inactive in the materialized timeline but is NEVER deleted from the log; the answer says so, and restoring the words reactivates it.
- Captions and text overlays have a 0.7 s minimum visible duration after speed changes; the answer warns when one is extended. Auto-caption text is derived from surviving words.
- Effect ids are fx_<n>_<k> where n counts edit operations only (not conversation turns, not undo/redo markers). Two different histories that look identical may therefore hash differently; the same history always hashes the same.
- Overlapping speech is a flag on the word, not overlapping atoms. Atoms also carry speakerUncertain. Any operation touching a low-confidence, overlapping or speaker-uncertain word returns a warning.
- crypto is banned in the engine. SHA-256 comes from @noble/hashes (pure JS, MIT), listed in SOURCES.md. Canonical JSON throws on floats, NaN and undefined; music gain is stored as integer centi-dB.
- Speed overlap rule: the later change wins on the overlap and REPLACES the earlier rate (rates never multiply); 1x clears. Rates are stored in lowest terms. Speed regions are kept in source coordinates and clipped to surviving segments.
- Restore: "restore edit N" is a new op (targetGroup N). Replay skips group N while a restore that is itself in effect points at it. The log is never rewritten; restoring a restore brings the original edit back.
- Output frames (M1b, replaces the per-piece microsecond rounding): frames_k = round(exact cumulative output frames) - round(previous cumulative), exact with BigInt fractions, so the total equals round(total) and each piece is within 1 frame. A source time on the grid counts as an exact frame. Without an fps the same rule runs in microseconds.
- Parsing instructions is NOT part of M1; M1 tests build structured operations directly using pure engine helpers (phrase search, topic search, time resolution).
- Reorder (move) is not implemented in M1; it throws NOT_IMPLEMENTED and is planned for M4.
- docs/STATUS.md is the project memory: updated and committed at the end of every milestone.
- packages/contracts holds the zod schemas for atoms, operations, the log, the timeline, answers and the session document. They are the single source of truth: the engine's types are inferred from them and packages/contracts/schemas/timeline.schema.json is GENERATED (`npm run generate -w @incubrix/contracts`); a test fails if the committed file differs.
- .npmrc pins registry=https://registry.npmjs.org/ so a developer's user-level mirror never leaks into package-lock.json (it once did: 208 npmmirror URLs).
- Performance design: logs, timelines, pieces and hashes are immutable values, so analyses, raw states, timelines, pieces and hashes are memoized by object identity. submitOperations validates once, then primes the cache with "previous state + this group" (never when the instruction contains a restore). Segment and speed lists are sorted and disjoint and searched by binary search; this relies on output order == source order and MUST be revisited when reorder (move) is implemented. A property test checks the cached session path equals a replay on a brand-new engine.
- Targets (M1b): any instruction < 300 ms and a 4,000-op instruction < 1 s on a synthetic 60-minute / 24,000-atom source. Measured numbers live in docs/PERF_ENGINE.md (from `npm run bench -w @incubrix/engine`).
- `npm run mutation-check` breaks the engine one way at a time and requires the suite to fail. Add a mutant whenever a reviewer finds a surviving one.
