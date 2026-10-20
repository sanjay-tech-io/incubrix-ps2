# Spike: real ASR end to end on this VM

Run on 2026-10-20 on the GCP VM (Debian 13, 4 vCPU x86, 15 GiB RAM, no GPU). Raw JSON is in `docs/raw/`. Everything here was run; where it was not, it says so.

## Clip
`nasa_120s.wav`: 120 s window (starts 20:00) of NASA JSC "Houston We Have a Podcast" Ep. 407 (public domain per Wikimedia Commons, see SOURCES.md), 16 kHz mono. Two speakers, natural conversation. Also a 300 s window (`nasa_300s.wav`) for the disfluency test, and a 34 s AI-generated espeak-ng clip (`synthetic.wav`). No clip is committed; SOURCES.md has the commands.

## Model sizes tried (faster-whisper, CPU, int8, VAD on, beam 5, word timestamps, 4 threads)
Each model ran in a fresh process, second run (model already cached). Source: `docs/raw/bench_models.json`, `docs/raw/download_sizes.txt`.

| Model | On disk (fp16 files, run as int8) | Download (clean cache) | Load | Transcribe 120 s | Real-time factor | Peak RSS | Words |
|---|---|---|---|---|---|---|---|
| tiny.en | 78 MB | 1.3 s | 0.8 s | 14.8 s | 0.123 | 604 MB | 390 |
| base.en | 148 MB | 0.9 s | 1.0 s | 24.7 s | 0.206 | 683 MB | 388 |
| small.en | 486 MB | 0.9 s | 3.3 s | 60.8 s | 0.506 | 1357 MB | 388 |
| medium.en | 1530 MB | not timed separately (first run 189 s wall vs 167 s cached) | 5.7 s | 160.1 s | 1.334 | 3220 MB | 377 |

Notes: RTF is transcribe time / audio time, measured inside the adapter. Repeat runs of the same model differed (small.en: first run RTF 0.73, second 0.51; the VM was idle for the second), so treat these as +/-30% numbers, one clip, not a benchmark suite. medium.en is slower than real time on 4 vCPUs and is not usable. Peak RSS is the process maximum, including Python and the model.

## HTTP end to end (service as used by the worker)
`ASR_ADAPTER=faster-whisper WHISPER_MODEL=base.en uvicorn asr.server:app_factory --factory`, then `POST /transcribe` with the wav and the disfluency prompt (`docs/raw/e2e_transcript.json`):
- model load 2.17 s (first request loads lazily), transcribe 25.5 s for 120 s audio, RTF 0.212, 393 words, language `en`.
- Server process peak RSS (VmHWM): 715 MB.
- Words come back with integer `start_us`/`end_us` and `confidence_permille`; no `speaker` key (diarization is not wired into the service yet).

Then `packages/media` on the same wav (`docs/raw/e2e_clamp.json`): `detectSilence` (-35 dB, >= 0.3 s) found 7 silences, 3.13 s in total. `clampWordsToSilence` made 3 adjustments: word 144 end 40.600 s -> 40.385 s (215 ms of stretch removed), word 134 start 36.040 -> 36.167 s, word 145 start 40.600 -> 40.831 s. No word lay wholly inside a silence. I did not check these against a hand-labelled reference, so "correct" is not claimed, only that the mechanism runs and moves times into agreement with the audio.

## Disfluencies: does an initial_prompt recover "um"/"uh"?
Prompt: `Umm, let me think, like, hmm... okay, so, uh, here is what I think.` Counting = regex over the output words (`um|umm|uh|hmm|er|ah` variants). Raw: `docs/raw/disfl_synth.json`, `docs/raw/disfl_nasa300.json`.

AI-generated clip, true count 10 (known by construction):
| Model | No prompt | With prompt |
|---|---|---|
| tiny.en | 0 | 0 |
| base.en | 9 (all "um/umm", the "uh" and "hmm" became "umm") | 10 (kept "uh") |
| small.en | 10 | 10 |
VAD on or off made no difference in any row.

Real speech, 300 s of the NASA podcast, **no ground truth** (I cannot listen to it; counts are what the model emitted):
| Model | No prompt | With prompt |
|---|---|---|
| base.en | 0 | 1 ("um," at ~4.0 s) |
| small.en | 0 | 1 ("um," at ~4.1 s) |

Reading: the prompt helped a little (base.en 9 -> 10 on synthetic; 0 -> 1 on real) but the evidence is thin: one synthetic clip where espeak's "um" is easy to hear, and one real clip where I do not know how many were spoken. The prompt did not get echoed into the output in any run. It also changes other words (base.en 968 -> 952 words on the real clip), so it is not free. tiny.en dropped every filler even with the prompt. Do not claim "prompt recovers fillers"; the supported claim is "small effect, model-dependent, needs a labelled human clip to quantify".

## Diarization measured (sherpa-onnx, see REVIEW_INFRA.md section 5 for licences)
`docs/raw/diar_nasa_*.json`: 120 s -> 49 s (RTF 0.41), 300 s -> 125 s (RTF 0.42), peak RSS 224-243 MB, models 6.0 MB (segmentation; 1.5 MB int8) + 26.5 MB (embedding). It found 3 speakers (4 with the int8 segmentation) in a podcast I believe has 2 hosts; I did not verify who speaks, so the speaker count and accuracy are NOT validated. Turns overlap in time by design (segmentation allows overlapped speech).

## What did not work / flags
- `faster-whisper 1.2.1` crashes with PyAV 19 (`open() got an unexpected keyword argument 'metadata_errors'`). Pinned `av==16.1.0` in requirements.txt (works).
- The first attempt at the 10-minute disfluency run was far slower than expected and I killed it; the result above uses 5 minutes and two models.
- `bench_models.json` was produced by an earlier version of the script: its labels (`first_run_incl_download`, `second_run_cached`) and `model_cache_mb` (2.6, wrong because it skipped symlinks) are wrong. tiny/base/small were already cached from an earlier experiment, so the "first run" was not a download. The script in the repo is the corrected version but was NOT re-run; the sizes in the table come from `download_sizes.txt`.
- The ASR container was only run with the mock adapter. The real adapter was run from a host venv (Python 3.13), not in the Docker image (Python 3.12); the image with faster-whisper installed builds and starts (health OK) but was not asked to transcribe.
- Diarization is not integrated into the ASR service.
- Single machine, single clip, no repeated trials: no confidence intervals.
