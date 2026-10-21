# M3 review: rendering, session runner, batch runner

Branch `main` (M2 was merged first: merge commit `8a58ef3`, tests exit 0, `docs/raw/m3_merge_tests.txt`). Nothing is pushed.
Raw outputs are in `docs/raw/m3_*` and `test-pack/m3_real/` (results.json, timeline.json and manifests of every session; the rendered `.mp4` and `.png` files are ignored by git).

## 1. What was built
| Item | Where | Evidence |
|---|---|---|
| Render design (approved) and its amendments | `docs/RENDER_DESIGN.md` | read it |
| `packages/render`: timeline -> one ffmpeg filter graph, ffprobe verification, CFR proxy | `packages/render/src` | `packages/render/test` (15 tests) |
| `POST /api/v1/sessions/{id}/render` (202), worker render job, links, manifest, 3 new error codes | `apps/api`, `apps/worker/src/render.ts`, `openapi.yaml`, README error table | `apps/api/test/e2e.test.ts` step 8, `api.test.ts` (schema-validated) |
| Source sha256 checked before AND after (local copy and the stored object) | `apps/worker/src/render.ts` | `e2e.test.ts` (`source.unchanged`), every manifest in `test-pack/m3_real` |
| `npm run session`, `npm run batch` (HTTP clients, no engine code) | `apps/cli` | `apps/api/test/runner.test.ts`, `apps/cli/test` |
| Determinism x3 through the runner | `runner.test.ts` | all 9 step hashes + final hash equal in 3 runs |
| 22 session files (20 numbered + 2 "as recorded" variants) | `sessions/` | batch below |
| Built-in music (generated), "add/remove background music" rule | `packages/media/src/music.ts`, `packages/nlu` | sha256 pinned by a test; envelope test |
| Storage: retry 5xx (limit 4), startup write probe, identical uploads stored once, S3 port published | `packages/storage`, `docker-compose.yml`, `.env.example` | `packages/storage/test/retry.test.ts`, `api.test.ts` |

Engine: **not changed.**

## 2. Test output
`docker compose run --rm tests` exit 0 (`docs/raw/m3_compose_tests.txt`):

| Package | Tests |
|---|---|
| config 9, contracts 4, db 13, engine 249 (+1 skipped), errors 3 | |
| media 26 | incl. built-in music pinned |
| nlu 52 | incl. music rule |
| **render 15** | frame accuracy, features, 300 pieces, no audio |
| storage 9 | incl. 5xx retry |
| store 38, api 36, **cli 2**, worker 8 | api includes the render job, runner determinism, batch |
| Python asr 28 (+2 skipped) | |

The one skipped engine test is `worked_example.test.ts` step 8 ("needs M3"). I left the engine package untouched; step 8 is covered by the API test (`e2e.test.ts`, render job: frame count equals the timeline, original sha unchanged) and by real renders below.

## 3. Frame accuracy (generated media, measured with ffprobe and by decoding)
Clip: ffmpeg `testsrc2` with a burned frame counter; every second a 2-frame white flash and a 4-frame 1 kHz tone that start on the SAME frame. Edit mix: `cut 0:02-0:04; speed up 0:06-0:10 by 2x; move 0:00-0:02 to the end; put back what I removed` (all through the rules parser and the engine). A/V offset = distance between the start of each flash and the start of its tone after rendering, in frames. Run in the container (ffmpeg 5.1.9), raw: `docs/raw/m3_accuracy_*.json`.

| fps | edits | timeline length (frames) | rendered length (frames) | difference | audio minus video length (frames) | A/V offset, worst of 16 events (frames) |
|---|---|---|---|---|---|---|
| 25 | mix | 350 | 350 | 0 | 0 | 0.20 |
| 30 | mix | 420 | 420 | 0 | 0 | 0.44 |
| 29.97 (30000/1001) | mix | 420 | 420 | 0 | 0 | 0.39 |
| 30, source is VFR (via CFR proxy) | mix | 420 | 420 | 0 | 0 | 0.44 |
| 25, one instruction with 300 cuts (301 pieces) | 300 cuts | 1800 | 1800 | 0 | - | 0.003 (100 events) |
| no audio track | - | fails with `NO_AUDIO_TRACK`, nothing rendered | | | | |

