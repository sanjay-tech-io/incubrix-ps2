#!/usr/bin/env bash
# Builds ./pack, the read-only folder Caddy serves at /pack/ (deploy/Caddyfile): the outputs of the session-pack runs.
# Hard links, not copies: no extra disk, and nothing in test-pack/ is touched. Re-run after a new batch.
# test-pack/ holds outputs only (no input media); test-pack/real/nasa (transcripts of a third-party recording) is left out.
set -euo pipefail
cd "$(dirname "$0")/.."
out=pack
# Empty the folder, do not remove it: Caddy bind-mounts it, and a re-created directory would be a stale mount until Caddy restarts.
mkdir -p "$out"; find "$out" -mindepth 1 -delete
cp -al test-pack/. "$out"/
# Transcripts of a third-party recording (rights caveat in SOURCES.md): not republished.
rm -rf "$out/real/nasa"
cat > "$out/README.txt" <<'TXT'
IncuBrix session pack (read-only). The folder layout is the one of test-pack/ in the repository: /pack/<path after test-pack/>.
  real/batch_720p_m5e/  final run (38 sessions, 33 pass, 5 fail)   <- the one to use
  real/batch_720p/      earlier run (36 sessions, 30 pass, 6 fail)
  m3_real/              first real-footage run (22 sessions, 17 pass, 5 fail)
  real/worked_example_real/, real/worked_example_real_frames/  full-resolution worked example and its three renders
Each session folder: results.json, timeline.json, render_N.mp4, render_N_manifest.json (a session that fails before rendering has results.json only). Failed sessions are included.
Index and claim-to-file table: INDEX.md (here) = test-pack/INDEX.md in the repository.
TXT
echo "linked: $(find "$out" -name '*.mp4' | wc -l) videos, $(du -shL "$out" | cut -f1) (hard links, no extra disk)"
