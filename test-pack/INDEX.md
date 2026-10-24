# Test pack index

What was run, with what input, what came out (failures included), and which file backs each claim in `REPORT.md`. Everything listed exists in this repository or on the VM. Nothing here was produced by hand: results are the files the runners wrote.

## 0. What is in git and what is not
- In git: `results.json`, `timeline.json`, render manifests, logs, summaries, frame-scan JSON.
- **Not in git** (`.gitignore`: `/media/`, `test-pack/**/*.mp4`, `*.png`, `test-pack/real/nasa/`): input media, rendered videos, stills, NASA transcripts. The rendered videos are on this VM under the paths in section 3 (62 `.mp4` files, `test-pack` is 1.6 GB). They are **not** held in S3 as permanent links: renders are stored in the S3-compatible store, but download links are presigned and expire, and retention deletes renders after 14 days (`RETENTION_DAYS`, `docs/REVIEW_M4.md` section 1). If a video is needed after that, copy it from the VM path. I did not upload them anywhere else.
- A session folder holds: `results.json` (every step: instruction, status, operations, summary, warnings, `timeline_hash`, duration, milliseconds), `timeline.json` (final timeline), and, when the session rendered, `render_N.mp4` plus `render_N_manifest.json`.

## 1. Inputs (every media file; rights and commands in `SOURCES.md`)
| Input | Used in | Note |
|---|---|---|
| `media/test_single.mp4`, 180.3 s, 1080p30 HEVC + AAC, my own recording, one speaker (200,422,585 bytes) | sessions 01, 01b, 02, 02b, 03-12, 16-25, `fillers_single`, `worked_example_real`, `extra/worked_example_real_frames` | Core single-speaker video. Differs from the brief's script (`docs/TEST_MEDIA.md` section 1). sha256 `c96050db...e2bd` |
| `media/two_voice_dialogue.mp4`, 58.2 s, espeak-ng voices (AI/synthetic); `_thr03.mp4` is the same streams with one metadata tag | sessions 13b, 13d; `diag_13c` uses the `_thr03` copy | Truth by construction in `media/two_voice_dialogue_truth.json` |
| `media/two_speaker.mp4` (espeak-ng, 8 lines, 640x360) | session 13 | Made by `scripts/make_session_media.sh` |
| `media/vfr_speech.mp4` (~25 s, frames dropped at random) | session 14 | The only variable-frame-rate input. **Generated, not a phone recording** |
| `media/no_audio.mp4` (20 s picture, no audio) | session 15 | |
| `media/nasa_ep407_0_240.mp4`, first 240 s of a NASA JSC podcast (public domain per Wikimedia Commons), black picture added by me | `nasa_speaker_scoped_edit`, `nasa_speaker_scoped_edit_no_hint` | Real two-person speech; diarization fails on it. Rights caveat in `SOURCES.md` |
| `nasa_*.wav` windows (120 s, 300 s) of the same episode | ASR and diarization spike and sweep: `docs/SPIKE_ASR.md`, `docs/raw/m5d_diarization_sweep*` | Audio only |
| Generated smoke clips `media/m6a_smoke.mp4`, `m6a_smoke2.mp4`, `m6a_smoke_dotted.mp4`, `m5b_smoke.mp4` (espeak-ng over `testsrc2`) | `m6a_smoke*`, `m5b_smoke_redeploy` | AI/synthetic flags in `SOURCES.md` |
| Test-time generated media: `sync2_*` flash and beep clips, API test clips, built-in music | `packages/render/test`, `apps/api/test` | Not stored |
| Hand-written transcripts for the 48 scenarios | `scenarios/`, `apps/api/test/scenario_fixtures.ts` | Tests editing, not recognition |