The unedited events (outside the sped-up stretch) measure 0.002-0.003 frames. The larger offsets are the three events inside the 2x region: at 2x only every second source frame survives, so a flash frame can land half an output frame from its tone (that is 0.2-0.44 frame, always below 1). The test is sensitive: shifting the audio cut by 0.1 s (a deliberate break I made and reverted) fails it with 2.50 frames.
Other measured features (all in `features.test.ts`): pitch of a 1 kHz tone stays 1 kHz at 2x and 4x (chained atempo); mute silences exactly its word (RMS < 0.005), bleep is a 1 kHz tone at 0.25; caption colour and window checked by pixel diff against an unedited render; music level equals the engine's ducking envelope at every keyframe and mid-ramp within 1 dB (`docs/raw/m3_music_envelope.json`).

## 4. One graph versus many pieces (item 1 of the approval)
Bench: `npm run bench -w @incubrix/render` in the container (4 vCPU VM, ffmpeg 5.1.9, veryfast), generated 1080p30 source of 120 s, N cuts. Raw: `docs/raw/m3_bench_*.json`.

| pieces | strategy | render time | per output minute | ffmpeg peak memory |
|---|---|---|---|---|
| 1 | one graph | 68 s (95 s in a second run) | 34 s (47 s) | 402 MB |
| 361 | ONE split per stream (first design) | 149 s and 154 s | 106 s and 110 s | 1.5 GB |
| 361 | groups of 30 pieces on seeked inputs (final) | 58 s and 59 s | 42 s and 42 s | 2.0 GB |

At 320x240, where encoding is cheap, the first design cost 5.3 s (1 piece), 6.7 (81), 11.3 (161), 21.3 (241), 60.4 (321), 96.9 (401): clearly worse than linear; the final design 5.4, 5.7 (81), 8.8 (241), 18.9 (401). It never failed and every run was frame-exact, so the segment-encode-and-concat fallback was not needed and is not built. Limits and the memory cap (`RENDER_MAX_GROUPS`) are in `RENDER_DESIGN.md`. **Only up to 361 pieces were run.** Run-to-run noise on this VM is real (the 1-piece case took 68 s and 95 s).

## 5. Cost numbers on this VM (real renders, real footage, `docs/raw/m3_batch_summary.json`, manifests in `test-pack/m3_real`)
`media/test_single.mp4`: 1080p HEVC, 180.3 s. Output 1080p H.264 veryfast, CRF 20, with captions where the session has them.

| session | output length | render time | per output minute | ffmpeg peak memory | CPU seconds (manifest) |
|---|---|---|---|---|---|
| 01b worked example | 130.4 s | 171 s | 63.4 s | 618 MB | 517 |
| 03 reorder + mute | 180.3 s | 220 s | 58.1 s | 558 MB | 661 |
| 08 music + cuts | 170.8 s | 229 s | 65.1 s | 555 MB | 666 |
| 16 auto-captions + 4x | 156.7 s | 193 s | 59.2 s | 645 MB | 584 |
| 14 phone-style VFR (640x360, generated) | 17.8 s | 3.4 s | 9.5 s | 111 MB | 6.9 |

**Our cost number for 1080p on this VM: about 60 s of rendering per minute of output (range 58-65 over four sessions), about 4 CPU-minutes per output minute.** The cheap clips (320x240) are far faster; do not quote them as the 1080p number. USD is still `null` (no price configured).
The CFR proxy (HEVC to 8-bit BT.709 H.264) was made once: **282 s for the 180 s file** (read from the worker log of the first render; that log was rotated with the container, it is not saved in `docs/raw/`, so treat it as an observation of one run). Later renders found it stored next to the original and spent 4-5 s fetching it.

Colour facts of the real file (`ffprobe`): pix_fmt yuv420p, 8-bit, colour_space/transfer/primaries bt709, range tv, HEVC Main, 30/1 nominal with average 30.0087: **not 10-bit, not HDR, not flagged VFR by the probe**, so no tone map was needed (the tone-map path is written but NOT run on any file). The proxy was made because it is HEVC (rule in `RENDER_DESIGN.md`).

