# Review: infrastructure workstream (branch `infra`)

Date: 2026-10-20. Machine: GCP VM, Debian 13, 4 vCPU, 15 GiB. Everything below was run on it; raw outputs are pasted or linked under `docs/raw/`.

## 0. Things that differed from the brief
- The checkout was empty (unborn local `main`, no `infra`). I ran `git fetch` and created `infra` from `origin/main` (9d5533d). `packages/engine` and `packages/contracts` are untouched (`git diff origin/main --stat -- packages/engine packages/contracts` is empty, shown in section 7).
- The boot disk was ALREADY 50 GB (sda1 49.9G, ext4 49G) when I looked. Nothing to extend, so there is no before/after pair; I did not see the pre-resize state.
- `AI_USE.md` (required by CLAUDE.md) does not exist in the repo. I did not create it.

## 1. Environment
```
NAME    MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS
sda       8:0    0   50G  0 disk 
├─sda1    8:1    0 49.9G  0 part /
├─sda14   8:14   0    3M  0 part 
└─sda15   8:15   0  124M  0 part /boot/efi
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        49G   15G   33G  31% /
SOURCE    FSTYPE
/dev/sda1 ext4
Docker version 29.9.1, build dfc520d
v22.23.3
ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers
```

Docker 29.9.1 / Compose v5.6.0 worked without sudo. `npm ci` then `npm test` on Linux (`docs/raw/npm_ci_test_linux.txt`, before my changes): engine 249 passed | 1 skipped (the skip is in the pre-existing `worked_example` file, not mine), contracts 4 passed. Line endings: `git ls-files --eol` shows no non-LF files. No Linux-specific failure found. `npm ci` prints "6 vulnerabilities" (dev-only vitest tree, already documented in CLAUDE.md).

## 2. Compose, migrations, config
Files: `docker-compose.yml`, `Dockerfile`, `.env.example`, `packages/config` (zod, fails fast, lists every bad variable, never prints values), `packages/db` (plain SQL runner: ordered `NNNN_name.sql`, one transaction each, sha256 checksum, advisory lock; `migrations/0001_init.sql` has sessions, source_assets, operation_log (append-only trigger), conversation_log, idempotency_keys, jobs, llm_cache), `packages/storage` (S3 client + ensureBucket), placeholder `apps/api`, `apps/worker`, `services/asr`.

### S3 server: MinIO did not pull
```
$ docker pull minio/minio:latest
Error response from daemon: pull access denied for minio/minio, repository does not exist or may require 'docker login'
$ docker pull minio/minio:RELEASE.2025-04-22T22-12-26Z
Error response from daemon: pull access denied for minio/minio, repository does not exist or may require 'docker login'
$ docker pull quay.io/minio/minio:latest
Error response from daemon: unknown: failed to resolve reference "quay.io/minio/minio:latest": unexpected status from HEAD request to https://quay.io/v2/minio/minio/manifests/latest: 401 Unauthorized
```
Both `chrislusf/seaweedfs` and `dxflrs/garage:v2.1.0` pulled. Chose **SeaweedFS** (Apache-2.0, `docs/licence-evidence/seaweedfs.LICENSE`; one container, S3 on 8333, credentials from env, image has wget/nc for a healthcheck). Garage: I did not check its licence. Its image has no shell (so no simple healthcheck) and needs a cluster-layout step, so I did not go further. The SeaweedFS image tag is `latest` (weed 30GB 4.48 530be3e37), which is not reproducible; pin it before a demo.

