# IncuBrix: prompt-based video editing engine

Upload a video, then edit it by typing plain sentences ("cut the first 30 seconds", "add a caption \"Welcome!\" on \"welcome to the channel\"", "remove the part about pricing"). The original file is never changed: every edit is a step in an append-only history over the untouched source, and a separate render step produces the MP4.

* **Three-way answers.** Every instruction gets exactly one of `applied`, `needs_clarification` (with specific options; nothing changes until you choose) or `rejected` (impossible, out of range, or it contradicts an earlier edit; a normal HTTP 200 answer, not an error). Every answer states its **time policy**: times mean the *current edited timeline* unless you say "of the original".
* **Edits stick to words.** The source is a sequence of word and silence atoms with stable ids; captions, mutes and bleeps anchor to atom ranges, never to seconds, so they stay on their words through cuts, speed changes, reorders, undo and restore.
* **Predictable.** `timeline = replay(log)`; the same session gives the same `timeline_hash` every time. The language model (optional, Gemini) only *translates* a sentence the rules parser cannot read into a closed list of commands that our own code validates and applies; with no key it is simply off.
* **Operations:** cut, keep only, reorder, speed up / slow down (0.25x to `MAX_SPEED`), mute, bleep, captions and text (colour, size, bold, position), auto-captions, remove fillers (um, uh, "like" only as a filler), remove silences longer than N seconds (deliberate pauses can be protected), background music that ducks under speech, undo / redo, restore a specific earlier edit, meaning-based search ("pricing" finds "cost"), speaker-aware edits ("remove everything the guest says about their old job"), and **OpenTimelineIO export**.
* **Warnings, not guesses.** Low-confidence words, overlapping speech, uncertain speaker labels and *possible speaker-label swaps* (a turn whose voice sounds more like the other speaker) are flagged, and any edit that touches them says so.

What is verified and what is not: [`docs/STATUS.md`](docs/STATUS.md) (claims ledger), [`docs/REVIEW_M5.md`](docs/REVIEW_M5.md) (latest milestone). Design: [`docs/DESIGN.md`](docs/DESIGN.md), [`docs/API_DESIGN.md`](docs/API_DESIGN.md), [`docs/RENDER_DESIGN.md`](docs/RENDER_DESIGN.md).

## Live demo

* API and Swagger UI: **https://34.93.140.79.sslip.io** (docs at [`/docs`](https://34.93.140.79.sslip.io/docs), spec at `/openapi.yaml`, `/health` and `/ready` are open). The same site also answers on `https://34-93-140-79.sslip.io`.
* Everything except health and docs needs the access token: `Authorization: Bearer <token>`. **The token is given on request**; in Swagger UI press *Authorize* and paste it.
* One small VM with limits (2 GB upload, 300 s video, one render and one transcription at a time, rate limit per IP). What was checked, what was not, how to restart it and what it costs: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Architecture

```mermaid
flowchart LR
  user([client / session runner]) -->|HTTPS| caddy[Caddy: TLS, only ports 80/443]
  caddy -->|/api/v1, /docs| api[API: Fastify + zod]
  caddy -->|GET /bucket/...| s3[(S3-compatible store: SeaweedFS)]
  api <--> pg[(Postgres 16: sessions, operation log, jobs, transcripts)]
  api -->|presigned links| s3
  api --> engine{{engine: pure TypeScript, no clock, no network, no randomness}}
  api -->|rules parser first| nlu[nlu: rules parser]
  nlu -.->|only if the rules cannot read it, closed command list| llm[Gemini fallback, optional]
  api -->|export| otio[OTIO service: OpenTimelineIO library]
  api -->|enqueue jobs| pg
  worker[Worker: pg jobs] <--> pg
  worker --> s3
  worker -->|audio| asr[ASR service: faster-whisper, sherpa-onnx diarization, label-swap check, MiniLM embeddings]
  worker --> ffmpeg[[ffmpeg / ffprobe: probe, silence, one-pass render]]
```

