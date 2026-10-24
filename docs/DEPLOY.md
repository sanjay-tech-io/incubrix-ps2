# Deployment of the live demo (M6a)

Written 2026-10-22 after the commands below were run on the demo VM. Raw outputs: `docs/raw/m6a_*`. Anything not run is under "Not done or not verified".

## URL
- API and docs: **https://34-93-140-79.sslip.io** (also **https://34.93.140.79.sslip.io**, the same IP with dots; see "ERR_SSL_PROTOCOL_ERROR" below) (Swagger UI: `/docs`, spec: `/openapi.yaml`, `/health`, `/ready` need no token).
- The name is the VM's external IP with dashes under sslip.io (free wildcard DNS; it resolves back to the IP). Certificate: Let's Encrypt, issued by Caddy on 2026-10-22 (log in `docker compose logs caddy`; challenge tls-alpn-01 on port 443).
- **If the VM's external IP changes the URL changes** (the IP is ephemeral unless it was reserved as static; I could not check, `gcloud` here has insufficient scopes). Then set the new `PUBLIC_HOST` and `PUBLIC_HOST_ALT` in `.env` and restart Caddy (below). A new name means a new certificate; sslip.io is a shared parent domain, so Let's Encrypt's per-domain limits can be hit by other users.

## Token
- `API_TOKEN` is in `.env` on the VM (mode 600, never committed). Send `Authorization: Bearer <token>`. `/health`, `/ready`, `/docs`, `/openapi.yaml` need none. In Swagger UI press **Authorize** and paste it; "Try it out" then works.
- Rotate: replace the `API_TOKEN=` line in `.env` (`openssl rand -hex 32`), then `docker compose up -d api worker` (containers read env at start). The old token stops working at once. Production refuses to start with no token or one shorter than 16 characters.

## Start, stop, restart
All commands from the repo directory; `COMPOSE_FILE` makes plain `docker compose` mean "base + production":
```
export COMPOSE_FILE=docker-compose.yml:compose.prod.yml
docker compose up -d --build     # first deploy or after a code change
docker compose ps
docker compose logs -f api       # JSON logs; the token is redacted
docker compose restart api worker
docker compose down              # keeps volumes (database, storage, models, certificate); NEVER add -v
```
Every long-running service has `restart: unless-stopped`; Docker and containerd are `enabled` in systemd (`systemctl is-enabled docker containerd` = enabled). Only `init` (one-shot migrations) does not restart.

## What is public
Only Caddy publishes ports: **80 and 443** (`ss -ltn` shows nothing else; compose `ports: !reset []` removes 8080 and 8333). Postgres, storage (SeaweedFS), ASR, worker and API are on the compose network only. Caddy sends `/<bucket>/*` GET/HEAD to storage (download links; PUT/DELETE answer 405), everything else to the API. No access log is written (it would contain the signatures of download links).

## Limits (env, defaults in `compose.prod.yml`, listed in `.env.example`)
| Setting | Production value | Where enforced | Observed |
|---|---|---|---|
| `API_TOKEN` | required | config at startup (unit test) | |
| `RATE_LIMIT_PER_MIN` | 120 per client IP, counted before the token check | API | 130 requests with a wrong token: 118x 401 then 12x 429 with `Retry-After` (`m6a_rate_limit.txt`) |
| `MAX_UPLOAD_MB` | 2048 (was 200 until 2026-10-23) | Caddy (`request_body`, in MiB) and API | 2.2 GiB upload: 413 JSON `FILE_TOO_LARGE` in about 0.1 s (`m5d_upload_over_cap.txt`); 2 GB upload accepted (`m5d_upload_2gb.txt`) |
| `MAX_VIDEO_DURATION_S` | 300 | worker, right after probe, before ASR | 310 s video: job failed `VIDEO_TOO_LONG` (`m6a_duration_cap.txt`) |
| `MAX_INGEST_JOBS` / `MAX_RENDER_JOBS` | 1 / 1 | `claimNextJob` (advisory lock + running counts) | unit test with 6 concurrent claimers (`store.test.ts`). The worker is also a single serial loop. Not observed under real concurrent load. |