### `docker compose up` from empty volumes (`docs/raw/compose_up.txt`)
```
 Volume incubrix-ps2_pgdata Removed 
 Network incubrix-ps2_default Removed 
 Container incubrix-ps2-init-1 Exited 
 Container incubrix-ps2-worker-1 Starting 
 Container incubrix-ps2-init-1 Exited 
 Container incubrix-ps2-api-1 Starting 
 Container incubrix-ps2-worker-1 Started 
 Container incubrix-ps2-api-1 Started 
NAME                      IMAGE                        COMMAND                  SERVICE    CREATED          STATUS                    PORTS
incubrix-ps2-api-1        incubrix-ps2-api             "docker-entrypoint.s…"   api        12 seconds ago   Up 3 seconds (healthy)    0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp
incubrix-ps2-asr-1        incubrix-ps2-asr             "uvicorn asr.server:…"   asr        16 seconds ago   Up 11 seconds (healthy)   
incubrix-ps2-postgres-1   postgres:16                  "docker-entrypoint.s…"   postgres   16 seconds ago   Up 11 seconds (healthy)   5432/tcp
incubrix-ps2-s3-1         chrislusf/seaweedfs:latest   "/bin/sh -c 'export …"   s3         16 seconds ago   Up 12 seconds (healthy)   7333/tcp, 8080/tcp, 8333/tcp, 8888/tcp, 9333/tcp, 18080/tcp, 18888/tcp, 19333/tcp
incubrix-ps2-worker-1     incubrix-ps2-worker          "docker-entrypoint.s…"   worker     12 seconds ago   Up 4 seconds (healthy)    
asr-1     | INFO:     Started server process [1]
asr-1     | INFO:     Waiting for application startup.
asr-1     | INFO:     Application startup complete.
asr-1     | INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
asr-1     | INFO:     127.0.0.1:40418 - "GET /health HTTP/1.1" 200 OK
asr-1     | INFO:     127.0.0.1:40424 - "GET /health HTTP/1.1" 200 OK
asr-1     | INFO:     127.0.0.1:48048 - "GET /health HTTP/1.1" 200 OK
worker-1  | {"timestamp":"2026-10-20T10:29:29.455Z","level":"info","service":"worker","msg":"listening","port":8081,"placeholder":true}
api-1     | {"timestamp":"2026-10-20T10:29:29.731Z","level":"info","service":"api","msg":"listening","port":8080,"placeholder":true}
init-1    | {"level":"info","msg":"init done","applied":["0001_init.sql"],"bucket":"incubrix"}
```

### `docker compose run --rm tests` (single test command, runs `npm test` in the container with real Postgres + S3; `docs/raw/compose_tests.txt`)
```
> @incubrix/config@0.0.0 test
 ✓ test/config.test.ts (8 tests) 49ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
> @incubrix/contracts@0.0.0 test
 ✓ test/schema.test.ts (4 tests) 389ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
> @incubrix/db@0.0.0 test
 ✓ test/files.test.ts (5 tests) 18ms
 ✓ test/postgres.test.ts (6 tests) 364ms
 Test Files  2 passed (2)
      Tests  11 passed (11)
> @incubrix/engine@0.0.0 test
 ✓ test/session.test.ts (30 tests) 108ms
 ✓ test/new_ops.test.ts (39 tests) 140ms
 ✓ test/reorder.test.ts (26 tests) 218ms
 ✓ test/replay.test.ts (23 tests) 43ms
 ✓ test/frame_rounding.test.ts (14 tests) 221ms
 ✓ test/worked_example.test.ts (11 tests | 1 skipped) 71ms
 ✓ test/search_resolve.test.ts (21 tests) 102ms
 ✓ test/atoms.test.ts (21 tests) 48ms
 ✓ test/grid_warnings.test.ts (11 tests) 55ms
 ✓ test/mutants.test.ts (14 tests) 30ms
 ✓ test/hard_cases.test.ts (6 tests) 2546ms
 ✓ test/canonical.test.ts (18 tests) 23ms
 ✓ test/schema.test.ts (4 tests) 296ms
 ✓ test/lint_guard.test.ts (12 tests) 999ms
 Test Files  14 passed (14)
      Tests  249 passed | 1 skipped (250)
> @incubrix/media@0.0.0 test
 ✓ test/pure.test.ts (17 tests) 14ms
 ✓ test/ffmpeg.test.ts (8 tests) 2862ms
 Test Files  2 passed (2)
      Tests  25 passed (25)
> @incubrix/storage@0.0.0 test
 ✓ test/s3.test.ts (2 tests) 98ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```
