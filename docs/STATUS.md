# Project status (project memory)

Updated at the end of every milestone. Last update: M5d fixes (2026-10-23), M5c real-footage run (2026-10-23), M5 (2026-10-22), M6a deploy (2026-10-22), M4 (2026-10-21), on top of M3, M2, the infra workstream and M1c. Everything below was run, not assumed; "not verified" means exactly that.

## Done and verified
| Item | Proof (command) |
|---|---|
| npm workspaces (engine, contracts), strict TypeScript, vitest, ESLint purity rules | `npm test` exit 0; `npm run typecheck` exit 0 |
| Clean install from the public registry; lockfile has no mirror URLs | `grep -c npmmirror package-lock.json` = 0; `npm ci` then `npm test` exit 0 (M1b) |
| zod contracts are the source of truth; JSON Schema generated and compared | `npm test` (packages/contracts; engine `schema.test.ts`) |
| Canonical JSON, pure-JS SHA-256, atoms, cursors, frame grid, cumulative frame rounding | `npm test` (`canonical`, `atoms`, `frame_rounding` tests) |
| Replay, undo/redo/restore, time mapping, speed rules, effect states | `npm test` (`replay`, `session`, `worked_example`, `hard_cases`) |
| Reorder with two piece indexes; speed/effects anchored to source; runs rule; cut/undo/restore after reorder | `npm test` (`reorder.test.ts`) |
| Fillers, deterministic "like" rule, silences > N with pad, pinned pauses, mute/bleep warnings, caption edits, keep only, music ducking envelope, hard cases | `npm test` (`new_ops.test.ts`) |
| Grid warnings on every span-building path (touching words, 29.97 fps) | `npm test` (`grid_warnings.test.ts`) |
| Property tests run on deep-frozen inputs, incl. random moves; cached session path == fresh replay | `npm test` (`hard_cases.test.ts`, `reorder.test.ts`, `frame_rounding.test.ts`) |
| 40 hand-picked mutants all die | `npm run mutation-check` (see REVIEW_M1C.md section 5 for the raw output of the final run) |
| Performance targets on a synthetic 60-minute source | `npm run bench -w @incubrix/engine` (docs/PERF_ENGINE.md) |

### Infra workstream (branch `infra`, details and raw output in docs/REVIEW_INFRA.md)
| Item | Proof |
|---|---|
| Config loader (zod, fail fast), `.env.example` lists every setting (test) | `npm test -w @incubrix/config` |
| Plain-SQL migrations + runner, 7 tables, append-only operation_log | `docker compose run --rm tests` (db: 11 passed incl. 6 Postgres tests) |
| docker compose: postgres 16, SeaweedFS (S3; MinIO would not pull), init, api/worker placeholders, asr; all healthy | `docker compose up -d --build`, `docker compose ps` (docs/raw/compose_up.txt) |
| ASR service (faster-whisper + mock), integer us / permille | `python -m pytest` in services/asr: 11 passed, 1 skipped |
| Media tools: exact-fraction fps, VFR, audio silencedetect, clamp to silence | `npm test -w @incubrix/media` (25 passed) |
| Real ASR spike on a public-domain clip (RTF base.en 0.21, small.en 0.51, medium.en 1.33) | docs/SPIKE_ASR.md |
| Diarization licence evaluation; default candidate sherpa-onnx + pyannote-seg-3.0 ONNX + WeSpeaker | docs/REVIEW_INFRA.md section 5 (training-data licences and accuracy NOT verified) |

### B2 additions (details and raw output in docs/REVIEW_INFRA.md section "B2")
| Item | Proof |
|---|---|
| Real faster-whisper (base.en) runs inside the ASR image, models baked at build time, deps pinned, `ASR_MODEL` env | docs/raw/b2_asr_container_health.txt, b2_container_nasa120_nodiar.json |
| Diarization wired into the ASR service (sherpa / mock / none), per-word speaker, `speaker_uncertain`, `overlaps_speech` | `python -m pytest` in services/asr: 26 passed, 2 skipped; real-model test 1 passed |
| Diarization accuracy: **default settings found 1 speaker of 2 on the synthetic clip (58.8% words correct)**; 100% only with `NUM_SPEAKERS=2` or a threshold chosen on that clip | docs/raw/b2_two_voice_scores.txt |
| SOURCES.md: code / weights / training-data licence columns, evidence files | docs/licence-evidence/ |
| Presigned S3 PUT/GET, migrations from empty volumes, all services healthy | docs/raw/b2_health.txt, b2_fresh_up.txt |
| `docker compose run --rm tests` passes incl. the Python ASR tests (`asr-tests` service) | docs/raw/b2_compose_tests.txt (exit 0) |
| AI_USE.md | file at repo root (gaps marked for the candidate) |

