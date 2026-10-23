# The brief's worked example on the real recording

**The recording does not match the brief's script.** `media/test_single.mp4` (180.3 s, 1920x1080, 30 fps, HEVC + AAC, one speaker, my own recording, not in git) was made before the brief's script existed and was not recorded from it. Two things differ, nothing else was changed:

1. The brief says "welcome to the channel" (original 0:42-0:44). The recording says **"welcome to our channel"**, and the real ASR places "welcome" at original **0:39.501** (low confidence, 44%). So step 1 uses the phrase actually spoken, and times are 2.5 s earlier than the brief's (0:09.5 after the cut instead of 0:12).
2. The brief's step 3 has 3 mentions of pricing. The recording has **7** (listed below). The question therefore has 7 options; the answer "the second one" is the brief's.

Steps 2, 4, 5, 6, 7 and 8 are the brief's, word for word. The unchanged brief script as `sessions/01_worked_example.yaml` still FAILS on this recording (steps 1 and 8: no "welcome to the channel" to caption); that failure is kept, it is in the batch (section 5 of `docs/TEST_MEDIA.md`).

Session file: `sessions/worked_example_real.yaml`. Run: real faster-whisper (base.en, no prompt) and real sherpa-onnx diarization (1 speaker hint), live stack (api + worker + postgres + SeaweedFS + asr containers), 2026-10-23. Intake 125 s (a fresh transcription, not a cache hit). Raw: `test-pack/real/worked_example_real/` (`results.json`, `timeline.json`, `render_1_manifest.json`; the 64 MB video is not in git).

## 1. Step by step
`timeline_hash` is the hash after the step; a clarification turn does not change it. Time policy of every answer: **current** (stated in each summary).

| # | Brief says | Our recording / instruction | Our answer | Length after | timeline_hash |
|---|---|---|---|---|---|
| 1 | caption "Welcome!" on "welcome to the channel" (0:42-0:44) | `Add a caption "Welcome!" when I say "welcome to our channel"` (0:39.501) | **applied**, caption on atoms "welcome ... channel,"; warning: "welcome" is low confidence | 3:00.300 | `cd0c6e17d004...` |
| 2 | cut first 30 s: caption now 0:12-0:14 on the same words | `cut the first 30 seconds` | **applied**, -0:30.000, `caption "Welcome!" moved from 0:39.501 to 0:09.501` (no snap-to-silence warning, only the low-confidence warning) | 2:30.300 | `b57864025...` |
| 3 | "remove the part about pricing": needs_clarification, 3 mentions | `remove the part about pricing` | **needs_clarification**, "pricing is mentioned **7** times", 7 options with times and text (list in section 2); nothing cut | 2:30.300 | unchanged `b57864025...` |
| 3b | "the second one": applied | `the second one` | **applied**, -0:04.900 (the 0:16.051 mention) | 2:25.400 | `b6eccc278...` |
| 4 | speed up 1:00-1:30 by 2x, time policy stated | `speed up 1:00-1:30 by 2x` | **applied**, -0:15.033, "Time policy: current"; warns that the end of the range (1:34.900 of the source) is inside the word "pricing", so it moved to the word edge 1:34.820, and that a cut point between two touching words is not on a frame boundary (up to half a frame) | 2:10.367 | `ccf60b546...` |
| 5 | "put the intro back": first 30 s return, caption back at 0:42, pricing cut and speed change stay | `put the intro back` | **applied**, +0:30.000, `caption moved from 0:09.501 to 0:39.501`, "Restoring edit 2: removed original 0:00.000-0:30.000". The length is exactly 130.367 + 30, so the pricing cut (4.9 s) and the speed change (15.033 s) both stayed | 2:40.367 | `8575c6032...` |
| 6 | undo reverses step 5 only | `undo` | **applied**, "Undid edit 5" (the restore); length back to 2:10.367 and **the hash equals the one after step 4: `ccf60b546...`** (so it undid exactly the restore, nothing else) | 2:10.367 | `ccf60b546...` |
| 7 | "make that caption red" applies to the only caption | `make that caption red` | **applied** to `fx_0_0` (colour `#ff0000`, text and size kept) | 2:10.367 | `5c590d67df2e...` |
| 8 | render: in sync, length matches, caption on the right words | `render` (full resolution) | job succeeded, see section 3 | 130.366667 s | render of `5c590d67...` |