The db tests (create/drop their own database) and the S3 round trip run for real inside compose. Outside compose (`npm test` on the host) they are SKIPPED, not passed (host: db "5 passed | 6 skipped", storage "2 skipped"). Bug found by running it: Node's type stripping rejects TS parameter properties (`ConfigError`), fixed, and `erasableSyntaxOnly` added so tsc catches it. Another: the `tests` image was stale after `up --build`; all Node services now share `image: incubrix-app`.

## 3. ASR service (`services/asr`)
FastAPI, adapters `faster-whisper` (CPU int8, word timestamps, VAD on by default) and `mock` (fixture transcript with um/uh). Words: `text, start_us, end_us` (integers), `confidence_permille` (integer), optional `speaker`. pytest: `docs/raw/asr_pytest.txt`:
```
........s...                                                             [100%]
11 passed, 1 skipped in 0.49s
```
(the 1 skip is the real-model test, which needs `ASR_TEST_AUDIO`; it was exercised by hand in the spike). Disfluency-prompt, model sizes, RTF, memory: see `docs/SPIKE_ASR.md`. Headline: prompt effect is small and not proven (base.en 9 -> 10 of 10 on synthetic speech; 0 -> 1 on 5 minutes of real speech with no ground truth).

## 4. Media tools (`packages/media`)
`probe()` (duration in integer us, exact fps fraction e.g. `30000/1001`, audio/video presence, VFR from packet timestamps), `detectSilence()` (ffmpeg silencedetect on the audio, closes a silence still open at EOF, errors on no-audio files), `clampWordsToSilence()` (word end pulled back to the silence start, word start pushed to the silence end, min word length, words fully inside silence reported, input not mutated). 25 tests; media is generated with ffmpeg lavfi at test time (NTSC mp4, silent video, a VFR mp4 made by dropping frames, a tone-gap-tone wav). No binary in git. Limits: VFR is judged on the first 120 s of packets only; thresholds (-35 dB, 0.3 s, 20 ms min word) are my defaults, not tuned on real data.

## 5. Diarization: licences (evidence in `docs/licence-evidence/`)
| Option | CODE licence | WEIGHTS licence | Gated / login | CPU speed | Download |
|---|---|---|---|---|---|
| pyannote `speaker-diarization-3.1` | MIT (`pyannote-audio.LICENSE`) | MIT per HF metadata (`huggingface-model-metadata.json`) | **Gated (auto-approve)**: HF account, token, form with company + website; the form text says they may email about paid services | not run (no token) | not measured |
| pyannote `speaker-diarization-community-1` | MIT | CC-BY-4.0 per HF metadata | **Gated (auto-approve)**: company + use case form | not run | not measured |
| NVIDIA Sortformer `diar_sortformer_4spk-v1` | NeMo Apache-2.0 (`nemo.LICENSE`) | **CC-BY-NC-4.0: not for commercial use** | not gated | not run | not measured |
| NVIDIA streaming Sortformer v2 | NeMo Apache-2.0 | CC-BY-4.0 | not gated | not run (needs NeMo + PyTorch, max 4 speakers per model card) | not measured |
| **sherpa-onnx + pyannote segmentation-3.0 (ONNX copy) + WeSpeaker ResNet34 embedding** | sherpa-onnx Apache-2.0 (`sherpa-onnx.LICENSE`); WeSpeaker Apache-2.0 (`wespeaker.LICENSE`) | segmentation: MIT, `LICENSE` file shipped inside the GitHub release tarball (`pyannote-segmentation-3-0.onnx-bundle.LICENSE`); embedding: Apache-2.0 per the HF metadata of the Wespeaker repo | **No gate**: both files are plain GitHub release downloads | **RTF 0.41-0.42**, 224-243 MB RSS (measured, 120 s and 300 s) | 6.0 MB (1.5 MB int8) + 26.5 MB |
| SpeechBrain ECAPA (embedding only, no pipeline) | Apache-2.0 | Apache-2.0 per HF metadata | not gated | not run | not measured |