### M2: the real API (branch `m2`, details and raw output in docs/REVIEW_M2.md)
| Item | Proof |
|---|---|
| openapi.yaml (3.1) written first; test: served routes == documented routes both ways; real responses validate against its schemas | `apps/api/test/api.test.ts` (compose) |
| Jobs on the `jobs` table with FOR UPDATE SKIP LOCKED, progress, stale re-queue, signed HMAC callback | `packages/store/test/store.test.ts`, `apps/worker/test/callback.test.ts`, `api.test.ts` |
| Idempotency-Key on every POST: same key+body replays and repeats no work; different body -> 409 `IDEMPOTENCY_KEY_REUSED`; concurrent duplicates run once | `store.test.ts`, `api.test.ts` |
| One error-code list, README table generated, test fails when stale | `packages/errors/test` |
| Intake: upload or URL, original stored untouched (sha256 checked byte for byte), probe, no audio -> `NO_AUDIO_TRACK`, VFR accepted with a warning, real ASR + diarization, silence + clamp, atoms, `num_speakers` hint | `api.test.ts`; real run: docs/raw/m2_real_curl.txt |
| Transcript cache key includes ASR provider/model, diarization provider, num_speakers, silence/clamp settings; changed model misses | `store.test.ts`, `api.test.ts` |
| Sessions, instructions, timeline / history / conversation; restart rebuilds by replay with identical hash | `e2e.test.ts`; real run: docs/raw/m2_restart_checks.txt |
| Rules parser: worked example steps 1-7, hard cases, same output 3x, purity lint | `packages/nlu/test` (51 tests) |
| Worked example steps 1-7 over HTTP, hash == engine-only replay of the returned operations | `apps/api/test/e2e.test.ts` |
| Every summary names the time policy (Change B) | `ratelimit.test.ts`, `e2e.test.ts` |
| Manifest on every job result and instruction answer | `e2e.test.ts` |
| Token, rate limit, correlation id, JSON logs with redaction | `api.test.ts`, `packages/store/test/log.test.ts` |
| Real providers are the compose default; models volume; cold start 64.3 s with images built | docs/raw/m2_cold_start.txt |

**M3 MUST handle variable-frame-rate sources** (record from the M2 decision): a VFR source is accepted with a warning, and the engine's frame grid for it is the nominal `r_frame_rate` from ffprobe. The renderer must build a constant-frame-rate proxy from the original AT THAT SAME RATE and render from the proxy; the original is never changed. Until then the warning in the answer and the manifest says frame-exact cuts are not guaranteed on VFR sources.

Latest `npm test` (root): see docs/REVIEW_M1C.md section 2. Last update of this file: end of M1c (2026-10-20).

### M3 (details and raw output: docs/REVIEW_M3.md)
| Item | Proof |
|---|---|
| Render: ONE ffmpeg run per render (cuts, keep-only, reorder, speed with chained atempo, mute, bleep, captions, auto-captions, ducked music), verified by ffprobe, source sha256 checked before and after | `packages/render/test` (15), `apps/api/test/e2e.test.ts` step 8; docs/raw/m3_accuracy_*.json |
| Frame accuracy at 25 / 30 / 29.97 fps, VFR via CFR proxy, 301 pieces: length difference 0 frames, A/V offset under 0.45 frames; no-audio fails with NO_AUDIO_TRACK | `docs/REVIEW_M3.md` section 3 |
| One graph vs many pieces measured; grouped inputs (30 pieces) fixed a quadratic cost: 361 pieces at 1080p 150 s -> 59 s | `docs/raw/m3_bench_*.json` |
| Real footage: worked example (as recorded) end to end with real ASR and a real render; about 60 s of rendering per output minute at 1080p on this VM | `test-pack/m3_real/`, REVIEW_M3.md sections 5-6 |
| Session runner, batch runner, 22 session files, determinism x3 | `apps/cli`, `sessions/`, `runner.test.ts`; batch: 17 passed, 5 failed on purpose or because of the footage |
| Storage hardening: 5xx retry, startup write check, identical uploads stored once, port 8333 published | `packages/storage/test`, `api.test.ts` |

