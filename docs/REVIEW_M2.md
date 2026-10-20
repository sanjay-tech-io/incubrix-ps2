# REVIEW M2: the real API (branch `m2`, 2026-10-20)

Everything below was run; raw output files are in `docs/raw/` (named). "Not verified" means exactly that. Design: `docs/API_DESIGN.md` (with an amendments section).

## 1. State after the interrupted session
My SSH connection dropped during the cold-start measurement. Checked with `git status`, `git log`, `docker compose ps`: all work up to commit `a6da4ba` was committed; nothing was lost. Uncommitted at that point: `scripts/make_demo_clip.sh` (complete; kept, then fixed, see 5) and a half-written `docs/raw/m2_cold_start.txt` (discarded and re-measured). The compose stack was half torn down (only `s3` running).

## 2. Tests (`docker compose run --rm tests`, exit 0, 1 min 2 s; `docs/raw/m2_compose_tests.txt`)
| Package | Result |
|---|---|
| config | 9 passed |
| contracts | 4 passed |
| db | 13 passed (incl. append-only `operation_log` UPDATE/DELETE rejected, undo/redo rows) |
| engine | 249 passed, 1 skipped (step 8 render, M3) |
| errors | 3 passed (README table up to date) |
| media | 25 passed |
| nlu | 51 passed (time parsing, worked example, hard cases, 3x identical output, purity lint) |
| storage | 4 passed |
| store | 38 passed (idempotency incl. concurrency, SKIP LOCKED, cache key, session round trip, URL guard, logger) |
| api | 30 passed (e2e worked example over HTTP, openapi vs routes, errors, idempotency, cache, VFR, URL intake, callback, auth, rate limit, correlation id) |
| worker | 8 passed (atoms, callback signature) |
| Python asr (via the `asr-tests` service) | 28 passed, 2 skipped (real-model tests) |

## 3. Git log and compose ps
`docs/raw/m2_git_log.txt`, `docs/raw/m2_compose_ps.txt` (api, asr, postgres, s3, worker all healthy).

## 4. Real run of steps 1-3 (REAL faster-whisper base.en + REAL sherpa diarization, rules parser): `docs/raw/m2_real_curl.txt`
Clip `scripts/make_demo_clip.sh`, 59.15 s, AI-generated speech. Upload 202 -> job progress 37..100 over 31 s (`asr_s` 28.9 s, `silence_s` 0.45 s, `cpu_seconds` 28.9) -> 112 words, 1 speaker -> session -> step 1 caption applied -> step 2 "cut the first 30 seconds": length 0:59.160 -> 0:29.160, "caption moved from 0:31.002 to 0:01.002" -> step 3 "remove the part about pricing": `needs_clarification`, 3 options, hash unchanged. Same `Idempotency-Key` replays (`idempotent-replayed: true`, no new job/turn); same key with a different body is 409 `IDEMPOTENCY_KEY_REUSED`. Restart (`docs/raw/m2_restart_checks.txt`): `docker compose restart api worker` -> same `timeline_hash`, and the open question was still answerable ("the second one" applied, 29.16 -> 26.16 s).
Earlier runs kept on purpose: `m2_real_curl_run1_wrong_clip.txt` (my first demo clip was wrong: "welcome" fell inside the first 30 s so the caption was hidden and "pricing" had one mention; the clip script was fixed) and `m2_real_curl_run2_cache_hit.txt` (same clip again = transcript cache HIT, 0.39 s).
The numbers come from one 59 s clip on a 4-vCPU VM, one run each. Not a benchmark.

## 5. Cold start: `docs/raw/m2_cold_start.txt`
From removed volumes (verified gone first), images already built: **all five long-running services healthy after 64.3 s**. Models are baked into the image and copied into the `models` volume on first start; nothing is downloaded. The two earlier attempts were contaminated (a leftover `init` container name conflict; volumes "still in use") and are not used. Time to BUILD the images from nothing is not included (the ASR image build was 83 s in B2; the app image build was not timed in this pass). After `docker compose restart asr` the log shows no download and the volume holds 141 MB (Whisper) + 33 MB (diarization).

## 6. Decisions I made that you should know about
- Migration 0002 needed only a CHECK change (the `kind` column already existed). Details in the API_DESIGN amendments.
- tsx runs api and worker (plain `node` cannot run the engine's extensionless imports / parameter properties; the engine is untouched).
- Unparseable instructions are `rejected` with examples. Multi-part instructions are one undo group, unusable parts are named in `warnings`.
- The parser checks the speed range itself (`checkSpeed` with the session's limits) so one impossible part of a multi-part instruction is named instead of failing the whole group; the engine still validates again.
- Change A and B implemented as asked (tests in 2).
- Process honesty: for `packages/nlu`, the worker and the API I wrote implementation and tests in the same step rather than strictly test-first; the tests were then run and fixed (failures found that way: two-caption test setup, speed range for multi-part, VFR test clip, correlation id in log lines, pg pool error on `drop database ... force`).

## 7. Not done / not verified (plain list)
- **Render** is a documented 501 stub (M3). **VFR**: accepted with a warning only; M3 must render via a CFR proxy at the same nominal rate (recorded in STATUS.md). My VFR detector (packages/media, unchanged) only flagged a clip whose frames were dropped at random; a clip whose timestamps are exact multiples of one frame interval with regular gaps is not flagged. A real phone recording was never tested.
- **Real LLM provider**: interface and `rules`/`mock` only (as instructed). `LLM_PROVIDER=groq|gemini` fails at startup with a clear message.
- Parser coverage is what the worked example and the hard-case list needed. NOT built: "what the guest says" (speaker-aware edits), music via text, meaning-based search beyond the one built-in "pricing/cost" group, unmute/unprotect by text. Anything unrecognised is rejected, never guessed.
- A worker crash in the middle of a job, end to end, was not run (stale re-queue is tested at store level only). Jobs are at-least-once: a re-queued intake re-does its work.
- ASR progress between 35% and 80% is time-estimated, not reported by the ASR service.
- Rate limit is in memory (one API process). `API_TOKEN` is blank in the default compose, so the demo API is open until you set it. The ASR service has no authentication (internal network only). The URL guard has the DNS-rebinding gap. Upload is read to a temp file before storing (disk, not memory).
- SeaweedFS answers HTTP 500 to the first write into a brand-new bucket; tests use the bucket created by `init`. Not investigated further. `chrislusf/seaweedfs:latest` is still unpinned.
- Cost estimate: CPU seconds only; USD is `null` because no price is configured. Seed: `null` (no randomness exists).
- Batch runner CLI, deploy, session pack, metrics: later milestones. No metric in this file should be quoted beyond what section 4 says.
- 1 engine test skipped (render). Python integration tests with the real models are skipped in compose; they were run by hand in B2.