## Cold start (`docker compose down` then `up -d`, no reboot, no rebuild, volumes kept)
`docs/raw/m6a_cold_start.txt`: `down` 19.4 s; `up -d` returned after 21.4 s; **`/ready` returned 200 over HTTPS 23.8 s after `up -d` started** (certificate reused, no new issuance). One run only. The first ASR job after a restart loads the model; its extra time was not measured separately.

## Cost of keeping the VM running
- Machine: `e2-standard-4` (4 vCPU, 16 GB), zone `asia-south1-c` (Mumbai), from the metadata server.
- Price: a third-party listing (gcloud-compute.com, asia-south1 page, fetched 2026-10-22; currency not labelled) gives **0.161 per hour, 117.51 per month** for on-demand e2-standard-4. **Not checked against Google's own calculator.** This is compute only: the 49 GB boot disk, the external IP, network egress (every video download) and any sustained-use discount are not included. A stopped VM does not pay for compute but still pays for disk and, if static, the IP.
- I could not read the billing account, so this is a list-price estimate, not a bill.

## Not done or not verified
- Secrets: rotated afterwards, see "Secret rotation" below.
- Swagger UI was fetched (HTML, JS, CSS and the spec return 200). It was later opened in a browser by the candidate; see "Browser check" at the end of this file. Only the three calls named there were reported; nothing else of "Try it out" and Authorize was reported.
- Reboot survival: not tested (you asked me not to reboot). `systemctl restart docker` was not tested either.
- Outside access: `/ready` was fetched through an external fetch service and Let's Encrypt validators reached port 443; the smoke test and the download ran from this VM against the public name (hairpin through the external IP), not from another machine.
- A static external IP and the GCP firewall rules were not inspected (insufficient `gcloud` scopes); ports 80/443 evidently are open.
- Load: no concurrent-user test; one in-memory rate limiter (one API process).
- The ASR service has no authentication (internal network only).

## Secret rotation (2026-10-22, after approval)
What was done: random values for `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `POSTGRES_PASSWORD` were generated and appended to `.env` only (mode 600, ignored by git; no value printed or committed; a scan of the working tree for the four secrets found them in no tracked or new file). `DATABASE_URL` was updated to the new password. The database password was changed on the existing volume with `ALTER USER` (before the `.env` change), then `docker compose up -d --build` recreated the containers; SeaweedFS reads its identity from the environment at start, so no data had to change. Production config now accepts these values (the new guard refuses the dev defaults).

| Check | Result | Evidence |
|---|---|---|
| BEFORE: link signed with the public dev key, against the public host | HTTP 200, the whole 1,635,514-byte render | `docs/raw/m6a_rotation_before.txt` |
| AFTER: the same link kind signed with the old key (render and original) | **HTTP 403** for both | `docs/raw/m6a_rotation_after.txt` |
| Old stored files readable with the new key (fresh links from the API) | original: HTTP 200, sha256 prefix `f8a0bd39217b23fc` = the local file's; earlier render: HTTP 200, `e550506d1f5526cd` = the hash recorded before rotation | same file |
| Stack after rebuild | all six services healthy; `/ready` 200; migrations: 0 applied (nothing lost) | `docker compose ps`, init log |
| Smoke test through the public URL on a NEW clip (upload, ASR, captions, cut, render, download) | PASS in 17.3 s; render 15.4 s, h264 + aac | `docs/raw/m6a_smoke_after_rotation.txt`, `m6a_smoke_after_rotation_out/` |

Limits of this check: only GET links were tested with the old key (403 on two objects); I did not try other S3 operations with the old key, but the public door only forwards GET/HEAD and storage is not published. The smoke test again ran from this VM against the public name. The database login itself was exercised by the API/worker restarting healthy and the smoke test (no separate login test). Rebuild took 3 min 14 s. A copy of the pre-rotation `.env` is in the session scratchpad (not in the repo) and contains the old values.

## ERR_SSL_PROTOCOL_ERROR on the dotted name (2026-10-22, fixed)
Report: from a laptop browser and a phone, `https://34.93.140.79.sslip.io/docs` gave ERR_SSL_PROTOCOL_ERROR.