## 2. Test and measurement runs (not session packs)
| Run | Result | Files |
|---|---|---|
| Full test suite in a fresh clone (the CI command) | exit 0 | `docs/raw/m5_ci_simulation.txt`; first attempt FAILED: `docs/raw/m5_ci_simulation_run1_failed.txt` |
| 48 scenarios (130 steps) | 50 of 50 (first run 43 of 50, kept) | `docs/raw/m5b_scenarios_run.txt`, `docs/raw/m5_scenarios_run2.txt`, `docs/raw/m5_scenarios_run1.txt`, per-scenario `docs/raw/m5_scenarios/` |
| Render accuracy (generated clips, 25/30/29.97/VFR/301 pieces) | length difference 0, A/V offset at most 0.44 frame | `docs/raw/m3_accuracy_*.json` |
| Render bench (one graph vs grouped) | 361 pieces: 149 s vs 58 s | `docs/raw/m3_bench_*.json` |
| Engine speed, synthetic 60 min | slowest 155.9 ms | `docs/PERF_ENGINE.md` |
| ASR model comparison; diarization RTF | base.en RTF 0.206; diarization 0.41-0.42 | `docs/SPIKE_ASR.md`, `docs/raw/bench_models.json`, `docs/raw/diar_nasa_*.json` |
| Diarization threshold sweep, 11 thresholds x 6 clips | no value right on all 6 | `docs/raw/m5d_diarization_sweep.jsonl`, `docs/raw/m5d_diarization_sweep_table.md` |
| Two-voice clip scored against truth | 142/142 words after the hint fallback; 93/142 before | `test-pack/real/two_voice/asr_*.json` |
| Label-swap detection, real models, synthetic voices | 6 of 6 found, 0 false flags | `docs/raw/m5_swap_real_run.txt` |
| Caption position by frame scan (before cut / after cut / after restore; full-resolution final) | 1186-1246 / 286-346 / 1186-1246 | `test-pack/real/caption_frame_scans.json`, `test-pack/real/worked_example_real_frames/` |
| Public deployment: smoke tests, cold start, limits, rotation, uploads | see `docs/DEPLOY.md` | `docs/raw/m6a_*`, `docs/raw/m5b_smoke_redeploy.txt`, `docs/raw/m5d_upload_*.txt`, `docs/raw/m5d_token_rotation.txt` |
| Gemini fallback sessions and latency probe | 3 runs; latency 0.75 s to 36 s | `docs/raw/m4_llm_session*`, `docs/raw/m4_llm_latency_probe.txt` |
| Meaning search sessions | `docs/raw/m4_meaning_search_session*` | |
| Real runs from earlier milestones with expectations unchanged | sessions 13, 20, 24, 25 | `docs/raw/m4_sessions/` |
| Re-runs through the public URL (M5d) | 13b PASS, 13d PASS, NASA with hint FAIL, NASA no hint asks | `test-pack/real/m5d/` |
| Threshold 0.3 diagnostic (not default at the time) | 2 speakers; one wrong line cut, one missed | `test-pack/real/diag_13c_threshold_0_3/` |

## 3. Session pack
**Primary run (the one REPORT.md quotes): 38 sessions, 33 pass, 5 fail.** `npm run batch -- sessions`, live stack, real ASR and diarization, 720p `veryfast`, 2026-10-24. Summary `test-pack/real/batch_720p_m5e/summary.json`, log `test-pack/real/batch_720p_m5e_log.txt`. The session files are in `sessions/`.