* **packages/engine**: timeline, operations, replay, hashing, time mapping, search, filler / silence logic. Pure and deterministic (ESLint forbids clock, random, fs, network, env in it). Time is integer microseconds; frame conversion happens only in the renderer.
* **apps/api**: all routes under `/api/v1`, `openapi.yaml` is the contract (a test compares it with the running routes both ways), idempotency keys on every POST, JSON errors, JSON logs with a correlation id, manifest on every result.
* **apps/worker**: background jobs with progress: intake (store the original, probe, transcribe, diarize, silence, atoms) and render (one ffmpeg run, verified with ffprobe against the timeline).
* **services/asr** (Python): faster-whisper + sherpa-onnx diarization + speaker-label-swap check + sentence embeddings, each behind an adapter with a mock. **services/otio** (Python): writes `.otio` files with the OpenTimelineIO library.
* Postgres via plain SQL migrations; S3-compatible storage via the AWS SDK; no Supabase SDK, no custom UI (Swagger UI is generated from `openapi.yaml`).

## Setup (under 10 commands)

Needs Docker with Compose v2 (and Node 22 only for the session runner).

```
git clone <this repo>
cd incubrix-ps2
cp .env.example .env                       # optional: add GEMINI_API_KEY to enable the language-model fallback
docker compose up -d --build               # first build downloads the speech models into the images (several minutes)
curl http://localhost:8080/ready           # {"status":"ready","service":"api"}; Swagger UI: http://localhost:8080/docs
npm ci                                     # for the session runner only
mkdir -p media && sh scripts/make_smoke_clip.sh media/m6a_smoke.mp4     # a 15 s generated test video (espeak-ng + ffmpeg)
npm run session -- sessions/m6a_smoke.yaml --out out/smoke              # uploads it, edits, renders, downloads (out/smoke/render_1.mp4)
```

With the default `.env.example` the API is **open** (no token) and the real speech models are used (`ASR_PROVIDER=faster-whisper`, `DIARIZATION_PROVIDER=sherpa`). Production refuses to start without `API_TOKEN` and without non-default S3 and database secrets (`compose.prod.yml`, `docs/DEPLOY.md`).

By hand with curl:

```
export API=http://localhost:8080          # add -H "Authorization: Bearer $API_TOKEN" when API_TOKEN is set
curl -F file=@media/m6a_smoke.mp4 $API/api/v1/videos                  # 202 {video_id, job_id, status_url}
curl $API/api/v1/jobs/<job_id>                                         # queued|running|succeeded|failed, progress 0-100
curl -H 'content-type: application/json' -d '{"video_id":"<video_id>"}' $API/api/v1/sessions
curl -H 'content-type: application/json' -d '{"say":"cut the first 5 seconds"}' $API/api/v1/sessions/<session_id>/instructions
curl -X POST $API/api/v1/sessions/<session_id>/render                  # 202 {job_id}; poll it, then download links.video and links.manifest
curl -D- $API/api/v1/sessions/<session_id>/export/otio -o edit.otio    # the .otio file; the S3 link is in the X-IncuBrix-Export-Url header
```

Every POST accepts `Idempotency-Key` (same key and body returns the same result without repeating work; same key with a different body is `409 IDEMPOTENCY_KEY_REUSED`). Jobs accept an optional `callback_url`, signed with HMAC-SHA256 in `X-IncuBrix-Signature`. Routes: [`openapi.yaml`](openapi.yaml).

## Tests

```
docker compose run --rm tests              # EVERYTHING, no keys, no network: unit + integration + the 48 scenarios. Runs on its OWN throwaway Postgres, S3 and OTIO service (the *-test services, own network): it never touches a running stack. `scripts/test.sh` = the same command, then removes those test containers.
npm test -w @incubrix/engine               # engine only, no Docker (any workspace: -w @incubrix/<name>)
npm run typecheck
npm run mutation-check                     # breaks the engine in 40 ways, one at a time; the suite must fail each time
npm run bench -w @incubrix/engine          # engine speed on a synthetic 60-minute source (docs/PERF_ENGINE.md)
```

