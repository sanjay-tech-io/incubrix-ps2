# M2 API design (one page, for approval)

Nothing below is built yet. Stack per CLAUDE.md: Fastify 5 + zod, `pg`, SeaweedFS via `packages/storage`, engine untouched.

## Routes (all under `/api/v1`, plus `/health` and `/ready` at the root)
| Route | Meaning | Reply |
|---|---|---|
| `POST /videos` | Multipart upload (`file`) or JSON `{url}` (MP4/MOV), optional `num_speakers`, `callback_url` | 202 `{video_id, job_id}` |
| `GET /videos/{id}` | Probe facts, sha256, warnings (no audio, VFR) | 200 |
| `POST /sessions` | `{video_id}`; only when the video's transcription job succeeded | 201 session |
| `POST /sessions/{id}/instructions` | `{say, answer?}` | 200: always one of applied / needs_clarification / rejected |
| `GET /sessions/{id}/timeline` · `/history` (operation log) · `/conversation` | Read models | 200 |
| `POST /sessions/{id}/render` | Stub in M2 (render is M3): returns 501 `NOT_IMPLEMENTED` and is listed in openapi | |
| `GET /jobs/{job_id}` | `status` queued/running/succeeded/failed, `progress` 0-100, result links, error | 200 |

Every POST accepts `Idempotency-Key`. Errors are always `{"error":{code,message,retryable,details}}`; the code list lives in one file (`packages/errors`) and the README table is generated from it by a script, with a test that fails if README is stale. `openapi.yaml` is written first; a test compares the routes Fastify registers with the paths in the file, both ways. Rejection of an instruction is a normal 200 answer, not an HTTP error.

## Job flow
1. API stores the request, inserts a `jobs` row (`queued`), returns 202 (anything that can exceed 2 s is a job; instructions are synchronous).
2. `apps/worker` loops: in one transaction `select ... from jobs where status='queued' order by created_at for update skip locked limit 1`, sets `running`, commits, then works and updates `progress`/`result`. A job stuck `running` after a crash is re-queued after `JOB_STALE_S`. No queue library (the table already does what we need and two workers cannot take the same row).
3. **Intake job** (`ingest`+`transcribe` as one job with stages, progress 0-100): stream the original into S3 untouched and compute sha256 → ffprobe (duration, exact fps fraction, audio present, VFR) → extract 16 kHz mono wav → call the ASR service (real faster-whisper + sherpa diarization, `num_speakers` hint) → silence detection + word clamping (`packages/media`) → `buildAtoms` → store atoms. Atoms are cached by source sha256 + provider settings, so the same file is never transcribed twice. No audio: video rejected with `NO_AUDIO_TRACK`. VFR: accepted with a warning in the manifest (frame-exact claims do not hold) - tell me if you would rather reject it.
4. On success/failure, if `callback_url` was given, the worker POSTs the job JSON with `X-IncuBrix-Signature: sha256=<hmac>` (secret `CALLBACK_HMAC_SECRET`); a test recomputes the signature.

## Tables
Existing: `sessions`, `source_assets`, `operation_log` (append-only), `conversation_log`, `idempotency_keys`, `jobs`, `llm_cache`.
**One new migration `0002`** (needs your OK): `videos` (id, sha256, storage_key, size, probe jsonb, status, warnings, rights) and `transcripts` (source_sha256 + settings key → atoms jsonb, words, manifest), plus `jobs.video_id` (an intake job has no session yet) and `operation_log.kind` for undo/redo markers (undo/redo rows have no op; I store `{}` there). No existing column changes meaning.

## How an instruction reaches the engine
`POST .../instructions` → load the session (cache in memory by id; on a miss, rebuild by loading atoms + `operation_log` + `conversation_log` and replaying) → **parser** (new `packages/nlu`, interface `LLM_PROVIDER = rules | mock`, a real provider is left as a stub interface only) turns text into a structured request using engine helpers (`resolveEditedRange`, `phraseRanges`, `planRemoveFillers` ...) → the engine call `submitPlan` / `submitOperations` / `submitUndo` / `askClarification` / `submitRejection` → the new log entries and conversation turn are written in one Postgres transaction → the engine `Answer` is mapped to snake_case (`time_policy`, `timeline_hash`, `duration_s`) and returned with the manifest. The parser never decides timeline logic; if it cannot be sure of a destructive meaning it asks (`needs_clarification`) or rejects. A restart test replays from Postgres and checks the same `timeline_hash`. Requests for one session are serialized (advisory lock on the session id).

## Cross-cutting
Pino JSON logs with `timestamp, level, job_id, correlation_id` (`X-Correlation-Id` generated if missing and echoed). `API_TOKEN` env = bearer token on everything except `/health` and `/ready`; simple per-token+IP in-memory rate limit (`RATE_LIMIT_PER_MIN`), 429 `RATE_LIMITED`. Manifest (providers+versions, settings, seed, timings, CPU-time cost estimate, warnings, rights from the source asset row) on every job result and instruction answer. URL intake: http(s) only, private/loopback addresses blocked, size capped (`MAX_UPLOAD_MB`), redirects limited.

## Compose defaults
Real providers by default (`ASR_PROVIDER=faster-whisper`, `DIARIZATION_PROVIDER=sherpa`), `/models` as a named volume; the `tests` service overrides to mock. The ASR service's own env names (`ASR_ADAPTER`, `DIARIZATION_PROVIDER`) will be wired from the same compose variables so there is one switch. Cold start time will be measured and reported, not estimated.

## Decisions I need from you
1. OK for migration `0002` (above)?
2. VFR: accept with warning (my default) or reject?
3. Render route as a documented 501 stub until M3: OK?
4. `packages/nlu` and `packages/errors` as new workspace packages: OK?