| Session | Result | results.json | timeline.json | Rendered video (git-ignored, on the VM) | Final timeline_hash (prefix) | Failure reason |
|---|---|---|---|---|---|---|
| 01_worked_example | **FAIL** | `test-pack/real/batch_720p_m5e/01_worked_example/results.json` | `test-pack/real/batch_720p_m5e/01_worked_example/timeline.json` | `test-pack/real/batch_720p_m5e/01_worked_example/render_1.mp4` (25.4 MB) | `7374f06e09e3` | step 1: expected applied, got rejected: I could not find the words "welcome to the channel" in the video, so there is ; step 8: expected applied, got rejected: There is no caption to change (red). Add one first, for example: add a caption |
| 01b_worked_example_as_recorded | PASS | `test-pack/real/batch_720p_m5e/01b_worked_example_as_recorded/results.json` | `test-pack/real/batch_720p_m5e/01b_worked_example_as_recorded/timeline.json` | `test-pack/real/batch_720p_m5e/01b_worked_example_as_recorded/render_1.mp4` (25.4 MB) | `5c590d67df2e` |  |
| 02_caption_cut_restore | **FAIL** | `test-pack/real/batch_720p_m5e/02_caption_cut_restore/results.json` | `test-pack/real/batch_720p_m5e/02_caption_cut_restore/timeline.json` | none | `f45fb6547410` | step 1: expected applied, got rejected: I could not find the words "welcome to the channel" in the video, so there is ; step 4: expected applied, got rejected: There is no caption to change (red). Add one first, for example: add a caption |
| 02b_caption_cut_restore_as_recorded | PASS | `test-pack/real/batch_720p_m5e/02b_caption_cut_restore_as_recorded/results.json` | `test-pack/real/batch_720p_m5e/02b_caption_cut_restore_as_recorded/timeline.json` | none | `5f90e9d16526` |  |
| 03_reorder_then_mute | PASS | `test-pack/real/batch_720p_m5e/03_reorder_then_mute/results.json` | `test-pack/real/batch_720p_m5e/03_reorder_then_mute/timeline.json` | `test-pack/real/batch_720p_m5e/03_reorder_then_mute/render_1.mp4` (33.5 MB) | `3a03f79051bf` |  |
| 04_filler_removal_into_bleep | **FAIL** | `test-pack/real/batch_720p_m5e/04_filler_removal_into_bleep/results.json` | `test-pack/real/batch_720p_m5e/04_filler_removal_into_bleep/timeline.json` | none | `f45fb6547410` | step 1: expected applied, got rejected: I could not find "um" in the video.; step 2: expected applied, got needs_clarification |
| 05_remove_range_twice | PASS | `test-pack/real/batch_720p_m5e/05_remove_range_twice/results.json` | `test-pack/real/batch_720p_m5e/05_remove_range_twice/timeline.json` | none | `c1d798dae4c0` |  |
| 06_caption_beyond_the_end | PASS | `test-pack/real/batch_720p_m5e/06_caption_beyond_the_end/results.json` | `test-pack/real/batch_720p_m5e/06_caption_beyond_the_end/timeline.json` | none | `f45fb6547410` |  |
| 07_time_phrases | PASS | `test-pack/real/batch_720p_m5e/07_time_phrases/results.json` | `test-pack/real/batch_720p_m5e/07_time_phrases/timeline.json` | none | `cd5169b5e7be` |  |
| 08_undo_second_to_last_keep_music | PASS | `test-pack/real/batch_720p_m5e/08_undo_second_to_last_keep_music/results.json` | `test-pack/real/batch_720p_m5e/08_undo_second_to_last_keep_music/timeline.json` | `test-pack/real/batch_720p_m5e/08_undo_second_to_last_keep_music/render_1.mp4` (31.8 MB) | `9cafa2b16f0e` |  |
| 09_make_it_bigger_without_caption | PASS | `test-pack/real/batch_720p_m5e/09_make_it_bigger_without_caption/results.json` | `test-pack/real/batch_720p_m5e/09_make_it_bigger_without_caption/timeline.json` | none | `f45fb6547410` |  |
| 10_everything_after_thanks | PASS | `test-pack/real/batch_720p_m5e/10_everything_after_thanks/results.json` | `test-pack/real/batch_720p_m5e/10_everything_after_thanks/timeline.json` | none | `620103a4765c` |  |
| 11_impossible_speed_and_cut_everything | PASS | `test-pack/real/batch_720p_m5e/11_impossible_speed_and_cut_everything/results.json` | `test-pack/real/batch_720p_m5e/11_impossible_speed_and_cut_everything/timeline.json` | none | `f45fb6547410` |  |
| 12_three_parts_one_impossible | PASS | `test-pack/real/batch_720p_m5e/12_three_parts_one_impossible/results.json` | `test-pack/real/batch_720p_m5e/12_three_parts_one_impossible/timeline.json` | none | `f45fb6547410` |  |
| 13_two_speakers_guest_old_job | PASS | `test-pack/real/batch_720p_m5e/13_two_speakers_guest_old_job/results.json` | `test-pack/real/batch_720p_m5e/13_two_speakers_guest_old_job/timeline.json` | none | `b3ee2ae9a18d` |  |
| 13b_two_voice_dialogue_guest_old_job | PASS | `test-pack/real/batch_720p_m5e/13b_two_voice_dialogue_guest_old_job/results.json` | `test-pack/real/batch_720p_m5e/13b_two_voice_dialogue_guest_old_job/timeline.json` | none | `c86a58844abc` |  |
| 13d_two_voice_dialogue_no_hint | PASS | `test-pack/real/batch_720p_m5e/13d_two_voice_dialogue_no_hint/results.json` | `test-pack/real/batch_720p_m5e/13d_two_voice_dialogue_no_hint/timeline.json` | none | `c86a58844abc` |  |
| 14_variable_frame_rate_phone | PASS | `test-pack/real/batch_720p_m5e/14_variable_frame_rate_phone/results.json` | `test-pack/real/batch_720p_m5e/14_variable_frame_rate_phone/timeline.json` | `test-pack/real/batch_720p_m5e/14_variable_frame_rate_phone/render_1.mp4` (1.7 MB) | `de251255dc26` |  |
| 15_no_audio_track | PASS | `test-pack/real/batch_720p_m5e/15_no_audio_track/results.json` | - | none | - |  |
| 16_auto_captions_and_speed | PASS | `test-pack/real/batch_720p_m5e/16_auto_captions_and_speed/results.json` | `test-pack/real/batch_720p_m5e/16_auto_captions_and_speed/timeline.json` | `test-pack/real/batch_720p_m5e/16_auto_captions_and_speed/render_1.mp4` (29.6 MB) | `1a2b134ec7ed` |  |
| 17_silences_and_protected_pause | PASS | `test-pack/real/batch_720p_m5e/17_silences_and_protected_pause/results.json` | `test-pack/real/batch_720p_m5e/17_silences_and_protected_pause/timeline.json` | none | `6d91cb7defba` |  |
| 18_keep_only_and_restore_edit | PASS | `test-pack/real/batch_720p_m5e/18_keep_only_and_restore_edit/results.json` | `test-pack/real/batch_720p_m5e/18_keep_only_and_restore_edit/timeline.json` | none | `a07cf9cc75b3` |  |
| 19_meaning_search_cost | PASS | `test-pack/real/batch_720p_m5e/19_meaning_search_cost/results.json` | `test-pack/real/batch_720p_m5e/19_meaning_search_cost/timeline.json` | none | `f45fb6547410` |  |
| 20_vague_references | PASS | `test-pack/real/batch_720p_m5e/20_vague_references/results.json` | `test-pack/real/batch_720p_m5e/20_vague_references/timeline.json` | none | `f45fb6547410` |  |
| 21_meaning_search_pricing | PASS | `test-pack/real/batch_720p_m5e/21_meaning_search_pricing/results.json` | `test-pack/real/batch_720p_m5e/21_meaning_search_pricing/timeline.json` | none | `d52573f9cd88` |  |
| 22_meaning_search_beyond_the_words | **FAIL** | `test-pack/real/batch_720p_m5e/22_meaning_search_beyond_the_words/results.json` | `test-pack/real/batch_720p_m5e/22_meaning_search_beyond_the_words/timeline.json` | none | `f45fb6547410` | step 1: expected needs_clarification, got rejected: No part of the current video mentions "money" or is about it by me |
| 23_llm_fallback | PASS | `test-pack/real/batch_720p_m5e/23_llm_fallback/results.json` | `test-pack/real/batch_720p_m5e/23_llm_fallback/timeline.json` | none | `856388c9f2c0` |  |
| 24_repeat_is_safe | PASS | `test-pack/real/batch_720p_m5e/24_repeat_is_safe/results.json` | `test-pack/real/batch_720p_m5e/24_repeat_is_safe/timeline.json` | none | `c2d0bbb33840` |  |
| 25_vague_captions_and_restore | PASS | `test-pack/real/batch_720p_m5e/25_vague_captions_and_restore/results.json` | `test-pack/real/batch_720p_m5e/25_vague_captions_and_restore/timeline.json` | none | `f8c01fbff879` |  |
| diag_13c_two_voice_dialogue_threshold_0_3 | PASS | `test-pack/real/batch_720p_m5e/diag_13c_two_voice_dialogue_threshold_0_3/results.json` | `test-pack/real/batch_720p_m5e/diag_13c_two_voice_dialogue_threshold_0_3/timeline.json` | none | `396b50da0d79` |  |
| fillers_single | PASS | `test-pack/real/batch_720p_m5e/fillers_single/results.json` | `test-pack/real/batch_720p_m5e/fillers_single/timeline.json` | none | `f45fb6547410` |  |
| m5b_smoke_redeploy | PASS | `test-pack/real/batch_720p_m5e/m5b_smoke_redeploy/results.json` | `test-pack/real/batch_720p_m5e/m5b_smoke_redeploy/timeline.json` | `test-pack/real/batch_720p_m5e/m5b_smoke_redeploy/render_1.mp4` (1.7 MB) | `bf4af062fe91` |  |
| m6a_smoke | PASS | `test-pack/real/batch_720p_m5e/m6a_smoke/results.json` | `test-pack/real/batch_720p_m5e/m6a_smoke/timeline.json` | `test-pack/real/batch_720p_m5e/m6a_smoke/render_1.mp4` (1.6 MB) | `0445270499bf` |  |
| m6a_smoke_after_rotation | PASS | `test-pack/real/batch_720p_m5e/m6a_smoke_after_rotation/results.json` | `test-pack/real/batch_720p_m5e/m6a_smoke_after_rotation/timeline.json` | `test-pack/real/batch_720p_m5e/m6a_smoke_after_rotation/render_1.mp4` (1.9 MB) | `3ba052d8617b` |  |
| m6a_smoke_dotted_links | PASS | `test-pack/real/batch_720p_m5e/m6a_smoke_dotted_links/results.json` | `test-pack/real/batch_720p_m5e/m6a_smoke_dotted_links/timeline.json` | `test-pack/real/batch_720p_m5e/m6a_smoke_dotted_links/render_1.mp4` (1.9 MB) | `9406acd165d7` |  |
| nasa_speaker_scoped_edit | **FAIL** | `test-pack/real/batch_720p_m5e/nasa_speaker_scoped_edit/results.json` | `test-pack/real/batch_720p_m5e/nasa_speaker_scoped_edit/timeline.json` | none | `31587e26fd9c` | step 1: expected needs_clarification, got rejected: Only one speaker was found in this video, so I cannot tell a guest |
| nasa_speaker_scoped_edit_no_hint | PASS | `test-pack/real/batch_720p_m5e/nasa_speaker_scoped_edit_no_hint/results.json` | `test-pack/real/batch_720p_m5e/nasa_speaker_scoped_edit_no_hint/timeline.json` | none | `31587e26fd9c` |  |
| worked_example_real | PASS | `test-pack/real/batch_720p_m5e/worked_example_real/results.json` | `test-pack/real/batch_720p_m5e/worked_example_real/timeline.json` | `test-pack/real/batch_720p_m5e/worked_example_real/render_1.mp4` (25.4 MB) | `5c590d67df2e` |  |