M3 decisions: pieces are grouped (30 per seeked input pair, max 64 pairs) inside the one ffmpeg run; a CFR H.264 proxy is made for VFR, 10-bit/HDR/wide-gamut or non-H.264 sources and stored next to the original; the music asset is the generated built-in track; the render snapshots the timeline when asked.
M3 NOT done or not verified: see REVIEW_M3.md section 9 (tone-map and late-video paths untested, real-footage A/V offset not measured by flash/beep, graphs above 361 pieces untested, no storage cleanup, speaker-aware edits and vague references not built).

### M4 (details and raw output: docs/REVIEW_M4.md)
| Item | Proof |
|---|---|
| ffmpeg (GPL build) and libx264 (GPL-2+) in SOURCES.md with evidence; Gemini API terms/pricing and MiniLM model licence recorded | `docs/licence-evidence/` |
| Retention (renders, proxies; originals kept), startup disk check, SeaweedFS capacity raised | `packages/storage/test/retention.test.ts`, `api.test.ts` |
| Possible fillers (untranscribed voiced gaps) stored at intake; "remove the ums" asks before cutting them | `packages/media/test/voiced.test.ts`, `packages/nlu/test/fillers.test.ts`; 29 markers on the old recording |
| Meaning-based search (MiniLM ONNX, cached vectors) with the mock and the real model | `packages/semantic/test`, `services/asr/tests/test_embed.py`, sessions 21-22 |
| Gemini fallback (closed command list, zod, llm_cache, cost in manifest, off without key) | `packages/llm/test` (12), `api.test.ts`, session 23 (3 runs) |
| Vague references, speaker-scoped removal with host assumption and lead-in question, repeats safe; sessions 13 and 20 pass | `packages/nlu/test/advanced.test.ts`, sessions 13, 20, 24, 25 |

M4 NOT done: item 7 (needs the new recordings), filler ground truth, Gemini job path (latency up to 36 s observed), batch not re-run. See REVIEW_M4.md section 7.

