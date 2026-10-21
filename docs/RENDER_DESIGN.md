# M3 render design (one page, for approval)

Nothing below is built yet. The engine is the only authority on WHAT the output is; the renderer only turns the engine's materialized timeline into ffmpeg arguments. I do not expect to change `packages/engine` (see "Engine" at the end).

## 1. Timeline to ffmpeg: per-piece encode + concat, or one filter graph?
**Choice: one ffmpeg run per render, with a generated filter graph, driven by the engine's `Piece` list.** Each `Piece` (`srcS, srcE, outS, outE, rate, outFrames`) already is "a source range played at one rate that occupies a whole number of output frames". For every piece the graph does:

- video: `trim=start_frame:end_frame` (frame numbers, not seconds), `setpts`, then for `rate != 1` `setpts=PTS*den/num` and `fps` to the target, then `select/trim` to exactly `outFrames`;
- audio: `atrim` on the sample-exact time, `asetpts`, `atempo` (chained: a factor outside 0.5..2.0 becomes e.g. 4x = 2x·2x, 0.25x = 0.5x·0.5x, so pitch is preserved), then `apad`/`atrim` to exactly `outFrames/fps` seconds;
- all pieces are joined with `concat=n=N:v=1:a=1`.

Why not per-segment encode + concat demuxer: it encodes N files, every join is a keyframe/priming-sample risk, and the audio of each segment drifts by up to a codec frame (about 21 ms for AAC), which adds up over many cuts. One graph means one encode, one clock, and I can make the audio exactly as long as the video per piece **before** encoding. The cost is a long filter script for thousands of pieces; I pass it with `-filter_complex_script` (a file), not on the command line, and test with a 200-piece timeline.

## 2. How each timeline feature is applied
| Feature | How |
|---|---|
| cut / keep-only / reorder | They are already `segments` in output order; the pieces list encodes them. Reorder is just a different order of `trim`s. |
| speed | per-piece `setpts` (video) and `atempo` chain (audio). Rates are exact rationals from the engine, so `atempo` gets `num/den` as an expression, not a rounded float. |
| mute | after concat, `volume=0:enable='between(t,a,b)'` for every run of the effect (`effectDisplay(...).runs`, edited time). |
| bleep | same window: original muted and a generated `sine=frequency=1000` mixed in (`amix` with `normalize=0`) only inside the window, at a fixed documented level. |
| captions / auto-captions / text overlays | `drawtext` with `enable='between(t,a,b)'`, using the engine's `effectDisplay` window (so the 0.7 s minimum is honoured) and `autoCaptionCues`. Colour, size, bold, top/centre/bottom come from the effect params. Text is written to a `textfile=` per cue, not the command line (no escaping bugs, no injection from user text). Font: **DejaVu Sans / Sans Bold** (Bitstream Vera licence, free for commercial use, already in the image via `fonts-dejavu-core`); added to SOURCES.md with the licence file as evidence. |
| music + ducking | the music track is looped/trimmed to the output length; gain = the engine's `duckingEnvelope` keyframes (centi-dB), applied as a `volume` expression with linear ramps between keyframes (not ffmpeg's sidechain compressor, because the engine's envelope is the tested truth and must be what is rendered). Mixed with `amix normalize=0`. The music file is **generated** by a script (a simple synthesized pad, AI-generated flag "no, programmatic synthesis"; recorded in SOURCES.md); nothing binary in git. |
| output | H.264 (`libx264`, `-crf 20`, `yuv420p`) + AAC, MP4, `-r` = source fps as exact rational, `-fps_mode cfr`, `-movflags +faststart`. |