The five failures are kept on purpose. Reasons in short: 01 and 02: the brief's phrase "welcome to the channel" is not in my recording ("our channel"); 04: the transcript has no "um"; 22: "money" scored below the 25% meaning-search threshold; `nasa_speaker_scoped_edit`: the diarizer finds one effective speaker even with the hint. Detail in `docs/TEST_MEDIA.md`.

### Earlier runs, kept (not deleted)
- `test-pack/real/batch_720p/`: 36 sessions, 30 pass, 6 fail (before the diarization default changed). Log `test-pack/real/batch_720p_log.txt`.
| Session | Result | Folder |
|---|---|---|
| 01_worked_example | **FAIL** | `test-pack/real/batch_720p/01_worked_example/` |
| 01b_worked_example_as_recorded | PASS | `test-pack/real/batch_720p/01b_worked_example_as_recorded/` |
| 02_caption_cut_restore | **FAIL** | `test-pack/real/batch_720p/02_caption_cut_restore/` |
| 02b_caption_cut_restore_as_recorded | PASS | `test-pack/real/batch_720p/02b_caption_cut_restore_as_recorded/` |
| 03_reorder_then_mute | PASS | `test-pack/real/batch_720p/03_reorder_then_mute/` |
| 04_filler_removal_into_bleep | **FAIL** | `test-pack/real/batch_720p/04_filler_removal_into_bleep/` |
| 05_remove_range_twice | PASS | `test-pack/real/batch_720p/05_remove_range_twice/` |
| 06_caption_beyond_the_end | PASS | `test-pack/real/batch_720p/06_caption_beyond_the_end/` |
| 07_time_phrases | PASS | `test-pack/real/batch_720p/07_time_phrases/` |
| 08_undo_second_to_last_keep_music | PASS | `test-pack/real/batch_720p/08_undo_second_to_last_keep_music/` |
| 09_make_it_bigger_without_caption | PASS | `test-pack/real/batch_720p/09_make_it_bigger_without_caption/` |
| 10_everything_after_thanks | PASS | `test-pack/real/batch_720p/10_everything_after_thanks/` |
| 11_impossible_speed_and_cut_everything | PASS | `test-pack/real/batch_720p/11_impossible_speed_and_cut_everything/` |
| 12_three_parts_one_impossible | PASS | `test-pack/real/batch_720p/12_three_parts_one_impossible/` |
| 13_two_speakers_guest_old_job | PASS | `test-pack/real/batch_720p/13_two_speakers_guest_old_job/` |
| 13b_two_voice_dialogue_guest_old_job | **FAIL** | `test-pack/real/batch_720p/13b_two_voice_dialogue_guest_old_job/` |
| 14_variable_frame_rate_phone | PASS | `test-pack/real/batch_720p/14_variable_frame_rate_phone/` |
| 15_no_audio_track | PASS | `test-pack/real/batch_720p/15_no_audio_track/` |
| 16_auto_captions_and_speed | PASS | `test-pack/real/batch_720p/16_auto_captions_and_speed/` |
| 17_silences_and_protected_pause | PASS | `test-pack/real/batch_720p/17_silences_and_protected_pause/` |
| 18_keep_only_and_restore_edit | PASS | `test-pack/real/batch_720p/18_keep_only_and_restore_edit/` |
| 19_meaning_search_cost | PASS | `test-pack/real/batch_720p/19_meaning_search_cost/` |
| 20_vague_references | PASS | `test-pack/real/batch_720p/20_vague_references/` |
| 21_meaning_search_pricing | PASS | `test-pack/real/batch_720p/21_meaning_search_pricing/` |
| 22_meaning_search_beyond_the_words | **FAIL** | `test-pack/real/batch_720p/22_meaning_search_beyond_the_words/` |
| 23_llm_fallback | PASS | `test-pack/real/batch_720p/23_llm_fallback/` |
| 24_repeat_is_safe | PASS | `test-pack/real/batch_720p/24_repeat_is_safe/` |
| 25_vague_captions_and_restore | PASS | `test-pack/real/batch_720p/25_vague_captions_and_restore/` |
| diag_13c_two_voice_dialogue_threshold_0_3 | PASS | `test-pack/real/batch_720p/diag_13c_two_voice_dialogue_threshold_0_3/` |
| fillers_single | PASS | `test-pack/real/batch_720p/fillers_single/` |
| m5b_smoke_redeploy | PASS | `test-pack/real/batch_720p/m5b_smoke_redeploy/` |
| m6a_smoke | PASS | `test-pack/real/batch_720p/m6a_smoke/` |
| m6a_smoke_after_rotation | PASS | `test-pack/real/batch_720p/m6a_smoke_after_rotation/` |
| m6a_smoke_dotted_links | PASS | `test-pack/real/batch_720p/m6a_smoke_dotted_links/` |
| nasa_speaker_scoped_edit | **FAIL** | `test-pack/real/batch_720p/nasa_speaker_scoped_edit/` |
| worked_example_real | PASS | `test-pack/real/batch_720p/worked_example_real/` |