### M6a: live demo deployed (details and raw output: docs/DEPLOY.md, docs/raw/m6a_*)
| Item | Proof |
|---|---|
| Caddy (Apache-2.0, SOURCES.md) with automatic HTTPS on https://34-93-140-79.sslip.io; Let's Encrypt certificate obtained; only ports 80/443 listen | Caddy log, `ss -ltn`, `/health` and `/ready` 200 via an external fetch service and curl |
| Downloads through the same host (`/<bucket>/*`, GET/HEAD only): GET 200 and bytes identical to the runner's file, range 206, PUT/DELETE 405, tampered signature 403 | `docs/DEPLOY.md`; commands run this session |
| Production guards: token required, rate limit per IP before auth, upload cap (Caddy + API), `MAX_VIDEO_DURATION_S`, job caps, strict config | `npm test` via `docker compose run --rm tests` (docs/raw/m6a_compose_tests.txt; the one failure was my test's wrong expectation, rerun passes: m6a_api_tests_rerun.txt); live checks m6a_rate_limit / upload_cap / duration_cap |
| Swagger UI at `/docs`, spec at `/openapi.yaml` (swagger-ui-dist Apache-2.0) | api.test.ts; HTTP 200 for page, bundle, css, spec |
| Smoke test through the public URL: upload, ASR, 2 edits, render, download | `docs/raw/m6a_smoke_session.txt` (PASS, 16.4 s), `m6a_smoke_out/` |
| Cold start (`down` + `up -d`): `/ready` 200 after 23.8 s | `docs/raw/m6a_cold_start.txt` (one run) |

Secrets rotated after approval (S3 keys, DB password): old-key link 200 before, 403 after; old files intact; smoke test passes again (DEPLOY.md, "Secret rotation"). M6a NOT done or not verified: see the last section of docs/DEPLOY.md. Swagger UI not opened in a browser; reboot not tested; price is an unverified third-party list price.

### M5: Outstanding items without new recordings (details and raw output: docs/REVIEW_M5.md)
| Item | Proof |
|---|---|
| OpenTimelineIO export: `GET /api/v1/sessions/{id}/export/otio` (file in the body, S3 link in `X-IncuBrix-Export-Url`), clips in output order, `LinearTimeWarp` speed, captions and effects as markers; `services/otio` uses the `opentimelineio` library (Apache-2.0, evidence file) | `services/otio/tests` (9), `packages/otio/test` (6), API test with the real service reading the file back: track length within 1 frame of the timeline after cut + speed + reorder (`docs/raw/m5_otio_api_tests.txt`). **Not opened in any video editor.** |
| Speaker-label swap detection (turn embedding vs speaker centroids, leave-one-out, margin) -> `possibleLabelSwap` -> warnings on edits touching the words | `services/asr/tests/test_swap.py` (13), engine / nlu / worker / API tests; real models on the espeak two-voice clip: 6 of 6 deliberately swapped turns found, 0 false flags (`docs/raw/m5_swap_real_run.txt`). **Synthetic voices only.** |
| 48 scripted scenarios (130 steps, 7 with real renders) with expected results per step, in `docker compose run --rm tests`; `.github/workflows/ci.yml` runs that command on every push | `docs/raw/m5_scenarios_run2.txt` (50 of 50), `docs/raw/m5_scenarios/`; first run 43 of 50 kept in `m5_scenarios_run1.txt`. **No GitHub Actions run has happened (nothing pushed)**; a fresh-clone simulation of the same command: `docs/raw/m5_ci_simulation.txt` |
| README: architecture (Mermaid), setup, tests, runners, demo, settings table generated from `.env.example` with a staleness test | `packages/config/test/envdoc.test.ts` |
| Bugs found and fixed by the above | music could not be rendered on longer videos (ffmpeg expression nesting; `musicexpr.test.ts`); answer now says when a speed change overlaps an earlier one; **a fresh clone could not run because `.gitignore` `media/` hid `packages/media/src/voiced.ts` since M4** (`m5_ci_simulation_run1_failed.txt`) |

M5 NOT done or not verified: see REVIEW_M5.md section 7. **Live demo redeployed with M5 on 2026-10-22** (docs/DEPLOY.md, last section); tests now run on their own stack and no longer touch the live services (REVIEW_M5 section 8).

### M5c: real footage without new recordings (details and raw output: docs/WORKED_EXAMPLE_REAL.md, docs/TEST_MEDIA.md, `test-pack/real/`)
| Item | Result | Proof |
|---|---|---|
| Worked example on `media/test_single.mp4` with real ASR (phrase "welcome to our channel", 7 pricing options, "the second one"; other steps as the brief) | all 9 steps as the brief expects, undo hash == hash before the restore, second run: 9 of 9 hashes identical (cached transcript) | `sessions/worked_example_real.yaml`, `docs/WORKED_EXAMPLE_REAL.md` |
| Full-resolution render | 1920x1080, 3911 frames = timeline (difference 0), caption on frames 286-346 = timeline 9.5013-11.540 s, audio onset 9.517 s vs caption 9.533 s | `test-pack/real/worked_example_real/`, `caption_frame_scans.json` (`scripts/caption_frames.mjs`) |
| Caption before cut / after cut / after restore (720p renders) | 1186-1246, 286-346, 1186-1246; frames equal timeline in all three | `test-pack/real/worked_example_real_frames/` |
| Fillers on the real recording | 0 transcribed, 29 possible markers listed with times; no ground truth | `test-pack/real/fillers_single/`, TEST_MEDIA.md section 2 |
| Two speakers | **FAILED at default settings**: dialogue clip 1 speaker of 2 (hint did not help), NASA clip no separation; 0.3 threshold diagnostic works on synthetic clips only and made one wrong cut, one miss | TEST_MEDIA.md section 3, `test-pack/real/` |
| Batch, 720p veryfast | **30 of 36 pass, 6 fail** (01, 02: brief phrase not in the recording; 04: no "um"; 13b and nasa: 1 speaker; 22: "money") | `test-pack/real/batch_720p/summary.json`, `batch_720p_log.txt` |

M5c NOT verified: any real two-person edit (none exists); filler ground truth; diarization on real speech (fails); audio sync by ear; the worked-example run through the public URL (the 200 MB upload hit `fetch failed`, cause not confirmed; run over the Docker network instead); full-resolution frame checks before/after the cut (720p only). Side effect to know: an `.env` change plus `docker compose up -d worker` recreated api, postgres, s3 and asr (about a minute of downtime of the live demo at ~16:35 UTC); `RENDER_MAX_HEIGHT` and the diarization threshold are back to their defaults (0 / 0.5).

### M5d: diarization default, public 2 GB uploads, token rotation (details: docs/TEST_MEDIA.md "M5d update", docs/DEPLOY.md last section, raw `docs/raw/m5d_*`)
| Item | Result | Proof |
|---|---|---|
| Diarization default from a sweep over ALL clips (11 thresholds x 6 clips, real diarizer) | **no threshold is right on all 6**; 0.25-0.30 right on 5 of 6; default changed 0.5 -> **0.3** (0.5 was right on 2 of 6); range is two grid points wide, not robust | `docs/raw/m5d_diarization_sweep.jsonl`, `..._table.md`, `scripts/sweep_table.mjs`, `docs/raw/m5d_turn_embeddings.json` |
| `num_speakers` hint made reliable; answer suggests it when one speaker is found for a guest/host request | hint fallback (`asr/cluster.py`, 8 tests): dialogue clip 142/142 words right with and without the hint (was 93/142, 1 speaker); the answer names the hint (nlu test) | `test-pack/real/two_voice/asr_after_*.json`, `test-pack/real/m5d/` |
| Re-run 13b and NASA through the public URL | 13b PASS (hint), 13d PASS (no hint); NASA with hint **still FAILS** (one effective speaker), NASA without hint asks "Speaker A, B or C" (found 3, expected 2, guest = C) | `test-pack/real/m5d/` |
| Public upload: cause of "fetch failed after 6 s" | Caddy cap 200 MB (decimal) vs a 200.4 MB file; the reject raced the client's write (1 in 6 `ECONNRESET`); fixed: cap 2048 MiB in Caddy + API, early 413 on a declared oversize, runner shows the cause | `docs/raw/m5d_upload_before.txt`, `m5d_upload_after.txt` |
| Proof through https://34-93-140-79.sslip.io | `test_single.mp4` 6/6 Node-fetch uploads 202; 2.2 GiB rejected 413 `FILE_TOO_LARGE` in 0.1 s 7/7; 2,000,000,000 bytes accepted in 352 s (> 300 s) with identical sha256 | `docs/raw/m5d_upload_2gb.txt`, `m5d_upload_over_cap.txt` |
| New defect found and fixed: Node fetch cuts any request waiting more than 300 s (`UND_ERR_HEADERS_TIMEOUT`), so the ASR call failed on long/busy transcriptions | ASR client now `node:http`; 310 s answer received; `DOWNLOAD_TIMEOUT_S` for URL downloads (was a fixed 10 min) | `docs/raw/m5d_fetch_headers_timeout.txt`, `m5d_asr_client_310s.txt`, `apps/worker/test/{asr,download}.test.ts` |
| API token rotation | had never been rotated; done; old token 401, new token passes, no token 401; values not in git or logs | `docs/raw/m5d_token_rotation.txt` |

M5d NOT verified: URL intake of a large file through the public URL; the 2 GB ingest after the ASR-client fix (the 2 GB file's ingest failed with the 5-minute fetch limit before the fix, and its storage object was deleted); NASA host/guest separation with a hint; the dialogue results are on a synthetic clip; the batch was not re-run after the threshold change; the database password (shown once in my terminal output) is not rotated.

## Not verified (not built or not run)
M3 leftovers: see REVIEW_M3.md section 9. The M2 list below is partly outdated: render, batch runner and the worker are built now.
M2 leftovers: render (501 stub), the real LLM provider (interface only), reorder/mute/bleep/captions by voice-of-speaker ("what the guest says"), music by text, batch runner CLI, deploy, a worker crash mid-job end to end (stale re-queue is tested at store level only), in-memory rate limit (one process only), API_TOKEN is unset in the default compose (open API), DNS-rebinding hardening, ASR service has no auth (internal network only). Older list follows.

Infra additions not done: real api/worker, compose end-to-end test, diarization accuracy on real speech (default settings failed on the synthetic clip), training-data licences (all unchecked), a failing-pytest-fails-compose check, disfluency-prompt effect on labelled human speech (see REVIEW_INFRA.md section 8). Older list follows; its Docker item is now outdated (Docker works on the GCP VM).
Docker / docker compose (Docker is not installed on the dev machine); rendering and A/V sync (M3); worked example step 8; instruction parsing; audio mixing of music/bleeps; API, jobs, idempotency, errors, health, manifest, docker compose (M2); real ASR and diarization; LLM adapters; reorder, filler and silence removal, music ducking, mute/bleep audio; multi-speaker handling; OTIO export; performance on a real 60-minute video or through the API (only a synthetic source on one laptop is measured); any real video; any metric; CI.

## Decisions
Full list: `CLAUDE.md` section "Decisions" and `docs/DESIGN.md`. Headlines: Node 22; real ASR/diarization in the demo and mocks for tests only; cursor = (atom, offset) with offset only inside silences and on the frame grid; partial-cut rule and inactive effects; 0.7 s minimum caption time; speed range 0.25x-4x (`MAX_SPEED`); later speed change replaces the earlier rate; restore is a new op that points at a group; effect ids count edit ops only; sha256 from @noble/hashes; no React UI (M7 = Swagger UI/Redoc from openapi.yaml).

## Open items
- ~~Record the single-speaker test video~~ superseded: no new recordings; `test_single.mp4` is used and the differences are in docs/TEST_MEDIA.md.
- Diarization: default is now 0.3 (best of a sweep, right on 5 of 6 clips, narrow range); on real two-person speech it still over-splits (NASA: 3 for 2) and the hint does not help there (docs/TEST_MEDIA.md, M5d update). Any two-speaker claim needs a real two-person recording.
- Decide how to resolve "the intro"/"that caption" style references (parser/history lookup, M2/M4).
- Boundaries between two touching words cannot be frame-snapped; check the drift once M3 can render (REVIEW_M1B doubt 2).
- Install/verify Docker on the GCP VM before M2.
- Reorder now has two piece indexes (done in M1c); cuts on an unsorted segment list use a linear scan.
- `npm audit`: 6 findings, all in the dev-only vitest 2.x tree (vitest critical, tinypool critical, vite high, esbuild moderate, vite-node moderate, @vitest/mocker moderate); production tree: 0. No non-breaking fix exists (only `vitest@5`, a major upgrade). Left as is; decide on upgrading vitest (a major version) later. Raw: REVIEW_M1C.md section 3.
- Add `.gitattributes` for line endings (needs approval).
- Multi-speaker handling (diarization labels, 'what the guest says'), meaning-based search, OTIO export, 60-minute real-video timing: M4/M5.
- No `test-pack/` exists yet; no metric may be quoted until real runs are saved there.

## Claims ledger (claim -> evidence -> verified)
| # | Claim | Evidence | Verified |
|---|---|---|---|
| 1 | The engine cannot read clock, randomness, fs, network, env | `packages/engine/test/lint_guard.test.ts` (11 forbidden constructs fail lint, pure code passes), run by `npm test` | yes (rules cover `src/`; imports of third-party packages are not audited) |
| 2 | Same log replayed on 3 fresh engines gives the same timeline_hash | `session.test.ts` "replayed 3 times"; `worked_example.test.ts` last test | yes (engine only) |
| 3 | Hash ignores what the user typed and clarification turns | `session.test.ts` "does not depend on what the user typed" | yes |
| 4 | SHA-256 implementation is correct | `canonical.test.ts` vs `node:crypto` (oracle, tests only) and the published "abc" vector | yes |
| 5 | Canonical JSON rejects floats, NaN, undefined, functions, bigint | `canonical.test.ts` | yes |
| 6 | Hash of the untouched timeline equals a hand-written canonical string | `replay.test.ts` first test | yes |
| 7 | Source file is never modified / its sha256 is stored | Only the `Source.sha256` field exists; no file ingestion yet | **no** (M2) |
| 8 | Captions/effects stay on their words after cut, speed change, restore | `worked_example.test.ts`, `hard_cases.test.ts`, `replay.test.ts` | yes; after reorder: **no** (not implemented) |
| 9 | Worked example steps 1-7 reproduce exactly | `worked_example.test.ts` (hand-computed numbers, synthetic fixture) | yes on the fixture; **not** on a real video |
| 10 | Worked example step 8 (render in sync) | skipped test "needs M3" | **no** |
| 11 | Every instruction gets exactly one of applied / needs_clarification / rejected | `session.test.ts` | yes at engine level; over HTTP **no** (M2) |
| 12 | One instruction = one undo; new edit clears redo; restore a specific older edit while later ones stay | `session.test.ts`, `worked_example.test.ts` steps 5-6 | yes |
| 13 | Speed outside 0.25x-4x is rejected with the reason and the range | `session.test.ts`, `replay.test.ts` | yes (the `MAX_SPEED` env wiring is **not** built, M2) |
| 14 | Overlapping speed changes follow the documented rule | `replay.test.ts` (3 cases), `docs/DESIGN.md` | yes |
| 15 | Invalid cursors are rejected | `atoms.test.ts` (unknown atom, negative, fractional, too large, inside word, off-grid, end-cursor misuse) | yes |
| 16 | Caption whose words are all cut becomes inactive (never deleted) and returns on restore; partial cut keeps text and names cut words | `hard_cases.test.ts`, `session.test.ts` | yes |
| 17 | Captions keep a 0.7 s minimum after speed-up and the answer warns | `replay.test.ts`, `session.test.ts` | yes |
| 18 | Cut rule: exact inside silence, snap + warn inside a word | `search_resolve.test.ts` | yes (resolution helpers) |
| 19 | Operations touching flagged words warn | `session.test.ts` (speaker uncertain, low confidence) | yes (overlapping-speech flag follows the same code path but has no dedicated test) |
| 20 | Incremental application equals full replay | `hard_cases.test.ts` property test (150 random sequences, fixed seed). A one-off manual mutation (removing redo-clearing) made it fail; mutation check is not automated | yes |
| 21 | JSON Schema matches what the engine produces | `schema.test.ts` validates one real session document and its timeline | yes for that session; not exhaustive |
| 22 | Auto-caption text comes from surviving words | `replay.test.ts` | yes (cue grouping is simple; rendering **no**) |
| 23 | Time policy "original" vs "current" | `search_resolve.test.ts`, answers carry `timePolicy` | yes (policy detection from text is parser work, not built) |
| 24 | Render accuracy, A/V sync, length within 1 frame | none | **no** (M3) |
| 25 | Reorder, filler removal, silence removal, music ducking envelope, mute/bleep as timeline data | implemented in M1c: see rows 37-47 | yes (engine only; **no** audio mixing/rendering: M3) |
| 26 | Instruction latency, 60-minute scale | superseded by row 32 (synthetic source only; real 60-minute video, API and database path not measured) | partly |
| 27 | Real ASR, diarization, API, jobs, idempotency, compose, OTIO | not built | **no** |
| 28 | Any metric (latency, cost, clipping, clarification quality) | none produced; nothing is under `test-pack/` | **no** |
| 29 | `registry=https://registry.npmjs.org/` is pinned and the lockfile has no mirror URLs | `.npmrc`; `grep -c npmmirror package-lock.json` = 0; `npm ci` then `npm test` exit 0 (REVIEW_M1B section 1) | yes |
| 30 | Source-side cut boundaries are on the frame grid (silence-to-word boundaries move into the silence, never into a word) | `frame_rounding.test.ts`; mutant "floor/ceil swapped" killed | yes, except boundaries between two touching words (cannot be snapped; warned in `snapPoint`) |
| 31 | Output frames: sum of piece frames = round(total); each piece within 1 frame | `frame_rounding.test.ts` (odd counts at 2x and 3/2x; seeded property, 150 runs, independent BigInt arithmetic); mutant "per-piece rounding" killed | yes (engine arithmetic only; **not** against a rendered video) |
| 32 | Any instruction < 300 ms; 4,000-op instruction < 1 s (synthetic 60 min, 24,001 atoms) | `docs/PERF_ENGINE.md`, `npm run bench -w @incubrix/engine`; worst single observed 155.9 ms; 4,000-op ~50-58 ms | yes on this laptop, synthetic data |
| 33 | Cached session path equals a replay on a brand-new engine | `hard_cases.test.ts` property (100 seeded sessions incl. restore and rejected turns); 3 cache mutants killed | yes |
| 34 | Music, protected pauses, auto-caption style are in the timeline and hash; effect ids count edit entries only | `mutants.test.ts`; 4 original surviving mutants killed (without these tests 4 of 9 survived) | yes |
| 35 | zod contracts are the source of truth; committed JSON Schema equals the generated one | `packages/contracts/test/schema.test.ts` | yes |
| 36 | Docker works on the dev machine / compose runs | `docker --version`: command not found on this machine | **no** |
| 37 | Reorder: move a span before a point or to the end; output order and source order independent; two piece indexes | `reorder.test.ts` (order, time mapping both ways, to-end, into-itself rejected, target in cut material, move-and-back hash, property: 100 seeded random move sequences keep all material, disjoint, round-trip mapping; inputs deep-frozen) | yes (engine; not rendered) |
| 38 | Speed regions stay attached to source atoms after a move | `reorder.test.ts` (a) | yes |
| 39 | Effects after a reorder: a caption on moved words follows them; a split effect shows on its first run with a warning; mute/bleep apply to every run | `reorder.test.ts` (b); mutant "split effect treated as one run" killed | yes |
| 40 | Cut spanning moved material; undo and restore after a reorder | `reorder.test.ts` (c)(d) | yes |
| 41 | Remove fillers: um/uh and a deterministic "like" rule ("I like this tool" is kept); a filler inside a bleep/mute is kept with a warning | `new_ops.test.ts` (R1-R4 tests, 4 fillers in fixture, bleep overlap) | yes on the fixture and synthetic phrases; the "like" rule is a heuristic **not measured on real speech** |
| 42 | Remove silences > N with a pad setting; pinned pauses survive | `new_ops.test.ts` (26 cuts, exact numbers, strict "longer than", pinned count, pad setting) | yes (fixture) |
| 43 | Mute and bleep as timeline effects; low-confidence words warn | `new_ops.test.ts` | yes (data and warnings only; no audio) |
| 44 | Caption edits: text, colour, size, bold, position | `new_ops.test.ts` | yes |
| 45 | Auto-caption cues from surviving words in output order, deterministic chunking | `replay.test.ts`, `reorder.test.ts` (swapped sentences) | yes (no rendering) |
| 46 | Music track op + ducking envelope as a pure function of the final speech | `new_ops.test.ts` (exact keyframes, edge cases, merge rule, follows cuts/speed) | yes (no audio mixing) |
| 47 | Keep only a range (with captions on kept words) | `new_ops.test.ts` | yes |
| 48 | Every span-building path returns the same grid warning as snapPoint, and the answer includes it | `grid_warnings.test.ts` (findTopicParts single and clarification path, edited/original range incl. segment-edge start, fillers, move; control: none for silence-bounded) | yes (29.97 fps touching words) |
| 49 | Property tests with deep-frozen inputs | `test/freeze.ts`; mutant "cut edits previous state in place" killed only by frozen runs | yes |
| 50 | Performance with the new operations; findTopicParts with 40 captions and 4,000 segments | PERF_ENGINE.md M1c table | yes on this laptop, synthetic; a ~12,000-op instruction is above 300 ms (reported) |
| 51 | Boundary agreement with ffmpeg | none | **NOT VERIFIED until M3** |
| 52 | 40 mutants killed | REVIEW_M1C.md section 5 | yes |
| 53 | npm audit findings | REVIEW_M1C.md section 3: 6 dev-only, 0 in production, only fix is a major vitest upgrade (not applied) | documented, **not fixed** |
| 54 | OpenTimelineIO export: clips in output order, speed as LinearTimeWarp, captions as markers, length equals the timeline within 1 frame when read back with the library | `packages/otio/test`, `services/otio/tests`, API test (real service) | yes in the library; **not in any editor** |
| 55 | Possible speaker-label swaps are detected and warned about | `test_swap.py`, `m5_swap_real_run.txt`, API / nlu tests | yes on synthetic voices with deliberate swaps (6 of 6, 0 false flags); **real speech: not verified** |
| 56 | At least 40 scripted scenarios with expected results run in CI | `scenarios/` (48), `m5_scenarios_run2.txt`, `ci.yml` | scenarios: yes (mock transcript); **GitHub Actions run: no**; fresh-clone run of the same command: see REVIEW_M5 section 6 |
| 57 | Music renders on videos with many speech pauses | `musicexpr.test.ts`, scenario s39 | yes (200 s fixture); 60-minute video with music: **not run** |
| 58 | The repository builds from a fresh clone | `m5_ci_simulation.txt` (after the `.gitignore` fix); the first fresh clone FAILED (`m5_ci_simulation_run1_failed.txt`) | see REVIEW_M5 section 6 |
