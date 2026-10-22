# Deployment of the live demo (M6a)

Written 2026-10-22 after the commands below were run on the demo VM. Raw outputs: `docs/raw/m6a_*`. Anything not run is under "Not done or not verified".

## URL
- API and docs: **https://34-93-140-79.sslip.io** (Swagger UI: `/docs`, spec: `/openapi.yaml`, `/health`, `/ready` need no token).
- The name is the VM's external IP with dashes under sslip.io (free wildcard DNS; it resolves back to the IP). Certificate: Let's Encrypt, issued by Caddy on 2026-10-22 (log in `docker compose logs caddy`; challenge tls-alpn-01 on port 443).
- **If the VM's external IP changes the URL changes** (the IP is ephemeral unless it was reserved as static; I could not check, `gcloud` here has insufficient scopes). Then set the new `PUBLIC_HOST` in `.env` and restart Caddy (below). A new name means a new certificate; sslip.io is a shared parent domain, so Let's Encrypt's per-domain limits can be hit by other users.

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
| `MAX_UPLOAD_MB` | 200 | Caddy (`request_body`) and API | 210 MB upload: 413 JSON `FILE_TOO_LARGE` (`m6a_upload_cap.txt`) |
| `MAX_VIDEO_DURATION_S` | 300 | worker, right after probe, before ASR | 310 s video: job failed `VIDEO_TOO_LONG` (`m6a_duration_cap.txt`) |
| `MAX_INGEST_JOBS` / `MAX_RENDER_JOBS` | 1 / 1 | `claimNextJob` (advisory lock + running counts) | unit test with 6 concurrent claimers (`store.test.ts`). The worker is also a single serial loop. Not observed under real concurrent load. |

## Cold start (`docker compose down` then `up -d`, no reboot, no rebuild, volumes kept)
`docs/raw/m6a_cold_start.txt`: `down` 19.4 s; `up -d` returned after 21.4 s; **`/ready` returned 200 over HTTPS 23.8 s after `up -d` started** (certificate reused, no new issuance). One run only. The first ASR job after a restart loads the model; its extra time was not measured separately.

## Cost of keeping the VM running
- Machine: `e2-standard-4` (4 vCPU, 16 GB), zone `asia-south1-c` (Mumbai), from the metadata server.
- Price: a third-party listing (gcloud-compute.com, asia-south1 page, fetched 2026-10-22; currency not labelled) gives **0.161 per hour, 117.51 per month** for on-demand e2-standard-4. **Not checked against Google's own calculator.** This is compute only: the 49 GB boot disk, the external IP, network egress (every video download) and any sustained-use discount are not included. A stopped VM does not pay for compute but still pays for disk and, if static, the IP.
- I could not read the billing account, so this is a list-price estimate, not a bill.

## Not done or not verified
- Secrets: the running stack still uses the public dev defaults for the S3 keys and the database password (the rotation was not authorised in this session). `packages/config` now refuses them in production, **but the running images were built before that check**, so the next `up -d --build` will fail until `.env` has `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `POSTGRES_PASSWORD` and a matching `DATABASE_URL` (the database user's password must also be changed with `ALTER USER`). Until then anyone who knows the public dev S3 secret can sign download links for any stored file.
- Swagger UI was fetched (HTML, JS, CSS and the spec return 200) but **not opened in a browser**; "Try it out" and the Authorize flow are untested.
- Reboot survival: not tested (you asked me not to reboot). `systemctl restart docker` was not tested either.
- Outside access: `/ready` was fetched through an external fetch service and Let's Encrypt validators reached port 443; the smoke test and the download ran from this VM against the public name (hairpin through the external IP), not from another machine.
- A static external IP and the GCP firewall rules were not inspected (insufficient `gcloud` scopes); ports 80/443 evidently are open.
- Load: no concurrent-user test; one in-memory rate limiter (one API process).
- The ASR service has no authentication (internal network only).