- `test-pack/m3_real/`: 22 sessions, 17 pass, 5 fail, at **full 1080p** (M3, before speaker-aware edits and vague references were built, so 13 and 20 failed then). Summary `test-pack/m3_real/summary.json`, log `docs/raw/m3_batch_log.txt`.
| Session | Result | Folder |
|---|---|---|
| 01_worked_example | **FAIL** | `test-pack/m3_real/01_worked_example/` |
| 01b_worked_example_as_recorded | PASS | `test-pack/m3_real/01b_worked_example_as_recorded/` |
| 02_caption_cut_restore | **FAIL** | `test-pack/m3_real/02_caption_cut_restore/` |
| 02b_caption_cut_restore_as_recorded | PASS | `test-pack/m3_real/02b_caption_cut_restore_as_recorded/` |
| 03_reorder_then_mute | PASS | `test-pack/m3_real/03_reorder_then_mute/` |
| 04_filler_removal_into_bleep | **FAIL** | `test-pack/m3_real/04_filler_removal_into_bleep/` |
| 05_remove_range_twice | PASS | `test-pack/m3_real/05_remove_range_twice/` |
| 06_caption_beyond_the_end | PASS | `test-pack/m3_real/06_caption_beyond_the_end/` |
| 07_time_phrases | PASS | `test-pack/m3_real/07_time_phrases/` |
| 08_undo_second_to_last_keep_music | PASS | `test-pack/m3_real/08_undo_second_to_last_keep_music/` |
| 09_make_it_bigger_without_caption | PASS | `test-pack/m3_real/09_make_it_bigger_without_caption/` |
| 10_everything_after_thanks | PASS | `test-pack/m3_real/10_everything_after_thanks/` |
| 11_impossible_speed_and_cut_everything | PASS | `test-pack/m3_real/11_impossible_speed_and_cut_everything/` |
| 12_three_parts_one_impossible | PASS | `test-pack/m3_real/12_three_parts_one_impossible/` |
| 13_two_speakers_guest_old_job | **FAIL** | `test-pack/m3_real/13_two_speakers_guest_old_job/` |
| 14_variable_frame_rate_phone | PASS | `test-pack/m3_real/14_variable_frame_rate_phone/` |
| 15_no_audio_track | PASS | `test-pack/m3_real/15_no_audio_track/` |
| 16_auto_captions_and_speed | PASS | `test-pack/m3_real/16_auto_captions_and_speed/` |
| 17_silences_and_protected_pause | PASS | `test-pack/m3_real/17_silences_and_protected_pause/` |
| 18_keep_only_and_restore_edit | PASS | `test-pack/m3_real/18_keep_only_and_restore_edit/` |
| 19_meaning_search_cost | PASS | `test-pack/m3_real/19_meaning_search_cost/` |
| 20_vague_references | **FAIL** | `test-pack/m3_real/20_vague_references/` |