* `docker compose run --rm tests` runs: engine, contracts, config, db, store, storage, media, render (real ffmpeg, A/V sync and length checks), nlu, llm, semantic, otio, api, worker, cli, plus the Python tests of `services/asr` and `services/otio` (the exported files are read back with the OpenTimelineIO library). All providers are mocks.
* **Scenario pack**: `scenarios/*.yaml` are 48 scripted sessions, each step with an expected result (`applied` / `needs_clarification` / `rejected`, and where it matters the length, a warning, the number of options or an unchanged `timeline_hash`). They cover the worked example and the hard cases of the brief and run through the same HTTP session runner against the real API, worker, database, storage and ffmpeg with a mock transcript. They run inside the command above; GitHub Actions runs that single command on every push (`.github/workflows/ci.yml`).
* `sessions/*.yaml` are the sessions for **real recordings** (they need `media/` files that are not in git and the real speech models).

## Session runner and batch runner

```
npm run session -- sessions/01_worked_example.yaml --out out/01 [--api https://host] [--token T]
npm run batch -- sessions --out out/all      # every session file -> one folder each + summary.json (pass/fail)
```

Both are plain HTTP clients of the API (`--api`, `--token` or `API_URL` / `API_TOKEN`); they contain no editing logic. A session file has a `video` (local path = upload, or URL), optional `num_speakers`, and `steps` of `say` / `answer` / `render`, each with an optional `expect` and extra checks (`expect_duration_s`, `expect_warning`, `expect_no_warning`, `expect_text`, `expect_options`, `expect_hash_unchanged`). The format is documented in `apps/cli/src/format.ts`. Each run writes `results.json` (every step: answer, operations, warnings, timeline hash), `timeline.json` and the rendered videos with their manifests. `scripts/make_session_media.sh` builds the generated videos some sessions use.

## OpenTimelineIO export

`GET /api/v1/sessions/{id}/export/otio` returns the current timeline as an `.otio` file: one clip per piece of the edited timeline **in output order**, a sped-up or slowed clip carries a `LinearTimeWarp`, captions / text / auto-caption cues / mutes / bleeps are **markers** at output time, and the exact source span in microseconds is kept in each clip's metadata. Convention and limits: [`docs/REVIEW_M5.md`](docs/REVIEW_M5.md).

## Settings

Every setting is an environment variable, validated at startup (a bad value stops the service); `.env.example` lists all of them with their defaults. The table is generated from `.env.example` (`npm run docs:settings`) and a test fails when it is stale. Defaults are for local development only; `compose.prod.yml` tightens some (upload 200 MB, video 300 s) and production refuses the public dev secrets.

