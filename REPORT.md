# REPORT: prompt-based video editing engine

Every number here comes from a file in the repository; the link is next to it. Where I did not measure something, it says "not measured". Claim-to-file index: [`test-pack/INDEX.md`](test-pack/INDEX.md). Item-by-item status: [`docs/SUBMISSION_EVIDENCE.md`](docs/SUBMISSION_EVIDENCE.md) (39 Yes, 18 Partial, 0 No of 57 rows; re-checked against the live URL on 2026-10-24, see [`docs/FINAL_CHECK.md`](docs/FINAL_CHECK.md)). I do not claim any of the three levels as fully passed.

## 1. Approaches considered and what I chose

**Anchoring edits to content.** The obvious design keeps a list of cuts and effects in seconds and patches the times after every edit. I rejected it because a caption, mute or bleep would then depend on the order of patches, and undo and restore would be hard to make exact. I chose **atoms**: the source is split once into words and silences with stable ids (derived from the file's sha256, position and text), and every effect names an atom range ([`docs/TIMELINE_SCHEMA.md`](docs/TIMELINE_SCHEMA.md), [`docs/DESIGN.md`](docs/DESIGN.md)). A cut before a caption changes where the caption plays, not what it is attached to.

**State.** I chose an **append-only operation log** and `timeline = replay(log)`. One instruction is one group, so one undo step; "restore edit N" is a new operation that points at group N; nothing is rewritten. The timeline hash is the sha256 of its canonical JSON, with no clock or random ids, so the same history gives the same hash. The cost is that effect ids count edit operations, so two different histories that look identical can hash differently (stated in DESIGN.md). To keep replay fast on long sessions I memoise by object identity; this is covered by a property test against a fresh replay ([`docs/PERF_ENGINE.md`](docs/PERF_ENGINE.md)).

**Understanding instructions.** Options: send everything to a language model, or parse by rules. I chose **a rules parser first and a model only as fallback**. Rules are fast (median 15 ms, below) and deterministic. The model (Gemini) can only return a closed list of commands that zod validates and our own code applies; invalid output becomes a rejection, never a guess. The cost is coverage: the rules read the phrasings the brief needed, and a model call can take 18 to 36 s in my probe ([`docs/raw/m4_llm_latency_probe.txt`](docs/raw/m4_llm_latency_probe.txt)), so the call is cut off at 2.5 s and the answer says to repeat (the late reply is cached).

**Rendering.** Options: encode each piece and join them, or build one filter graph. I chose **one ffmpeg run with one generated filter graph**. Encoding pieces separately risks drift at every join; the graph trims by frame number and pads audio to the exact frame count, then ffprobe checks the result. My first graph (one split per stream) was quadratic: 361 pieces took 149 s at 1080p; grouping 30 pieces on seeked inputs took 58 s ([`docs/REVIEW_M3.md`](docs/REVIEW_M3.md) section 4).

**Other choices, with reasons in the linked files.** Real faster-whisper `base.en` as default after comparing four sizes (`medium.en` is slower than real time on 4 vCPUs, [`docs/SPIKE_ASR.md`](docs/SPIKE_ASR.md)); sherpa-onnx diarization chosen on licences ([`docs/REVIEW_INFRA.md`](docs/REVIEW_INFRA.md) section 5); SeaweedFS instead of MinIO because the MinIO image would not pull (REVIEW_INFRA); every external service behind an adapter with a mock so all tests run with no keys.

## 2. What works (all measured)

- **Worked example on a real recording, real ASR:** nine steps with the brief's behaviour, undo returns to the exact earlier hash, second run gives 9 of 9 identical hashes ([`docs/WORKED_EXAMPLE_REAL.md`](docs/WORKED_EXAMPLE_REAL.md)). The brief's exact numbers are reproduced on the engine fixture (scenario S01), not on the real video (see 3).
- **Render accuracy.** All 11 real renders in the latest batch: frame difference 0 against the timeline, audio minus video length at most 0.02 frame ([`test-pack/real/batch_720p_m5e/`](test-pack/real/batch_720p_m5e/summary.json), `*/render_1_manifest.json`). On generated clips with a flash and a beep at the same frame, worst A/V offset 0.20 to 0.44 frame (25, 30, 29.97 fps and VFR) and 0.002 to 0.003 frame in unedited stretches; a deliberate 0.1 s shift fails the test with 2.5 frames ([`docs/REVIEW_M3.md`](docs/REVIEW_M3.md) section 3). The red caption stayed on the right frames before the cut, after it and after the restore.
- **Tests.** `docker compose run --rm tests` passes in a fresh clone with no keys ([`docs/raw/m5_ci_simulation.txt`](docs/raw/m5_ci_simulation.txt)); 48 scripted scenarios with expected results, 50 of 50 ([`docs/raw/m5b_scenarios_run.txt`](docs/raw/m5b_scenarios_run.txt)); 40 engine mutants all killed ([`docs/REVIEW_M1C.md`](docs/REVIEW_M1C.md) section 5).
- **Integration Standard:** 8 of 10 rows Yes and 2 Partial in the evidence table (live callbacks are unsigned because no secret is set on the demo; no log line carries both the job id and the correlation id), each with its limit.

## 3. What does not work, and why (real failures, kept)

| Failure | What happened | Evidence |
|---|---|---|
| Brief's script on my recording | My recording says "welcome to **our** channel" and mentions pricing 7 times, not "the channel" and 3. Sessions 01 and 02 fail by design and are kept; I ran the same steps on the recording's real numbers | [`docs/TEST_MEDIA.md`](docs/TEST_MEDIA.md) section 1 |
| Two speakers on real speech | On the NASA clip the diarizer gives 3 speakers for 2 without a hint, and with a hint still one effective speaker; `nasa_speaker_scoped_edit` fails. The synthetic dialogue works (142 of 142 words) after I changed the default threshold from 0.5 to 0.3 using a sweep over 6 clips that **no value passes completely** (0.25-0.30 right on 5 of 6) | `docs/TEST_MEDIA.md` "M5d update", [`docs/raw/m5d_diarization_sweep_table.md`](docs/raw/m5d_diarization_sweep_table.md) |
| Fillers | Whisper transcribed 0 "um"/"uh" in my recording. The system lists 29 untranscribed voiced sounds and asks. Nobody listened, so I cannot say how many are real fillers. Session 04 fails | `docs/TEST_MEDIA.md` section 2 |
| Meaning search | On the real recording the MiniLM model added nothing over a small synonym table; "money" is rejected (24.8% against a 25% threshold, tuned on one recording). Session 22 fails | [`docs/REVIEW_M4.md`](docs/REVIEW_M4.md) section 4 |
| Model fallback latency | Gemini took up to 36 s in my probe; no job path for it | `docs/raw/m4_llm_latency_probe.txt` |
| Fresh clone could not run | `.gitignore` had `media/`, which also hid `packages/media/src/voiced.ts` from M4 on. Every earlier "tests pass" ran on my working tree. Found by a fresh-clone simulation and fixed | [`docs/raw/m5_ci_simulation_run1_failed.txt`](docs/raw/m5_ci_simulation_run1_failed.txt) |
| Music on longer videos | ffmpeg's expression parser failed at about 100 terms; found by a 200 s scenario; fixed with a balanced expression tree | [`docs/REVIEW_M5.md`](docs/REVIEW_M5.md) section 4 |
| Upload and ASR timeouts | A 200.4 MB file hit a 200 MB cap (reset instead of a clean 413); Node `fetch` cut ASR calls at 300 s. Both fixed and re-run | [`docs/DEPLOY.md`](docs/DEPLOY.md) last section |
| Multi-part instruction while a question is open | Found in the final live check: with an open clarification, "cut ..., then speed up ... 10x, then add a caption ..." applied only the caption and dropped the other two parts with no warning (fresh session: "Applied 2 of 3 parts" and the failed part named). Not fixed | `docs/raw/final_probe_p7_pending_then_multipart.json`, `docs/FINAL_CHECK.md` |
| My deployment mistakes | For about 10 minutes ports 8080 and 8333 were published again because I ran compose without the production file; the dotted URL had no certificate at first | `docs/DEPLOY.md` |

Not covered at all: any real two-person edit, a real phone VFR video, a 60-minute video through the API, filler ground truth, HDR and 10-bit render paths, opening the OTIO file in an editor, a GitHub Actions run, a listening test of cut points. The full list is in the last column of the evidence table.

## 4. Measured numbers

All on one GCP VM (`e2-standard-4`, 4 vCPU, 16 GB, Mumbai), one run per condition unless stated. They are not benchmarks.

| Metric | Result | Source |
|---|---|---|
| Instruction latency, real API | median **15 ms**, 95th percentile 41 ms, slowest **88 ms** over 115 instruction steps (client side, 38 sessions, videos 14 s to 4:00). 4 steps were Gemini cache hits | `test-pack/real/batch_720p_m5e/*/results.json` |
| Instruction latency, 5-min video | not measured (the longest video in the batch is the 4:00 NASA clip; the longest with picture is 3:00) | |
| Instruction latency, 60-min video | engine alone on a **synthetic** 60-minute, 24,001-atom source: slowest single 155.9 ms, 4,000-op instruction about 58 ms. That run was on a laptop (Core i3), not the VM. Through the API with a database: **not measured** | `docs/PERF_ENGINE.md` |
| Render speed | about **50 s** (wall, including fetch and upload) per output minute at 720p `veryfast` (pooled over 6 real renders: 46 to 53); 65.4 s per output minute at 1080p (one run, full-resolution worked example). About 9.5 s per output minute on the short 360p clips | manifests in `test-pack/real/batch_720p_m5e/`, `docs/WORKED_EXAMPLE_REAL.md` |
| Speech recognition RTF | `base.en` 0.206 on 120 s of speech (tiny 0.123, small 0.506, medium 1.334; about +/-30% run to run) | `docs/SPIKE_ASR.md` |
| Diarization RTF | 0.41 (120 s) and 0.42 (300 s) | `docs/SPIKE_ASR.md`, `docs/raw/diar_nasa_*.json` |
| Whole intake (upload, probe, ASR, diarization, silence, atoms) | 125 s for the 180.3 s recording (0.69 of real time, fresh); 5 s on a cached transcript | `docs/WORKED_EXAMPLE_REAL.md`, `results.json` `intake.ms` |
| Frame accuracy | length difference 0 frames on all renders above; worst A/V offset 0.44 frame (generated clips); on real footage only frame counts and one speech onset were checked (audio onset 9.517 s, caption 9.533 s) | `docs/REVIEW_M3.md` section 3, `docs/WORKED_EXAMPLE_REAL.md` section 3 |
| Determinism | 9 of 9 step hashes identical on two real runs; three runs through the runner; six scenarios run three times. Not "100% of all sessions over 3 runs": I did not run that | `runner.test.ts`, `scenarios.test.ts` |
| Cold start | `/ready` after **64.3 s** from empty volumes with images built (M2 stack); **23.8 s** after `down` and `up -d` on the production stack. One run each, build time not included | `docs/raw/m2_cold_start.txt`, `docs/raw/m6a_cold_start.txt` |
| Clarification quality, word clipping | **not measured** (no counted asked-versus-guessed set; no listening check of 20 cuts) | |

## 5. Cost per minute of video on this VM

Price source: gcloud-compute.com listing for `e2-standard-4` in asia-south1, fetched 2026-10-22: **0.161 per hour** on demand (currency not labelled on the page; I treat it as US dollars). I did not check it against Google's own calculator or my bill, so this is a list-price estimate ([`docs/DEPLOY.md`](docs/DEPLOY.md)). Per vCPU-second that is 0.161 / 3600 / 4 = 0.0000112.

| Step | Basis | Cost per minute |
|---|---|---|
| Render, 720p | **145 CPU-seconds per output minute** (render manifests: 6 renders, 328.9 CPU-s for 130.4 s output in the worked example) x 0.0000112 | **about 0.0016** |
| Render, 1080p | 220 to 238 CPU-seconds per output minute (4 renders, [`docs/REVIEW_M3.md`](docs/REVIEW_M3.md) section 5) | about 0.0025 to 0.0027 |
| Intake (speech-to-text + diarization) | CPU time was not saved for the real intake. Wall time: 41.6 s per source minute, VM used by one job at a time, x 0.0000447 per VM-second | about 0.0019 (wall-clock basis, an upper bound if the VM is otherwise idle) |
| Gemini fallback | about 556 input + 25 output tokens per call at the paid-tier list rate ($0.30 / $2.50 per million tokens): **$0.00023 per call**, only when rules cannot read the instruction; which tier my key is on is unknown | `docs/REVIEW_M4.md` section 5 |
| **Total, one minute of video ingested and rendered once** | 0.0019 + 0.0016 (720p) | **about 0.0035; about 0.0045 at 1080p** |

Not included: the 49 GB disk, the external IP, network egress (every download), storage, and sustained-use discounts. **Keeping the VM running costs 0.161 x 24 = about 3.9 per day, 117.5 per month, whatever the traffic**, which is far larger than the per-minute processing cost at demo volume. The manifests still carry `usd: null`, because no price is configured in the service; this table is the only place the money figure is computed.

## 6. What I would do next

1. Record one real two-person video (with consent) and run the guest/host edit; the diarizer's behaviour on real speech is the largest open risk. Try a stronger diarization model and a per-recording threshold instead of one default.
2. Get ground truth for fillers (listen and label the 29 candidates) and score the detector; try a larger Whisper model only for filler recovery.
3. Run a real 60-minute video through the API and measure instruction latency and render time; render with a hardware encoder or lower preset if needed.
4. Run the CI workflow on GitHub and fix what a cold runner shows (disk, time).
5. Open the OTIO export in DaVinci Resolve or similar and fix the `LinearTimeWarp` reading.
6. Add a job path for the Gemini fallback so a slow model reply is not lost; run a listening test of 20 cuts to measure word clipping.
7. Pin a static IP and a real domain, test reboot survival, and put CPU time (not only wall time) of intake into the manifests so the cost figure comes from the service itself.