**Diagnosis** (raw: `docs/raw/m6a_ssl_diagnosis_before.txt`, 13:54 UTC): Caddy was fine and listening on the host (`ss -ltn`: 0.0.0.0 and [::] on 80 and 443; `docker port`: 80/tcp, 443/tcp). Its log showed no issuance error and no rate limit: it had one certificate, for `34-93-140-79.sslip.io` only. The dotted name resolves to the same IP, but Caddy had no site and no certificate for it, so the TLS handshake ended with alert 80 `internal error` (`curl -vI`: `tlsv1 alert internal error`; `openssl s_client -servername 34.93.140.79.sslip.io`: "no peer certificate available"). The same two commands with the dashed name worked (CN `34-93-140-79.sslip.io`, Let's Encrypt, verify OK). I used the dashed form in every earlier test and in all my reports, so I never exercised the form you typed. That is my gap.

**Fix**: the site address in `deploy/Caddyfile` is now `{$PUBLIC_HOST}, {$PUBLIC_HOST_ALT}`; `compose.prod.yml` requires `PUBLIC_HOST_ALT` and `.env` has `PUBLIC_HOST_ALT=34.93.140.79.sslip.io` (not a secret; no secret was touched). Only Caddy was recreated (`docker compose up -d caddy`); Let's Encrypt issued the second certificate in 7 s (http-01, no rate-limit message).

**Proof** (raw: `docs/raw/m6a_ssl_diagnosis_after.txt`, 13:56 UTC, same commands): `curl -vI https://34.93.140.79.sslip.io/health`: TLS 1.3, subject CN=34.93.140.79.sslip.io, SAN matches, issuer Let's Encrypt YE1, expires 2027-01-20, "SSL certificate verify ok". `openssl s_client`: subject and SAN `DNS:34.93.140.79.sslip.io`, verify return code 0. GET `/health`, `/ready`, `/docs` return 200 with verified certificates on BOTH names; the API with the token over the dotted name reaches its handler (404 for an unknown job). An external fetch service also got `{"status":"ok","service":"api"}` from `https://34.93.140.79.sslip.io/health`.

Not verified: I have no browser or phone here, so I did not see `/docs` render in one; please reload it (a browser may cache the failed attempt for a minute). Download links in API answers used the dashed name at that time; see "HEAD and dotted download links" below for the change. `curl -I` (HEAD) shows 404 on every route, dashed or dotted, because the API does not serve HEAD (`exposeHeadRoutes: false`); GET works, and I did not change that. The same trap exists for any other spelling (for example a bare IP, `https://34.93.140.79/`), which fails the same way because a Let's Encrypt certificate cannot be issued for a bare IP here.

## HEAD and dotted download links (2026-10-22)
**HEAD**: `HEAD /health` and `HEAD /ready` are registered next to GET (same handler, so the same status, including 503 for `/ready`; no body). They are in `openapi.yaml` (`healthHead`, `readyHead`) and in the route test, which now includes HEAD in both directions; a test checks status, empty body and content-type against GET. HEAD stays closed elsewhere (`HEAD /api/v1/jobs/x` without a token is 401, with a token on a test stack 404). Outside, on both names (`docs/raw/m6a_head_outside.txt`): HTTP/2 200, `content-type: application/json`, `content-length` 31 / 34, 0 body bytes; an external fetch of `/openapi.yaml` shows both `head` operations.

**Dotted download links**: `S3_PUBLIC_ENDPOINT` is now `https://${PUBLIC_HOST_ALT}` (`compose.prod.yml`). Result (`docs/raw/m6a_dotted_links.txt`): the render's video and manifest links have host `34.93.140.79.sslip.io`; the dotted link returns 200 with the same SHA-256 prefix as the runner's file; an old stored original read through the dashed API host also returns a dotted link and 200. **The same link fetched on the dashed host returns 403**: the signature covers the Host header, so a link works only on the name it was signed for. The dashed name keeps working for the API, `/docs`, `/health`, `/ready` and TLS, not for links signed for the dotted name. Making both work would need links signed per request host; not built.

**Smoke test through the dotted name** (`docs/raw/m6a_smoke_dotted_links.txt`): PASS (upload, ASR, captions, cut, render, download); render 15.4 s, h264 + aac. Ran from this VM against the public name.

**Mistake and exposure window (mine)**: my first deploy of this change ran `docker compose up -d --build` without `COMPOSE_FILE`, so only the base file applied: for roughly 10 minutes (about 14:12 to 14:24 UTC, estimated from command times) ports **8080 (API) and 8333 (storage)** were published on all interfaces again and the API ran with `NODE_ENV=development`. The API token was still required and the S3 keys were the rotated ones, so I have no sign that anything was reachable without them, but I did not check access logs for connections in that window (Caddy keeps none; the API's own log lines show remote addresses and I did not read them). Corrected by redeploying with the override; `ss -ltn` shows only 80 and 443 again. To prevent a repeat, `.env` now sets `COMPOSE_FILE=docker-compose.yml:compose.prod.yml`, so plain `docker compose ...` on this VM always includes the production override (to run only the base file use `COMPOSE_FILE=docker-compose.yml docker compose ...`). The first smoke run of this task, made during that window, was discarded and redone on the corrected stack.

**Tests**: `npm test -w @incubrix/api` in compose: 46 passed (`docs/raw/m6a_head_api_tests.txt`). It first failed because the `tests` service still had the old dev database password hard-coded in `TEST_DATABASE_URL` after the rotation; it now uses `${POSTGRES_PASSWORD}`. The other workspaces were not re-run for this change.

## M5 redeploy (2026-10-22)
- Before: the API token was **never rotated**. Only the S3 keys and the database password were (section "Secret rotation"); the token was generated once in M6a. So there is no "old token" to test: today no token and a wrong token give 401 and the current one is accepted (checked 2026-10-22: 401 / 401 / 404-reaches-handler). Rotating it is the two steps in "Token" above; I did not do it because writing a new secret was not part of the request.
- Test isolation: `docker compose run --rm tests` no longer touches the running services (own `*-test` stack, own network). Proof: `docs/raw/m5b_isolation/` and `docs/REVIEW_M5.md` section 8.3.
- Redeploy: `docker compose up -d --build` with the production override (from `.env` `COMPOSE_FILE`): only `asr`, `init`, `api` and `worker` were recreated (about 2 min 24 s including the image build); Postgres, S3, Caddy and OTIO kept running (their start times did not change). Listening ports afterwards: 80 and 443 only.
- The `otio` container was unused until this redeploy (the old API had no export route). **It must run now**: the API calls it for every export (`OTIO_PROVIDER=http`, and `api` waits for it to be healthy). Without it `GET .../export/otio` answers 503 `SERVICE_UNAVAILABLE`; with `OTIO_PROVIDER=mock` the API would write the file itself (hand-written JSON) and the container could go.
- Outside smoke test on the new version (`docs/raw/m5b_smoke_redeploy.txt`, run from this VM against https://34.93.140.79.sslip.io): GET and HEAD `/health` and `/ready` 200; session PASS (upload, ASR, captions, cut, render, download); then `GET /api/v1/sessions/{id}/export/otio` from the same place: 200, `x-incubrix-export-provider: opentimelineio`, hash header equals the timeline's, 2 clips on a Video and an Audio track, caption markers, clip frames 363 = timeline 363 (14.52 s x 25), the S3 link (dotted public host) serves identical bytes. An external fetch service read `/openapi.yaml` and found `exportOtio`. **The export call itself was made from this VM, not from another machine.**


## Large uploads and the API token (2026-10-23, M5d)
**The "fetch failed after 6 s" of the real-footage run: cause found.** `media/test_single.mp4` is 200,422,585 bytes. The public door's cap was `MAX_UPLOAD_MB` 200, and Caddy's `max_size 200MB` means 200,000,000 bytes (the API's own cap is MiB-based, so the two disagreed). Caddy cut the body at the cap and answered 413 `FILE_TOO_LARGE`, but a client that is still writing sometimes sees the connection reset instead of the answer. Reproduced through the public URL (`docs/raw/m5d_upload_before.txt`): curl got the clean 413 every time; Node's `fetch` got the 413 five times and `fetch failed` / `ECONNRESET` once in six runs, and the session runner hid the real cause ("fetch failed"). The 6 s was the time to send the first ~200 MB.

**Changes**
- `MAX_UPLOAD_MB=2048` in `.env` and as the default in `compose.prod.yml` and `deploy/Caddyfile`; Caddy now uses **MiB** (`max_size 2048MiB`) so Caddy and the API agree to the byte.
- A request that **declares** a size above the cap (Content-Length) is answered at once by Caddy with the JSON `FILE_TOO_LARGE` 413, before any body is read, so a client never gets a reset for an honest over-size file (0.05-0.12 s, 7 of 7 runs with curl and Node fetch: `m5d_upload_over_cap.txt`). Bodies without a Content-Length are still cut at the cap by `request_body`. The matcher was tried on a throw-away Caddy first (3 MB declared against a 1 MiB cap: 413 JSON; 0.5 MB: reaches the upstream; GET: unaffected).
- No server read/write timeout in Caddy (it has none by default); Fastify's request timeout is off by default. Proven by the 2 GB run below, which lasted longer than 5 minutes.
- URL intake: the total download time was a fixed 10 minutes; it is now `DOWNLOAD_TIMEOUT_S` (default 3600). The size cap applies to the declared size first, then while streaming (`apps/worker/test/download.test.ts`).
- The session runner now prints the cause of a network failure (`[ECONNRESET]`) and, for a reset during an upload, the likely reason (the upload limit).
- Streaming: the API writes the upload to a temporary file while hashing it, then streams the file to S3 (`PutObject` from a file stream); nothing is held in memory.

**Proof (all through https://34-93-140-79.sslip.io from this VM, with the real token)**
| What | Result | Raw |
|---|---|---|
| `media/test_single.mp4`, 200,422,585 bytes, curl | HTTP 202 in 4.2 s | `docs/raw/m5d_upload_after.txt` |
| same file, Node `fetch` (the client that failed), 6 runs | 6 of 6 HTTP 202 (3.4-5.1 s) | same |
| 2,362,232,012 bytes (2.2 GiB, over the cap), curl and Node fetch x6 | 413 `FILE_TOO_LARGE`, 0.05-0.12 s, 7 of 7 | `docs/raw/m5d_upload_over_cap.txt` |
| 2,000,000,000 bytes (`test_single.mp4` plus padding), curl throttled to 6 MB/s | **HTTP 202 after 352 s** (longer than Node's 300 s request timeout); the stored original has the **same sha256** as the local file (`1ccf33ae...2d9f`) and size 2,000,000,000 | `docs/raw/m5d_upload_2gb.txt` |
**Not a pass:** the ingest of that 2 GB file then FAILED at the speech-to-text step ("did not answer: fetch failed"). Cause found and fixed below. I deleted the 2 GB test object from storage afterwards (the video row stays, status `failed`).
- **URL intake of a large file through the public URL: not run** (only the worker-level tests above, with a local server).

**A second defect found on the way (fixed): Node's `fetch` gives up after 5 minutes.** The worker called the ASR service with `fetch` and an abort signal of `ASR_TIMEOUT_S` (3600 s), but undici cuts any request whose response headers take longer than 300 s (`UND_ERR_HEADERS_TIMEOUT`). The ASR service answers only when the whole transcription is done, so any transcription that took more than 5 minutes (a long video, or a busy VM: my diarization sweep was using 365% CPU) failed with `ASR_UNAVAILABLE`. Measured: a local server answering after 310 s made `fetch` fail after 301 s with the 3600 s signal (`docs/raw/m5d_fetch_headers_timeout.txt`); the new client (`node:http`, only `ASR_TIMEOUT_S` applies) got its answer after 310 s (`docs/raw/m5d_asr_client_310s.txt`). Unit tests: `apps/worker/test/asr.test.ts` (they cannot wait 5 minutes; the two raw files are the evidence for that part). I did not re-run the 2 GB ingest after the fix.

**API token rotated** (it had never been rotated: M6a rotated only the S3 keys and the database password). New value (32 random bytes, hex) written into `.env` only (mode 600), `docker compose up -d --build --no-deps api worker caddy`. Proof (HTTP codes, no token printed; `docs/raw/m5d_token_rotation.txt`): before, the old token reached the handler (404 for an unknown job) and no token gave 401; after, **the old token gives 401** (also on the dotted host), the new token reaches the handler (404), a wrong token 401, `/ready` 200 without a token. Neither value is in git or in the API log (grep: 0 hits). One honest leak: during the earlier real-footage run I passed the old token on a command line (`--token`) and the `npm run` banner printed it into this session's terminal output, and the first `.env` print also showed the database URL with its password; the token is now dead, **the database password was not rotated** (do you want that?).
**Side effect:** `docker compose up -d --build` on a changed `.env` recreates every service that reads it; I used `--no-deps` and named services. The build cache was pruned twice to free disk (49 GB disk, 8 GB free at the end); the first deploy attempt failed with "no space left" while extracting a layer, the running services were not affected, a second attempt after `docker image prune -a` and deleting the 2 GB test object worked.

## Browser check of /docs (2026-10-24, reported by the candidate)
The candidate opened https://34.93.140.79.sslip.io/docs in a browser and reported: `/health` and `/ready` returned 200, and `GET /api/v1/jobs/1` with the token returned 404 with code `JOB_NOT_FOUND` in the error envelope (this is the documented answer for an unknown job). This is the candidate's report: I did not see the browser and no screenshot or file of it is saved. It closes the gap "Swagger UI never opened in a browser" for those three calls only; the other routes' "Try it out" were not reported.

## Session pack download at /pack/ (2026-10-24, M6b)
**What:** the outputs of the session-pack runs (rendered videos, `results.json`, `timeline.json`, manifests, summaries; failed sessions included) are served read-only at `https://34.93.140.79.sslip.io/pack/` with HTTP basic auth. The layout is that of `test-pack/`: a file at `test-pack/<path>` is at `https://34.93.140.79.sslip.io/pack/<path>`. `test-pack/real/nasa/` (transcripts of a third-party recording) is not published. Listing: `https://34.93.140.79.sslip.io/pack/`; start at `README.txt` and `INDEX.md` there.

**How:** `scripts/build_pack.sh` makes `./pack` from `test-pack/` with hard links (62 videos, 1.6 GB, no extra disk; `pack/` is git-ignored). `compose.prod.yml` mounts it into Caddy read-only at `/srv/pack`; `deploy/Caddyfile` has a `handle_path /pack/*` block with `basic_auth` and `file_server browse`; other methods than GET/HEAD answer 405. Re-run the script after a new batch; it empties the folder instead of removing it, so Caddy needs no restart (removing the folder makes the bind mount stale; I did that once, found it when the files answered 404, and recreated Caddy).

**Credentials:** generated by the agent with `openssl rand -hex 16` and written to `.env` (mode 600, git-ignored) as `PACK_USER` (`pack-reader`), `PACK_PASSWORD` and `PACK_PASSWORD_HASH` (bcrypt from `caddy hash-password`, each `$` doubled for Compose). Caddy gets only the user and the hash. The password was not printed. Read it on the VM with `sed -n 's/^PACK_PASSWORD=//p' .env`. There is no rate limit or lockout on this door (the API's limiter does not cover it); the password has 128 bits of randomness. Change it by replacing the three lines and running `docker compose up -d caddy`.

**Retention:** not affected. `apps/worker/src/retention.ts` deletes S3 keys under `renders/` and `videos/` only; the pack is plain files on the VM's disk. It lives as long as the VM and this folder do.

**Test** (`docs/raw/m6b_pack_access.txt`, 2026-10-24, from this VM against the public name; not from another machine): without credentials `/pack/`, a video and a JSON all answer 401; a wrong password 401; with the credentials a 1,635,514-byte render answers 200 `video/mp4`, a range request 206, the 63.9 MB full-resolution worked-example render 200 with the same sha256 prefix as the local file, results of failed sessions 200, the NASA transcripts 404, POST 405. `/health`, `/ready`, `/docs` still 200 and the API still 401 without a token. Caddy was recreated twice for this (a few seconds each); the certificates are in a volume and were reused. The `/pack/../.env` request returned the API's 401 (the path is normalised away from `/pack/`); it shows `.env` is not served but is not a test of the file server's traversal handling.

**My slip:** to check the compose file I ran `docker compose config` and filtered its output with `grep`; the output included the current `POSTGRES_PASSWORD` in this terminal session. It is not in any file or commit. The database is on the internal network only (no published port), but the value is in this session's transcript; rotating it follows the steps in "Secret rotation" above.