<!-- SETTINGS:START (generated from .env.example by npm run docs:settings; do not edit) -->
| Variable | Default | What it does |
|---|---|---|
| `NODE_ENV` | `development` | Runtime mode (development \| test \| production), log level, and the API port. production refuses to start without API_TOKEN and with the public dev S3 / database secrets. |
| `LOG_LEVEL` | `info` | Runtime mode (development \| test \| production), log level, and the API port. production refuses to start without API_TOKEN and with the public dev S3 / database secrets. |
| `PORT` | `8080` | Runtime mode (development \| test \| production), log level, and the API port. production refuses to start without API_TOKEN and with the public dev S3 / database secrets. |
| `DATABASE_URL` | `postgres://incubrix:incubrix-dev@postgres:5432/incubrix` | Postgres 16 (plain SQL migrations). A hosted Postgres URL may be used for the demo only. |
| `POSTGRES_USER` | `incubrix` | Postgres 16 (plain SQL migrations). A hosted Postgres URL may be used for the demo only. |
| `POSTGRES_PASSWORD` | `incubrix-dev` | Postgres 16 (plain SQL migrations). A hosted Postgres URL may be used for the demo only. |
| `POSTGRES_DB` | `incubrix` | Postgres 16 (plain SQL migrations). A hosted Postgres URL may be used for the demo only. |
| `S3_ENDPOINT` | `http://s3:8333` | S3-compatible store (SeaweedFS in compose, see docs/REVIEW_INFRA.md for why not MinIO) |
| `S3_REGION` | `us-east-1` | S3-compatible store (SeaweedFS in compose, see docs/REVIEW_INFRA.md for why not MinIO) |
| `S3_BUCKET` | `incubrix` | S3-compatible store (SeaweedFS in compose, see docs/REVIEW_INFRA.md for why not MinIO) |
| `S3_ACCESS_KEY` | `incubrix-dev-access` | S3-compatible store (SeaweedFS in compose, see docs/REVIEW_INFRA.md for why not MinIO) |
| `S3_SECRET_KEY` | `incubrix-dev-secret-key` | S3-compatible store (SeaweedFS in compose, see docs/REVIEW_INFRA.md for why not MinIO) |
| `S3_FORCE_PATH_STYLE` | `true` | S3-compatible store (SeaweedFS in compose, see docs/REVIEW_INFRA.md for why not MinIO) |
| `ASR_PROVIDER` | `faster-whisper` | Providers: the real ones are the default (the demo needs them); tests set mock explicitly. The ASR service reads ASR_PROVIDER and DIARIZATION_PROVIDER too, so there is one switch. |
| `ASR_URL` | `http://asr:8000` | Providers: the real ones are the default (the demo needs them); tests set mock explicitly. The ASR service reads ASR_PROVIDER and DIARIZATION_PROVIDER too, so there is one switch. |
| `ASR_MODEL` | `base.en` | Providers: the real ones are the default (the demo needs them); tests set mock explicitly. The ASR service reads ASR_PROVIDER and DIARIZATION_PROVIDER too, so there is one switch. |
| `ASR_TIMEOUT_S` | `3600` | Providers: the real ones are the default (the demo needs them); tests set mock explicitly. The ASR service reads ASR_PROVIDER and DIARIZATION_PROVIDER too, so there is one switch. |
| `DIARIZATION_PROVIDER` | `sherpa` | Providers: the real ones are the default (the demo needs them); tests set mock explicitly. The ASR service reads ASR_PROVIDER and DIARIZATION_PROVIDER too, so there is one switch. |
| `LLM_PROVIDER` | `rules` | Providers: the real ones are the default (the demo needs them); tests set mock explicitly. The ASR service reads ASR_PROVIDER and DIARIZATION_PROVIDER too, so there is one switch. |
| `LLM_TIMEOUT_MS` | `2500` | Providers: the real ones are the default (the demo needs them); tests set mock explicitly. The ASR service reads ASR_PROVIDER and DIARIZATION_PROVIDER too, so there is one switch. |
| `GROQ_API_KEY` | (empty) | Required only when LLM_PROVIDER=groq / gemini |
| `GEMINI_API_KEY` | (empty) | Required only when LLM_PROVIDER=groq / gemini |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Model used by LLM_PROVIDER=gemini (the fallback for instructions the rules cannot read) |
| `LLM_PRICE_INPUT_PER_M` | `0.30` | Estimated cost per 1M tokens (USD), paid-tier rates; see SOURCES.md |
| `LLM_PRICE_OUTPUT_PER_M` | `2.50` | Estimated cost per 1M tokens (USD), paid-tier rates; see SOURCES.md |
| `MAX_SPEED` | `4` | Speed range: min 0.25x is fixed, max is configurable (1..16) |
| `CALLBACK_HMAC_SECRET` | (empty) | Signs job callbacks (X-IncuBrix-Signature). At least 16 characters when set. |
| `API_TOKEN` | (empty) | API / worker Bearer token for the API (not /health, /ready, /docs, /openapi.yaml). Blank = open API, for local development only. |
| `RATE_LIMIT_PER_MIN` | `120` | Required (16+ characters) when NODE_ENV=production: the API refuses to start without it. Generate: openssl rand -hex 32 |
| `MAX_UPLOAD_MB` | `2048` | Required (16+ characters) when NODE_ENV=production: the API refuses to start without it. Generate: openssl rand -hex 32 |
| `MAX_VIDEO_DURATION_S` | `0` | Public-demo guards (compose.prod.yml sets stricter values, see docs/DEPLOY.md). 0 = no cap. |
| `MAX_INGEST_JOBS` | `1` | At most this many ingest+transcribe jobs / render jobs run at the same time (the rest wait in the queue) |
| `MAX_RENDER_JOBS` | `1` | At most this many ingest+transcribe jobs / render jobs run at the same time (the rest wait in the queue) |
| `TRUST_PROXY` | `false` | true only behind a reverse proxy that overwrites X-Forwarded-For (Caddy in compose.prod.yml): the rate limit then sees the client IP |
| `DOWNLOAD_TIMEOUT_S` | `3600` | Total time (seconds) a video URL download may take before it is cut (large files on slow links need a long one) |
| `URL_ALLOW_PRIVATE` | `false` | Tests only: allow video URLs that point to private/loopback addresses |
| `JOB_STALE_S` | `300` | Tests only: allow video URLs that point to private/loopback addresses |
| `WORKER_POLL_MS` | `500` | Tests only: allow video URLs that point to private/loopback addresses |
| `WORKER_PORT` | `8081` | Tests only: allow video URLs that point to private/loopback addresses |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:8333` | Host:port clients can reach, used in presigned download links (compose publishes 8333). Blank = S3_ENDPOINT. Change it for a deployment. |
| `SILENCE_NOISE_DB` | `-35` | Silence detection / word clamping (part of the transcript cache key) |
| `SILENCE_MIN_MS` | `300` | Silence detection / word clamping (part of the transcript cache key) |
| `CLAMP_MIN_WORD_MS` | `20` | Silence detection / word clamping (part of the transcript cache key) |
| `LOW_CONFIDENCE_PERMILLE` | `600` | Silence detection / word clamping (part of the transcript cache key) |
| `EMBED_PROVIDER` | `http` | Meaning-based search: http = the ASR service /embed (all-MiniLM-L6-v2, CPU), mock = tests, none = exact words only |
| `EMBED_URL` | (empty) | Blank = ASR_URL |
| `EMBED_THRESHOLD_PERMILLE` | `250` | A passage is a match when cosine similarity x 1000 >= this; at most EMBED_MAX_HITS are shown |
| `EMBED_MAX_HITS` | `8` | A passage is a match when cosine similarity x 1000 >= this; at most EMBED_MAX_HITS are shown |
| `VOICED_GAP_MIN_MS` | `150` | Untranscribed voiced stretches in gaps between words (possible fillers): kept when this long (ms) |
| `VOICED_GAP_MAX_MS` | `1200` | Untranscribed voiced stretches in gaps between words (possible fillers): kept when this long (ms) |
| `OTIO_PROVIDER` | `http` | OpenTimelineIO export: http = services/otio (OpenTimelineIO library), mock = hand-written OTIO JSON for tests |
| `OTIO_URL` | `http://otio:8001` | OpenTimelineIO export: http = services/otio (OpenTimelineIO library), mock = hand-written OTIO JSON for tests |
| `RENDER_PRESET` | `veryfast` | Render (ffmpeg, H.264 + AAC MP4, yuv420p, +faststart) |
| `RENDER_CRF` | `20` | Render (ffmpeg, H.264 + AAC MP4, yuv420p, +faststart) |
| `RENDER_MAX_HEIGHT` | `0` | 0 = keep the source height; otherwise scale down (never up) to at most this height |
| `RENDER_GROUP_PIECES` | `30` | Pieces per seeked input pair (0 = one group over the whole file). 30 was fastest in the 1080p bench. |
| `RENDER_MAX_GROUPS` | `64` | Pieces per seeked input pair (0 = one group over the whole file). 30 was fastest in the 1080p bench. |
| `RENDER_TMP_DIR` | `/tmp` | Pieces per seeked input pair (0 = one group over the whole file). 30 was fastest in the 1080p bench. |
| `RETENTION_DAYS` | `14` | Renders and CFR proxies older than this many days are deleted (originals are kept); 0 = keep everything |
| `MIN_FREE_DISK_GB` | `3` | Services refuse to start with less free disk than this (GB) in their temp folder |
| `S3_VACUUM_URL` | `http://s3:9333/vol/vacuum?garbageThreshold=0.1` | SeaweedFS master, called after a cleanup so the disk space is really freed (blank = skip) |
| `WHISPER_COMPUTE_TYPE` | `int8` | services/asr (read by the Python service, not by the Node config loader) The ASR provider itself is ASR_PROVIDER above (mock = fixture transcript, faster-whisper = real model). Models are downloaded into /models (base.en is baked into the image at build time; any other ASR_MODEL downloads on first use and is kept if /models is a volume). small.en vs base.en is NOT proven on real speech yet (docs/SPIKE_ASR.md). |
| `WHISPER_INITIAL_PROMPT` | (empty) | services/asr (read by the Python service, not by the Node config loader) The ASR provider itself is ASR_PROVIDER above (mock = fixture transcript, faster-whisper = real model). Models are downloaded into /models (base.en is baked into the image at build time; any other ASR_MODEL downloads on first use and is kept if /models is a volume). small.en vs base.en is NOT proven on real speech yet (docs/SPIKE_ASR.md). |
| `DIARIZATION_MODEL_DIR` | `/models/diarization` | Diarization (services/asr). DIARIZATION_PROVIDER above is shared with the Node config: sherpa = real (sherpa-onnx + pyannote-3.0 segmentation + WeSpeaker), mock = fixed turns, none = off. |
| `DIARIZATION_NUM_SPEAKERS` | `-1` | -1 = clustering decides. sherpa-onnx has no min/max speaker setting, only a fixed count or a threshold. |
| `DIARIZATION_CLUSTER_THRESHOLD` | `0.3` | Cosine-distance threshold of the clustering when no count is given. 0.3 is the best value of an 11-value sweep over 6 clips (5 of 6 right at 0.25-0.30, none right on all 6: docs/TEST_MEDIA.md). Lower splits one real speaker, higher merges two voices. |
| `DIARIZATION_UNCERTAIN_BELOW` | `0.6` | Word flagged speaker_uncertain when its best speaker covers less than this fraction of it |
| `DIARIZATION_OVERLAP_MIN_FRACTION` | `0.2` | Word flagged overlaps_speech when a second speaker covers at least this fraction of it |
| `DIARIZATION_SWAP_DETECTION` | `true` | Possible speaker-label swap: each speaker turn is embedded and compared with the speaker centroids; a turn is flagged when another speaker is closer than its own label by more than the margin (cosine). Turns shorter than the minimum are not judged. Flag only, never relabels. |
| `DIARIZATION_SWAP_MARGIN` | `0.05` | Possible speaker-label swap: each speaker turn is embedded and compared with the speaker centroids; a turn is flagged when another speaker is closer than its own label by more than the margin (cosine). Turns shorter than the minimum are not judged. Flag only, never relabels. |
| `DIARIZATION_SWAP_MIN_TURN_S` | `1.5` | Possible speaker-label swap: each speaker turn is embedded and compared with the speaker centroids; a turn is flagged when another speaker is closer than its own label by more than the margin (cosine). Turns shorter than the minimum are not judged. Flag only, never relabels. |
| `PUBLIC_HOST` | (empty) | compose.prod.yml only (read by Compose, not by the Node config loader): PUBLIC_HOST is the domain Caddy gets a certificate for. Put it in .env, e.g. PUBLIC_HOST=34-93-140-79.sslip.io (the IP with dashes; sslip.io resolves it back to the IP) |
| `PUBLIC_HOST_ALT` | (empty) | The same IP written with dots, e.g. PUBLIC_HOST_ALT=34.93.140.79.sslip.io (a second certificate; see deploy/Caddyfile) |
<!-- SETTINGS:END -->