Choice for the default path: **sherpa-onnx with the pyannote-segmentation-3.0 ONNX and WeSpeaker ResNet34**: no gated login and licence files for code and weights that permit commercial use. What I did NOT verify and you should not claim:
- That the `wespeaker_en_voxceleb_resnet34.onnx` I downloaded from the sherpa-onnx release is the same licensed artefact as the Wespeaker HF repo (I assumed it is; the release page was not read for a licence statement).
- Licences of the TRAINING data (VoxCeleb is YouTube audio; the pyannote model card lists meeting/web datasets). A licence on weights does not settle that. This is a legal question I cannot answer.
- Accuracy: no labelled reference, 3-4 speakers detected on a clip I believe has 2 hosts.
- Diarization is not wired into `services/asr`; `DIARIZATION_PROVIDER` only allows `mock|none`.
pyannote 3.1 is MIT too but is gated, so it needs a human to accept terms with a token in the deployment; I did not pick it.

## 6. Spike
See `docs/SPIKE_ASR.md` (RTF 0.21 for base.en end to end, 715 MB RSS, 2.2 s load; medium.en is slower than real time).

## 7. Git log and untouched packages
```
2325e8a Add REVIEW_INFRA.md and update STATUS.md for the infra workstream
ddf5f85 Add ASR spike report with raw outputs
04a641d Record sources and licence evidence (clips, packages, diarization options)
ecb3517 Add model benchmark, download-size and sherpa-onnx diarization spike scripts; share one app image in compose
ebcc1c1 Add media tools: ffprobe wrapper (exact fps, VFR), audio silencedetect, clamp word times to detected silence
788b93c Add ASR spike scripts: synthetic clip generator and disfluency prompt test
81723b7 Add ASR service: faster-whisper (CPU int8, word timestamps, VAD) and mock adapters, integer us / permille wire format
4845725 Add placeholder api, worker, asr services, init script, Dockerfile and docker-compose
2440e37 Add S3 client helper and ensureBucket
b9b69f3 Add plain-SQL migration runner and first migration (7 tables, append-only operation_log)
9ab3683 Add zod config loader that fails fast on bad env, and .env.example

$ git diff origin/main --stat -- packages/engine packages/contracts
(empty)
```

## 8. NOT implemented or NOT verified (plain list)
- Real api and worker: the two are placeholders that answer /health and /ready only. No pg-boss, no idempotency logic, no OpenAPI.
- The compose end-to-end test (upload, transcribe, render) does not exist. `tests` only runs `npm test`.
- Python ASR tests are not part of `docker compose run tests` (they run with `python -m pytest` in `services/asr`).
- The real faster-whisper adapter was run from a host Python 3.13 venv, not inside the Docker image (3.12).
- Diarization: evaluated and benchmarked outside the service; not integrated; accuracy unmeasured; training-data licences unchecked; two of the options (pyannote) were not run at all.
- Disfluency prompt effect: one synthetic clip with known truth, one real clip with no truth. Not a conclusion.
- Silence/clamp thresholds untested on real data beyond one 120 s clip; clamping results not compared with hand-labelled boundaries.
- Word-start stretching in front of speech is handled symmetrically, but only the end-stretch case appeared in the real clip.
- Disk resize: not performed by me (already 50 GB).
- No timings were taken under load; RTF varied up to ~30% between runs of the same model.
- SeaweedFS image is `:latest`; MinIO stays unusable here (pull denied).
- `npm audit` findings and `AI_USE.md` are untouched.
- Migrations are tested forward only; there is no down/rollback.