## 3. Frame accuracy and A/V sync
1. All cut points are already on the source frame grid (engine rule, M1b). The graph trims **by frame number**, computed from the engine's `srcS/srcE` with the same rule the engine uses (frame k starts at `round(k·den·1e6/num)` µs).
2. The engine gives each piece an integer `outFrames`; the sum equals `durationUs·fps`. I `trim` each video piece to exactly that count and each audio piece to exactly `outFrames·den/(num·rate...)` seconds worth of samples (`atrim`, `apad`, at a fixed 48 kHz so one frame is a whole number of samples at 25 fps; at 30000/1001 the per-piece sample count is rounded and the rounding is carried forward, like the engine does for frames, so total audio = total video within 1 sample).
3. After the encode the renderer runs **ffprobe on the output** and fails the job (`RENDER_VERIFY_FAILED`) if video frames != timeline frames, or audio duration differs from video duration by more than 1 frame. The numbers are stored in the render manifest.
4. Tests (milestone item 3) use generated media: `testsrc2` with a burned frame counter, a white flash every N frames and a 1 kHz beep at the same frames. After cut + 2x + reorder + restore the test measures the length by ffprobe and the flash-vs-beep offset by decoding (`signalstats` brightness peaks vs `astats`/`silencedetect` beep onsets), at 25, 30 and 30000/1001 fps. I will report what it measures, not what I hope: AAC adds an encoder delay; the MP4 edit list normally hides it, and if a test shows a residual offset I will report it rather than tune it away.

## 4. Variable frame rate (VFR) sources
The original is never touched. For a source flagged VFR by M2's probe, the render job first makes a **CFR proxy**: `ffmpeg -i original -vf fps=<nominal fps> -fps_mode cfr -c:v libx264 -crf 12 -an proxy.mp4` (audio is taken from the original, not the proxy), stored in S3 next to the video as `videos/<id>/proxy_cfr.mp4` with its own sha256 in the render manifest. Atoms/timeline times are on the original's clock; the proxy keeps the same clock (`fps` filter drops/duplicates frames to the grid, timestamps stay true), so no timeline numbers change. The nominal rate (ffprobe `r_frame_rate`) is used as M2 recorded it. The manifest carries a warning: "VFR source rendered via CFR proxy at N fps; duplicated/dropped frames possible". Frame-accuracy numbers for the VFR clip are reported separately and are against the proxy's grid.
The source sha256 is computed before and after the render (re-hash the stored original) and the job fails if they differ; a test asserts the stored hash is unchanged.

## 5. Job, storage, errors
`POST /sessions/{id}/render` (replaces the 501): body optional `{ "resolution": "source"|"720p" }` (default source), `Idempotency-Key` honoured; the timeline is **snapshotted at request time** (its `timeline_hash` is stored in the job), so edits after the request do not change the render. Returns 202 `{job_id}`. The worker (same SKIP LOCKED loop, `kind='render'`) downloads the original, builds the graph, runs ffmpeg with progress parsed from `-progress pipe:1` (real progress, unlike ASR), uploads `renders/<job>/output.mp4` and `render_manifest.json`, and the job result carries presigned download links (manifest: ffmpeg version, the exact filter script hash, timings, cpu seconds, warnings, fonts/music rights, timeline_hash, source sha256 before/after, ffprobe verification numbers). Failure codes added to `packages/errors`: `RENDER_FAILED`, `RENDER_VERIFY_FAILED`, `SOURCE_CHANGED`. No-audio source: already rejected at intake (`NO_AUDIO_TRACK`); the render test confirms that, and that a session cannot be created for it.

## 6. Runners (items 4-8, short)
`npm run session -- file.yaml [--out dir]` and `npm run batch` are thin HTTP clients of the real API (no engine imports), so they test the product path. Results: `results.json` per step, `timeline.json`, `output.mp4`. Determinism test runs one session 3 times and compares every step's hash. Sessions are YAML files in `sessions/` with `expect:` status per step; the batch summary reports pass/fail and keeps failures.

## Engine
I plan no engine change. The one thing I will check while building is whether `Piece` exposes enough for audio (rate as an exact rational: yes; frames per piece: yes). If something is missing I will stop and explain before touching it.

## Decisions I need from you
1. One filter graph per render (above) instead of per-segment encode + concat: OK?
2. Render music through the engine's envelope as `volume` ramps (not a compressor): OK?
3. VFR: CFR proxy at the nominal rate, only for sources flagged VFR; the real-footage file `media/test_single.mp4` has `r_frame_rate 30/1` but `avg_frame_rate 24345000/811309 = 30.0087`, so it will probably be flagged: OK to include its (large, 1080p HEVC, 3 min) render as a real run?
4. Default output H.264/AAC MP4 at source resolution; OK?