## Error codes

Every error is `{"error":{"code","message","retryable","details"}}`. The list below is generated from `packages/errors/src/index.ts` (`npm run docs:errors`).

<!-- ERRORS:START (generated by npm run docs:errors; do not edit) -->
| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | no | The request body, query or headers are invalid. `details` lists each problem. |
| `URL_NOT_ALLOWED` | 400 | no | The video URL is not http(s), points to a private or loopback address, or redirects too often. |
| `UNAUTHORIZED` | 401 | no | Missing or wrong access token (`Authorization: Bearer <API_TOKEN>`). |
| `NOT_FOUND` | 404 | no | No such route. |
| `VIDEO_NOT_FOUND` | 404 | no | No video with this id. |
| `SESSION_NOT_FOUND` | 404 | no | No session with this id. |
| `JOB_NOT_FOUND` | 404 | no | No job with this id. |
| `VIDEO_NOT_READY` | 409 | yes | The video is still being processed, or its processing failed. Poll the job, then retry. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no | This Idempotency-Key was already used with a different request body. |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes | A request with this Idempotency-Key is still running. Retry shortly. |
| `FILE_TOO_LARGE` | 413 | no | The upload or the downloaded file is larger than `MAX_UPLOAD_MB`. |
| `VIDEO_TOO_LONG` | 422 | no | The video is longer than `MAX_VIDEO_DURATION_S` (a limit of this deployment; 0 = no limit). |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no | Only MP4 and MOV videos are accepted. |
| `NO_AUDIO_TRACK` | 422 | no | The video has no audio track, so there is nothing to transcribe. Reported on the failed job. |
| `PROBE_FAILED` | 422 | no | ffprobe could not read the file as a video. Reported on the failed job. |
| `RATE_LIMITED` | 429 | yes | Too many requests. Wait `Retry-After` seconds. |
| `INTERNAL_ERROR` | 500 | no | Unexpected server error. The `X-Correlation-Id` header identifies it in the logs. |
| `NOT_IMPLEMENTED` | 501 | no | The route exists in openapi.yaml but is not built yet (none at the moment). |
| `SERVICE_UNAVAILABLE` | 503 | yes | A dependency (database, storage) is not reachable. |
| `DOWNLOAD_FAILED` | 502 | yes | The video URL could not be downloaded. Reported on the failed job. |
| `ASR_UNAVAILABLE` | 502 | yes | The speech-to-text service did not answer or returned an error. Reported on the failed job. |
| `TRANSCRIPTION_FAILED` | 422 | no | The transcript could not be turned into atoms (for example no speech found). Reported on the failed job. |
| `RENDER_FAILED` | 500 | yes | ffmpeg failed while rendering. Reported on the failed render job. |
| `RENDER_VERIFY_FAILED` | 500 | no | The rendered file does not match the timeline (frame count or audio length off by more than 1 frame). Reported on the failed render job. |
| `SOURCE_CHANGED` | 500 | no | The stored original's sha256 differs from the one recorded at intake. The render is discarded. Reported on the failed render job. |
<!-- ERRORS:END -->

## Licences and sources

Every third-party component, model and test medium, with its licence, evidence file and what was *not* checked: [`SOURCES.md`](SOURCES.md). Every use of an AI tool: [`AI_USE.md`](AI_USE.md). Generated test speech is labelled AI-generated; no medium is committed to git.