(The numbering above puts the brief's "step 3" answer on its own line, 3b. In the session file it is one more step, so its step numbers are 1-9 with the render as step 9.)

Full hashes: step 1 `cd0c6e17d0043a46b2b4ac832ca3bd5400ccca560da29f6fc56ee6840fb749b3`; 2/3 `b578640252a7d53b984c8974f8ca53957fedf41231f6fc0724e9c086e43b0d18`; 3b `b6eccc27847a59b1d070be3941b3bfe3f9fefa2a1bba62b6cf856848dc52a34d`; 4/6 `ccf60b546a5e6c9c46f428d757e2bcc81f0c2b9c0a761e062ddfcb7817f9dd11`; 5 `8575c60328343693498e02726155d9f08a7584a03d3f3cadd4ec74dce4c9eefd`; 7/render `5c590d67df2eed8de7c879ae8a9dbae6a3c4ccd13a1e7a24cfaac72687f6a16c`.

**Determinism.** The same 9 steps were run a second time in the batch at 720p (`test-pack/real/batch_720p/worked_example_real/`): all 9 statuses and **all 9 timeline hashes identical**. That second run reused the cached transcript (same file sha256), so it shows the editing is deterministic, not the ASR.

## 2. The 7 pricing mentions (step 3, times on the edited timeline after the cut)
1 0:09.501 "welcome to our channel, let's say, pricing plans in Cloud Code." (the sentence the caption sits on); 2 0:16.051 "So the pricing plans in Cloud will be differing from each plan."; 3 0:20.958 "So we have to choose each plan accordingly ..."; 4 1:09.720 "... the cost or subscription fee of each plan ..."; 5 1:35.410 "... their pricing page."; 6 1:45.220 "... the pro pricing plan."; 7 1:56.080 "... different types of pricing ...". All seven are `[exact word]` matches (the built-in synonym table maps cost/fee to pricing; the embedding model added nothing, as in REVIEW_M4 section 4). Raw: `test-pack/real/worked_example_real/results.json` step 3.

## 3. Render checks (step 8)
Full resolution render: 1920x1080, 30/1 fps, H.264 + AAC (`test-pack/real/worked_example_real/render_1_manifest.json`).
- **Length:** 3911 video frames = 130.3667 s; the timeline is 130.366667 s = 3911 frames: **difference 0 frames** (ffprobe `nb_read_frames` 3911; audio 130.366 s; A/V frame offset in the manifest -0.02 frame). Source sha256 `c96050db...e2bd` before and after: unchanged. 65.4 s of rendering per output minute at 1080p (one run).
- **Caption position, measured on every frame** (`scripts/caption_frames.mjs`: red pixels in the bottom band; saved in `test-pack/real/caption_frame_scans.json`): red caption on frames **286-346** = 9.533-11.567 s. The timeline says 9.5013-11.540 s, i.e. first frame at or after 9.5013 is 286 and the last frame before 11.540 is 346: **exact**. Stills: `test-pack/real/worked_example_real/frames/` (not on screen at 9.30 s, red "Welcome!" at 10.5 s).
- **Caption vs audio:** the audio of the render goes from silence to speech at **9.517 s** (ffmpeg `silencedetect`, -38 dB), the caption appears at 9.533 s: **within one frame (0.033 s)**. Speech energy stays above -38 dB until 11.897 s; the caption ends at 11.567 s, **0.33 s before the audible end** of "channel," (the word end from Whisper is 41.54 s original = 11.54 s; the audible tail is longer). A second transcription of the rendered audio put "welcome" at 10.09 s and "channel," ending at 11.53 s: Whisper's word start of a low-confidence word differs by about 0.6 s between runs/clips, so this check is a consistency check of word timestamps, **not** a measure of A/V sync; the energy onset above is the better evidence. Raw: `test-pack/real/worked_example_real/render_first25_asr.json`.

**Caption before the cut, after the cut, and after the restore.** A companion session (`sessions/extra/worked_example_real_frames.yaml`; same steps, caption made red at once, a render after step 1+2, after the cut, and after the restore) rendered at **720p** (`RENDER_MAX_HEIGHT=720`, not full resolution). Raw: `test-pack/real/worked_example_real_frames/`, `caption_frame_scans.json`.

| State | Timeline (s) | Frames rendered / timeline | Red caption on frames | Expected from the timeline |
|---|---|---|---|---|
| before the cut | 180.300 | 5409 / 5409 | 1186-1246 (39.533-41.567 s) | 39.5013-41.540 s: first frame 1186, last 1246 |
| after "cut the first 30 seconds" | 150.300 | 4509 / 4509 | **286-346 (9.533-11.567 s)** | 9.5013-11.540 s: 286-346 |
| after "put the intro back" (pricing cut and speed change still applied) | 160.367 | 4811 / 4811 | **1186-1246 (39.533-41.567 s)** | back at 39.5013 s |

Length difference 0 frames in all three; source unchanged in all three. In this session the hash after the cut is `0a967ce5b1bd...` and after the restore `28940db052b1...` (different from the main session because the caption was already red there).

## 4. Not verified / honest limits
- The recording differs from the brief's script (section top). I have **not** shown the brief's exact numbers (0:42, 0:12, 3 mentions); I showed the same behaviour on the numbers this recording gives.
- Nobody listened to the render. Audio sync is measured with the speech onset (energy) and frame counts, not by ear. The caption ends 0.33 s before the audible tail of the last word.
- The before/after-cut and after-restore frame checks are at 720p; the full-resolution render was checked for the final state only.
- Uploading the file through the public URL (`https://34-93-140-79.sslip.io`) failed with `fetch failed` after 6 s (the file is 200,422,585 bytes; the public door has a 200 MB cap, **cause not confirmed**). Everything here ran against the same API and worker over the Docker network, **not through the public door**.
- The ASR is base.en without a prompt; "welcome" is low confidence and its start (39.501 s) was clamped to the silence edge by the pipeline. Word timestamps are not ground truth.
- Single run per condition for render times.