- Other session outputs: `test-pack/real/worked_example_real/` (full resolution), `test-pack/real/worked_example_real_frames/` (3 renders), `test-pack/real/fillers_single/`, `test-pack/real/13b_two_voice_dialogue_guest_old_job/` (the FAIL at the old default 0.5), `test-pack/real/nasa_speaker_scoped_edit/` (FAIL), `test-pack/real/m5d/`, `docs/raw/m6a_smoke_out/`, `docs/raw/m5b_smoke_out/` (also `edit.otio`).

## 4. Failures, in one list
| What failed | Where it is recorded |
|---|---|
| Sessions 01, 02 (brief wording not in recording), 04 (no transcribed "um"), 22 ("money"), `nasa_speaker_scoped_edit` | section 3 |
| 13b at the old default (1 speaker found, 93/142 words) | `test-pack/real/13b_two_voice_dialogue_guest_old_job/`, `docs/TEST_MEDIA.md` section 3a |
| Sessions 13 and 20 in the M3 batch (features not built yet) | `test-pack/m3_real/` |
| First fresh-clone run of the test suite | `docs/raw/m5_ci_simulation_run1_failed.txt` |
| First scenario run (7 failures: 3 of my expectations, 1 wording, 1 parser limit, 1 missing warning, 1 real music bug) | `docs/raw/m5_scenarios_run1.txt`, `docs/REVIEW_M5.md` section 4 |
| First batch launches that failed completely (36/36 and 38/38 `fetch failed` / `ECONNREFUSED`) | explained in `docs/TEST_MEDIA.md` sections 5 and 6; those runs were discarded (the second one's files were deleted), so little or no file exists for them |
| 2 GB ingest (failed at ASR because of the 5-minute fetch limit; fixed) | `docs/raw/m5d_upload_2gb.txt`, `docs/raw/m5d_fetch_headers_timeout.txt` |
| Deployment slips (ports exposed ~10 min; certificate missing for the dotted name) | `docs/DEPLOY.md` |

## 5. Each REPORT.md claim and its file
| REPORT.md claim | File |
|---|---|
| Instruction latency median 15 ms, p95 41 ms, max 88 ms (115 steps) | `test-pack/real/batch_720p_m5e/*/results.json`, field `ms` of steps with kind `say` or `answer` |
| 60-minute engine numbers (synthetic, laptop) | `docs/PERF_ENGINE.md` |
| Worked example on real footage, hashes, 9 of 9 identical on rerun | `docs/WORKED_EXAMPLE_REAL.md`, `test-pack/real/worked_example_real/results.json`, `test-pack/real/batch_720p/worked_example_real/results.json` |
| 11 renders, frame difference 0, A/V at most 0.02 frame | `test-pack/real/batch_720p_m5e/*/render_1_manifest.json` (`render.frame_difference`, `render.audio_minus_video_frames`) |
| A/V offset 0.20-0.44 frame on generated clips | `docs/REVIEW_M3.md` section 3, `docs/raw/m3_accuracy_*.json` |
| Render seconds per output minute (46-53 at 720p; 65.4 at 1080p) | manifests (`timings.total_s`, `render.output.seconds`); `docs/WORKED_EXAMPLE_REAL.md` section 3 |
| CPU seconds per output minute (145 at 720p; 220-238 at 1080p) | manifests (`cost_estimate.cpu_seconds`); `docs/REVIEW_M3.md` section 5 |
| ASR RTF, diarization RTF | `docs/SPIKE_ASR.md` |
| Intake 125 s for 180.3 s | `docs/WORKED_EXAMPLE_REAL.md` (intro of the session description) and `results.json` `intake.ms` |
| Cold start 64.3 s and 23.8 s | `docs/raw/m2_cold_start.txt`, `docs/raw/m6a_cold_start.txt` |
| VM price 0.161 per hour | `docs/DEPLOY.md` "Cost of keeping the VM running" (third-party list price, unverified) |
| Gemini cost per call and latency | `docs/REVIEW_M4.md` section 5, `docs/raw/m4_llm_latency_probe.txt` |
| 48 scenarios, 50 of 50 | `docs/raw/m5b_scenarios_run.txt` |
| 40 mutants killed | `docs/REVIEW_M1C.md` section 5 |
| Fresh-clone test run, and its first failure | `docs/raw/m5_ci_simulation.txt`, `docs/raw/m5_ci_simulation_run1_failed.txt` |
| Diarization sweep, no value right on all 6 | `docs/raw/m5d_diarization_sweep_table.md` |
| Filler markers 29, no ground truth | `test-pack/real/fillers_single/results.json`, `docs/TEST_MEDIA.md` section 2 |
| Meaning search limits | `docs/REVIEW_M4.md` section 4, session 22 in section 3 |
| 361 pieces: 149 s versus 58 s | `docs/raw/m3_bench_*.json`, `docs/REVIEW_M3.md` section 4 |
| Evidence counts 42 / 15 / 0 | `docs/SUBMISSION_EVIDENCE.md` Summary |

## 6. To regenerate
`npm run batch -- sessions --out <dir>` (needs the stack running, the files in `media/`, and real models); `docker compose run --rm tests` for the unit, integration and scenario suites. `npm run metrics` does **not** exist; the latency statistics above were computed from `results.json` files with a short script (median, 95th percentile and maximum of `ms` over say/answer steps).