## 6. Batch summary: 17 of 22 sessions passed, 5 failed (kept as they are)
`docs/raw/m3_batch_summary.json`, per session in `test-pack/m3_real/<name>/` (results.json with every step's status, operations, summary, question, options, hash and duration; timeline.json; renders). Log: `docs/raw/m3_batch_log.txt`. (22 files = 20 numbered + 01b + 02b.)

| session | result | why |
|---|---|---|
| 01_worked_example | **FAIL** (steps 1 and 8) | The real recording says "welcome to **our** channel" at 0:39.5, not "welcome to the channel" at 0:42. The anchor phrase does not exist, so step 1 is rejected and step 8 ("make that caption red") has no caption. The expected results were NOT changed. |
| 01b_worked_example_as_recorded | PASS | Same eight steps with the real phrase. See section 7. |
| 02_caption_cut_restore | **FAIL** | Same missing phrase. |
| 02b_caption_cut_restore_as_recorded | PASS | Same case with the real phrase; the caption goes inactive when its words are cut and returns on restore. |
| 03_reorder_then_mute | PASS (after a fix, section 8) | render of a reorder + mute: 180.3 s, 5409 frames, difference 0 |
| 04_filler_removal_into_bleep | **FAIL** | The transcript has no filler words (Whisper base.en dropped every "um"/"uh"; none of its "like" words matched the filler rule): `bleep "um"` finds nothing. The hard case is covered by engine tests, not by this footage. |
| 05, 06, 07, 09, 10, 11, 12, 18, 19 | PASS | range twice, caption at 5:00 rejected, "80 seconds"/"a minute twenty"/"the last 10 seconds", "make it bigger" without caption rejected, "after thanks" asks (it is said several times), speed 10x and "cut everything" rejected, three parts with one impossible, keep-only + restore edit, "cost" finds the pricing sentence |
| 08_undo_second_to_last_keep_music | PASS | rendered with music: 170.8 s, difference 0 |
| 13_two_speakers_guest_old_job | **FAIL (expected)** | Speaker-aware edits are not built; the parser read "remove everything ..." as the whole video and rejected it. The brief wants a clarification about the host's lead-in. |
| 14_variable_frame_rate_phone | PASS | VFR source accepted with a warning, rendered through the proxy |
| 15_no_audio_track | PASS | intake fails with `NO_AUDIO_TRACK`, no session |
| 16_auto_captions_and_speed | PASS | rendered |
| 17_silences_and_protected_pause | PASS | after I corrected my own wrong anchor (first version pinned 1:21, which is speech; first run rejected it with "inside speech, not a pause"; the file header says so) |
| 20_vague_references | **FAIL (expected)** | "make it shorter", "remove the boring part": rejected with examples; the brief wants a question with options. The rules parser has no vague-reference handling and the real LLM provider is not built. |

Step-by-step answers of the worked example on the real footage (01b), compared with the brief:

| Step | Brief | Real run | Matches |
|---|---|---|---|
| 1 caption on the welcome words | caption at 0:42 | applied, caption at 0:39.501 (the recording differs) | yes, apart from the phrase and time |
| 2 cut first 30 s | caption moves to 0:12 | applied, 3:00.300 -> 2:30.300, caption "moved from 0:39.501 to 0:09.501" | yes (0:09.5 because the words are at 39.5) |
| 3 remove the part about pricing | needs_clarification, 3 mentions | needs_clarification with **7** options (the speaker says "pricing" 7 times) | the behaviour yes, the count no (footage) |
| 3b "the second one" | applied | applied, -4.9 s | yes |
| 4 speed 1:00-1:30 by 2x | applied, policy stated | applied, 2:25.400 -> 2:10.367, "Time policy: current" | yes |
| 5 put the intro back | first 30 s return, caption back at the original time, pricing cut and speed stay | applied, +30 s, caption back to 0:39.501 | yes |
| 6 undo | reverses step 5 only | "Undid edit 5", back to 2:10.367 | yes |
| 7 make that caption red | applied | applied | yes |
| 8 render | in sync, length matches, caption on the right words | 3911 frames = timeline, audio-video -0.02 frames, original sha256 unchanged; a frame at 10.2 s shows the red "Welcome!" (`test-pack/m3_real/frames/`, not committed: it shows the speaker's face) | yes |

## 7. Determinism
`runner.test.ts`: the same 9-step session through the runner 3 times: all step hashes equal, final hashes equal, outputs written. On the real footage each session was run once; I did not run the real batch 3 times.

## 8. Problems found and fixed during M3 (each with its test or evidence)
1. Mono voices lost 3 dB (ffmpeg's default upmix); found by the bleep level test; fixed with an explicit `pan`.
2. One graph with one split per stream was quadratic in the number of pieces (section 4); fixed by grouping.
3. Mute alone failed in the AAC encoder (`Unsupported channel layout "2 channels"`) because `aeval` returns an unnamed layout; found by the REAL session 03 (my tests always had a bleep or music next to the mute); reproduced by a new test, fixed with `aformat`. The error details now carry ffmpeg's last stderr lines.
4. The batch got HTTP 500 from storage twice. The error is NOT the M2 "first write into a brand-new bucket" quirk: the bucket existed and earlier writes worked. SeaweedFS's log said `No writable volumes and no free volumes left`: all 40 volumes (`-volume.max=40`, 256 MB each) were full of repeated 200 MB uploads of the same file. Changes: identical uploads are stored once (test), the proxy lives next to the original, `-volume.max=80`, writes retry on 5xx (limit 4, test with a fake client), and api/worker/init check a real write at startup. A `--resume` flag for the batch runner (skips sessions that already have a results.json) and the log of one cut-off batch (`docs/raw/m3_batch_log_run3_terminated.txt`) were committed in `5dba0df` during the interrupted part of the work; the final batch did not use `--resume`. I did not delete any stored data (only raised the limit); the store has no retention or cleanup yet.
5. Download links did not work from the host: port 8333 was not published and `S3_PUBLIC_ENDPOINT` was blank. Published, and defaulted to `http://localhost:8333` (change it for a deployment).
6. The runner polled fast enough to hit the API's own rate limit (429). It now retries on 429 after `Retry-After`.
7. `.gitignore` first got `media/`, which also ignored `packages/media`; fixed to `/media/`.
8. I started `docker compose up --build` while a batch was running and killed my own shell twice with `pkill -f`; no result was affected, partial batch outputs were deleted and the runs redone.

## 9. Not done or not verified
- Tone mapping HDR -> SDR and 10-bit -> 8-bit proxies are implemented but run on NO file (the only real file is 8-bit BT.709). No test covers them.
- The "video starts later than audio" path (single group, shifted video clock) is implemented and untested.
- Frame accuracy is proven on generated media at 25, 30 and 29.97 fps. The real footage was checked by frame count (3911 = timeline), the audio/video length difference (-0.02 frames) and one visual frame; the A/V offset of the real renders was NOT measured by flash/beep.
- Large graphs: tested to 361 pieces (1080p) and 301 pieces (320x240). The memory cap for fragmented timelines (64 pairs) is an estimate (about 8 GB at 1080p), not measured.
- Preset/CRF/max-height are settings; only `veryfast`/20/source height were run. `RENDER_MAX_HEIGHT` scaling has no test.
- The proxy time (282 s) is a one-off observation without a saved log; the encoded proxy is CRF 12 (visually near-lossless, so the file is large) and was not compared with the original quality-wise.
- The worker's render job has no mid-job crash test; stale re-queue works at store level only.
- AAC encoder delay: handled by the MP4 edit list; no residual offset was seen, but I did not test players other than ffmpeg/ffprobe.
- Music: only the built-in generated track (a sine chord). Another track needs an asset upload route that does not exist (`assets/music/<sha>` is read if present).
- Speaker-aware edits, vague references and the real LLM provider: not built (sessions 13 and 20 fail on purpose).
- Rights: the font licence is DejaVu (evidence saved); ffmpeg/libx264 are GPL programs used as external processes, their licence is NOT listed in SOURCES.md yet.
- No retention or cleanup of stored objects; no job cancellation.
- The real-footage batch ran once, on one VM; timings carry noise (see section 4).
- I wrote most of the render and CLI code and its tests in the same step, not strictly test-first (the failing tests were run and fixed afterwards); the mute-alone and 5xx tests were written to reproduce the failure before the fix.
