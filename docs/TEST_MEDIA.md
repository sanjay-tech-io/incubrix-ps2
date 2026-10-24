# Test media and deviations (M5c) - with the M5d update below

## M5d update (2026-10-23): diarization default, the speaker hint, re-runs
**What was asked:** pick a diarization default from a sweep over ALL clips, not one; make the answer suggest `num_speakers` when one speaker is found for a guest/host request; re-run 13b and the NASA session.

**The sweep** (`docs/raw/m5d_diarization_sweep.jsonl`, 66 runs of the real diarizer: sherpa-onnx pyannote-3.0 + WeSpeaker, 11 thresholds x 6 clips; `scripts/sweep_table.mjs` makes the table; `docs/raw/m5d_diarization_sweep_table.md`). Each cell is `labels found / labels holding at least 5% of the speech`; **bold = right** (the second number equals the expected speaker count). Expected counts: 3 synthetic clips 2, the real single speaker `test_single` 1 (control), two NASA windows 2 (host + guest).

| clip (expected) | 0.15 | 0.2 | 0.25 | 0.3 | 0.35 | 0.4 | 0.45 | 0.5 | 0.55 | 0.6 | 0.7 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| two_voice.wav (2) | **2/2** | **2/2** | **2/2** | **2/2** | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| two_speaker16k.wav (2) | **2/2** | **2/2** | **2/2** | **2/2** | **2/2** | **2/2** | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| dlg16k.wav (2) | **2/2** | **2/2** | **2/2** | **2/2** | **2/2** | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| single16k.wav (1) | 4/3 | 2/2 | **1/1** | **1/1** | **1/1** | **1/1** | **1/1** | **1/1** | **1/1** | **1/1** | **1/1** |
| nasa_1200_120.wav (2) | 9/3 | 8/3 | 7/3 | 6/3 | 5/3 | **4/2** | **3/2** | **3/2** | 3/1 | 3/1 | 2/1 |
| nasa_0_240.wav (2) | 9/3 | **6/2** | **6/2** | **4/2** | **4/2** | **4/2** | **3/2** | 2/1 | 2/1 | 2/1 | 2/1 |

- **No threshold is right on all 6 clips.** 0.25-0.30 are right on 5 of 6 (all except the 20:00 NASA window, which shows 3 substantial labels from 0.15 up to 0.35); 0.4 on 4; 0.5 (the old default) on 2 (the control and the 20:00 NASA window; all three synthetic clips and NASA 0-240 fail); 0.2 and below split the single real speaker. **Chosen default: 0.3** (`DIARIZATION_CLUSTER_THRESHOLD`, was 0.5). Why 0.3 and not 0.25, the other 5-of-6 value: both sit one step from a failure (0.35 loses `two_voice`, 0.2 splits the control), and real speech over-splits more at lower values.
- **How robust: not very.** The working range is two grid points wide (0.25-0.30, grid step 0.05); one step up loses a clip, one step down splits the control. Why it cannot be better with thresholds: the turn embeddings show it (`docs/raw/m5d_turn_embeddings.json`): the two espeak voices are **0.72** alike across speakers and 0.95 within one, while the real single speaker's own turns go down to **0.58** alike. A real person's turns can sound less alike than two different synthetic voices, so any cut-off that separates the synthetic pair also splits the real speaker. The threshold is also a cosine DISTANCE (1 - similarity), which is why 0.5 merges everything that is more than 0.5 similar.
- **Counting rule:** the pipeline counts every label that gets words; the sweep counts labels with at least 5% of the speech, because slivers (a 0.9 s label on NASA) are not speakers. The sweep cannot say whether the labels sit on the right people, only how many there are.
- Tuned on 6 clips, 3 of them synthetic and 2 from one podcast: this is a compromise, not a validated setting.

**The hint (`num_speakers`) did not work on the dialogue clip, and now does.** sherpa ignored `num_clusters=2` on `two_voice_dialogue` (1 label back, although the turn embeddings separate the speakers perfectly). New `services/asr/asr/cluster.py` (tests: `services/asr/tests/test_cluster.py`, 8): when a hint of 2+ speakers comes back with fewer than that many *substantial* speakers (at least 5% of the speech each), the turns are clustered again from their embeddings into exactly that many groups (average-linkage on cosine distance, deterministic; only labels change). The service reports `hint_fallback: true` when it did this. Scored against the by-construction truth (`test-pack/real/two_voice/asr_after_*.json`): **no hint 142 of 142 words right (2 speakers), hint 2 142 of 142 (fallback used)**; before: 93 of 142 with 1 speaker. The hint is accepted per video on upload and on URL intake (`num_speakers`, `openapi.yaml`, API and worker tests). The transcript cache key is now `v: 5` so transcripts made with the old behaviour are not reused.
**The answer when one speaker is found** and the request names a guest/host/speaker: "Only one speaker was found ... the diarization may have merged their voices: upload it again with the num_speakers hint (for example num_speakers=2 ...). Or say what to remove by time, topic or phrase." (`packages/nlu/test/advanced.test.ts`). It does not know whether a hint was already given, so on NASA with the hint it repeats advice that was already followed.

**Re-runs through the PUBLIC URL** (`test-pack/real/m5d/`), real ASR, defaults (threshold 0.3):
| Session | Hint | Result |
|---|---|---|
| `13b_two_voice_dialogue_guest_old_job` | 2 | **PASS**: needs_clarification: "Assuming Speaker A ... host and Speaker B is the guest. Speaker B talks about "old job" in 4 lines ... Should I remove the lead-in too?" (2 options) |
| `13d_two_voice_dialogue_no_hint` (new) | none | **PASS**, same answer; the intake says "2 speakers were detected; if that is wrong, upload again with the num_speakers hint." |
| `nasa_speaker_scoped_edit` | 2 | **FAIL, kept**: "Only one speaker was found". With the hint, sherpa's second label is a 10 s stretch (118-129 s) and the embedding fallback isolates the same stretch, not host versus guest; no word gets it. |
| `nasa_speaker_scoped_edit_no_hint` (new) | none | needs_clarification: "3 speakers were detected ... Which speaker is the guest: Speaker A, Speaker B or Speaker C?" with a sample line each: A "Houston, we have a podcast.", B "and more.", C "Thank you, it's my pleasure.". **Found 3, expected 2** (the host's voice is split in two); the guest is Speaker C, and the answer asks instead of guessing. It passes because a question is the expected status; 18 words carry a possible-label-swap warning. |
So: speakers found vs expected after the change: dialogue **2 of 2** (with and without the hint), NASA **3 of 2 without a hint (guest identifiable), 1 effective of 2 with the hint**, `test_single` 1 of 1 (sweep, diarizer only; not re-ingested through the pipeline). The dialogue's removal still cuts the "new job" line and misses line 4 (ASR heard "old John"): that is topic matching, unchanged.
**Not re-run:** sessions 13 (old clip) and the other batch sessions after the threshold change; the full batch (it ran before the change). The sessions that use `test_single.mp4` only exercise one-speaker behaviour and were not re-ingested.

---


Written 2026-10-23, after the decision that there will be **no new recordings**. Everything here was run on the live stack (api, worker, postgres, SeaweedFS, asr containers on the VM), real ASR and real diarization, no mocks. Raw output: `test-pack/real/`. Rights for every clip: `SOURCES.md`.

## 1. What the media is, and how it differs from the brief
| Brief wants | What we have | Deviation |
|---|---|---|
| One single-speaker video that follows the worked-example script | `media/test_single.mp4`: my own recording (180.3 s, 1080p30), made before the script, one speaker | Says "welcome to **our** channel" (0:39.5), not "the channel" (0:42); mentions pricing **7** times, not 3. Details and the step table: `docs/WORKED_EXAMPLE_REAL.md`. |
| A real two-person video | **None of ours.** (a) `media/two_voice_dialogue.mp4`: two espeak-ng voices reading a script I wrote (AI-generated, SOURCES.md), (b) the first 240 s of a NASA podcast (public domain, real speech) | (a) is synthetic and robotic; (b) is real speech but audio only (black picture added by me) and diarization does not separate its two speakers (section 3). We therefore have **no verified real two-person edit**. |
| Recordings with fillers, label swaps, overlapping speech, VFR phone | generated clips (espeak, flash/beep, dropped frames) | synthetic only, as in REVIEW_M5 |

## 2. Fillers: "remove the ums" on `test_single.mp4`
Session `sessions/fillers_single.yaml`, raw `test-pack/real/fillers_single/results.json`.
- **Transcribed fillers (um/uh/hmm/er/ah in the ASR text): 0.** base.en with no prompt, as in REVIEW_M4 section 3. The answer: "No transcribed filler words were found. 29 possible untranscribed filler(s) found ... Cut them?" status **needs_clarification**, nothing cut, hash unchanged. Two options: cut all 29 / cut only the 23 with confidence 35% or more (the 6 at 20% are left).
- **Possible-filler markers (voiced stretch 0.15-1.2 s in a gap between words): 29**, the same 29 as on the earlier run of this file (m:ss.ss, length, level against speech, confidence):

| time | len | dB | conf | time | len | dB | conf | time | len | dB | conf |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0:01.34 | 0.38 | -8.9 | 20% | 0:41.54 | 0.36 | 0.3 | 35% | 2:03.26 | 0.38 | 2.0 | 35% |
| 0:02.36 | 0.36 | -1.8 | 35% | 0:43.38 | 0.20 | -1.5 | 35% | 2:10.74 | 0.36 | -5.5 | 35% |
| 0:02.90 | 0.28 | -1.6 | 35% | 0:45.44 | 0.30 | -0.5 | 35% | 2:12.60 | 0.36 | -1.3 | 35% |
| 0:06.24 | 0.36 | -2.9 | 20% | 0:50.24 | 0.42 | -2.5 | 35% | 2:13.60 | 0.58 | 3.1 | 35% |
| **0:07.34** | 1.04 | -7.5 | 45% | 1:38.20 | 0.32 | -10.7 | 35% | 2:15.56 | 0.42 | 6.2 | 35% |
| 0:11.92 | 0.26 | -1.1 | 35% | 1:51.94 | 0.16 | -11.6 | 20% | 2:22.10 | 0.38 | -3.8 | 35% |
| 0:19.04 | 0.28 | -2.9 | 20% | 1:52.82 | 0.36 | 2.1 | 35% | 2:22.78 | 0.20 | 11.1 | 35% |
| 0:25.76 | 0.32 | -5.5 | 35% | **1:54.20** | 0.78 | 5.2 | 45% | 2:29.30 | 0.42 | 0.0 | 35% |
| 0:27.40 | 0.50 | -4.2 | 35% | | | | | 2:35.34 | 0.42 | -8.8 | 20% |
| 0:33.86 | 0.58 | -11.3 | 20% | | | | | 2:52.94 | 0.38 | -4.1 | 35% |
| | | | | | | | | 2:56.56 | 0.42 | -4.3 | 35% |

- **Cross-check with a disfluency prompt** (earlier run, `docs/raw/m4_filler_asr_check_old_recording.json`, not repeated now): base.en + prompt found "Umm," at 7.3 s and "uh," at 10.0 s; small.en + prompt found "Umm," 7.5 s, "uh," 10.4 s, "uh," 19.5 s. The 7.3/7.5 s ones fall inside the marker 0:07.34-0:08.38 and the 19.5 s one is just after 0:19.04-0:19.32; **the 10.0/10.4 s one has no marker near it**.
- **Ground truth: none.** I cannot listen. So I cannot say how many of the 29 are real "um"s (vs. breaths, laughs, coughs, dropped words), nor whether the prompt-found fillers are real. The only "agreement" is between two automatic methods. Session 04 (`remove um ...` then a bleep) fails on this recording: there is no transcribed "um" ("I could not find "um" in the video").

## 3. Two speakers
### 3a. Synthetic dialogue (`media/two_voice_dialogue.mp4`, 58.2 s, AI-generated)
12 lines (`scripts/dialogue_script.txt`, `scripts/make_dialogue_clip.sh`, truth by construction in `media/two_voice_dialogue_truth.json`): host (en-us) asks the lead-in "So tell me about your old job." (line 2); the guest (en-gb-x-rp+f3) talks about the old job in lines 3, 4 and 10, about the factory closing in line 6, and about the new job in line 8.

**Speakers found vs expected (2): FAILED at the default settings.**
| Setting | Speakers found | Words labelled correctly (142 scored against the truth) |
|---|---|---|
| default (`DIARIZATION_CLUSTER_THRESHOLD` 0.5, no hint) | **1** | 93 = 65.5% (everything labelled as one speaker) |
| `num_speakers=2` hint (what the session runner sends) | **1** (the hint did not split it) | 93 = 65.5% |
Raw: `test-pack/real/two_voice/asr_nohint.json`, `asr_hint2.json`. So **`sessions/13b_two_voice_dialogue_guest_old_job.yaml` FAILS**: answer `rejected`, "Only one speaker was found in this video, so I cannot tell a guest from a host" (correct behaviour for one found speaker; wrong result for the test). Kept as a failure.

**Threshold sweep, to see how fragile this is** (directly on the diarizer in the ASR container; number of speakers found; raw output in the tool log only, not saved as a file):
| clip (expected speakers) | 0.5 | 0.4 | 0.3 | 0.2 | hint 2 |
|---|---|---|---|---|---|
| `two_voice.wav`, older synthetic clip (2) | 1 | 1 | 2 | 2 | 2 |
| `two_speaker.mp4`, session 13's clip (2) | 1 | 2 | 2 | 2 | 2 |
| `two_voice_dialogue.wav` (2) | 1 | 1 | 2 | 2 | **1** |
| `test_single` 142 s of speech (1) | 1 | 1 | 1 | 2 (false split) | 1 |
| NASA 120 s window at 20:00 (2) | 3 | 4 | 6 | 8 | 2 |
Reading: the default 0.5 finds 1 speaker on all three synthetic clips; the hint works on two clips and **not** on the new one; 0.3 fits the synthetic clips and the single speaker but splits the NASA speech into 6. **I did not change the default**: any value picked from this table would be tuned on the test clips. It is a real weakness: diarization needs a hint or a tuned threshold per recording, and the hint is not reliable.

**Diagnostic run with 0.3 and no hint** (explicitly NOT the default: `DIARIZATION_CLUSTER_THRESHOLD=0.3` set on the ASR container for this run only, `.env` and container restored afterwards; metadata-tagged copy of the clip so the transcript cache was not reused; `sessions/diag_13c_two_voice_dialogue_threshold_0_3.yaml`, raw `test-pack/real/diag_13c_threshold_0_3/`): 2 speakers found. The answer to "remove everything the guest says about their old job": **needs_clarification**, "Assuming Speaker A (the first speaker I heard) is the host and Speaker B is the guest. Speaker B talks about "old job" in 4 lines. The question just before it (the lead-in) is "So tell me about your old job." at 0:07.293. Should I remove the lead-in too?" with 2 options (keep the lead-in / also remove it), warning "3 word(s) in these lines have an uncertain speaker label". Answering "the first one": applied, 58.200 -> 40.320 s (-17.880 s), warning about low-confidence words.
**Against the truth, the 4 lines it matched (0:10.308, 0:28.051, 0:37.127, 0:46.780) are lines 3, 6, 8, 10:**
- line 3 "My old job was in a factory ..." correct;
- line 10 "Sometimes I miss my old job ..." correct;
- line 6 "The factory closed ..." is about the end of the old job: arguably on topic, not literally "old job";
- **line 8 "Now I build software for a small company ..." is about the NEW job: a wrong cut** (meaning search matched "job");
- **line 4 "The old job was hard ..." was MISSED**: the ASR wrote "The old John One had, but ..." so neither the words nor the meaning matched.
So 2 of the 3 literal old-job lines were found and one wrong line was cut. The host's lead-in question was asked about, not cut, as the brief wants. This run passes in the batch only because it hit the transcript cache of the diagnostic run; it is **not** a result under default settings.

### 3b. Real speech: NASA clip
Rights evidence re-checked 2026-10-23 and recorded in SOURCES.md (`docs/licence-evidence/nasa-ep407-commons-record.json`, `nasa-media-usage-guidelines-excerpt.txt`): Commons "Public domain", NASA guidelines "generally not subject to copyright", with the caveat about identifiable persons in commercial/promotional use. I judged it **clear enough for a test input** (not promotional, not redistributed, clip and transcripts not in git) and used it; **you should confirm that decision**.
Expected speakers: 2 (host Nilufar Ramji, guest Tracy Dyson), from the Commons description of the file, which also gives the speaker-labelled text. First 300 s transcribed with diarization (raw `test-pack/real/nasa/`, not in git): the host speaks alone until about 2:14 (323 of 754 words), the guest's first words ("Thank you. It's my pleasure.") are at 2:14.7, the guest's long answer follows.
- **Speakers found: the diarizer reported 2 speakers (turns) but every one of the 754 words got SPEAKER_00**, with and without the 2-speaker hint. So no host/guest separation (words after about 2:15, mostly the guest's, are labelled as the host: roughly half of the words are wrong by this reading; I did not score word by word, host interjections are inside the guest part).
- The edit: `sessions/nasa_speaker_scoped_edit.yaml` on the first 240 s, "remove everything the guest says about the astronaut program": **rejected**, "Only one speaker was found in this video". **FAIL**, kept. So the brief's "two speakers" behaviour is shown only on synthetic voices, and only with a threshold chosen on them.

### Speakers found vs expected, summary
| Clip | Expected | Found (default settings) | Found with extra help |
|---|---|---|---|
| `two_speaker.mp4` (session 13, espeak, 8 lines) | 2 | 2 with the hint (session 13 passes); 1 without | |
| `two_voice_dialogue.mp4` | 2 | **1** (also with the hint) | 2 at threshold 0.3 |
| NASA 0-240 s | 2 | 1 effective (2 clusters, all words one label) | not found at any threshold tried |
| `test_single.mp4` | 1 | 1 | |

## 4. Not verified
- Anything about real two-person video: none exists in the test set; the diarizer does not work on the real clip.
- Filler ground truth (nobody listened); whether the 29 markers are fillers; the prompt-found fillers.
- Word-level accuracy of the NASA labels (not scored word by word); the 6-speaker/8-speaker NASA sweep rows are counts, not scored.
- The threshold sweep output was printed to the terminal only; the numbers in the table above are copied from that output, there is no raw file.
- The dialogue session in the batch passing (`diag_13c`) is a cache hit, not a repeat of the diagnostic.
- Everything is one run per condition; renders in the batch are 720p `veryfast`.

## 5. The full batch (720p, veryfast, `RENDER_MAX_HEIGHT=720`)
`npm run batch -- sessions`, 36 session files, live stack over the Docker network, 2026-10-23. Raw: `test-pack/real/batch_720p/summary.json`, per-session folders, `batch_720p_log.txt`. **30 passed, 6 failed.** The first launch failed completely (36/36 `fetch failed`) because I changed `.env` and `docker compose up -d worker` also recreated the api, postgres, s3 and asr containers; the batch started while they restarted. That run is discarded, nothing hidden: the second launch is the one reported. (The compose behaviour, not a code bug, but it also restarted the live demo's services for about a minute at roughly 16:35 UTC.)

| Result | Sessions |
|---|---|
| **FAIL (6)** | `01_worked_example` (the brief's phrase "the channel" is not in the recording: steps 1 and 8 rejected; unchanged on purpose), `02_caption_cut_restore` (same phrase), `04_filler_removal_into_bleep` (no transcribed "um" in the recording; step 2 asked a question instead of applying), `13b_two_voice_dialogue_guest_old_job` (1 speaker found), `22_meaning_search_beyond_the_words` ("money" rejected, below the 25% threshold; as in M4, expectation unchanged), `nasa_speaker_scoped_edit` (1 speaker found) |
| PASS (30) | 01b, 02b, 03, 05-12, 13 (two_speaker.mp4 with hint), 14 (VFR), 15 (no audio: fails clearly at intake, which the session expects), 16-21, 23-25, `diag_13c` (cache hit, see 3a), `fillers_single`, `m5b_smoke_redeploy`, `m6a_smoke`, `m6a_smoke_after_rotation`, `m6a_smoke_dotted_links`, `worked_example_real` |

The M3 batch (17/22) is not comparable: the file set is different (36 now, 14 new or changed since). Sessions 13, 20 and others that failed in M3 pass now with their expectations unchanged (M4). `worked_example_real` in the batch is a repeat of section 1 of `WORKED_EXAMPLE_REAL.md` at 720p: 3911 frames, 1280x720, 42.1 s of rendering per output minute (the full-resolution run took 65.4).

## 6. Full batch re-run after the threshold change (M5e, 2026-10-24)
`npm run batch -- sessions` with `RENDER_MAX_HEIGHT=720`, preset `veryfast`, diarization threshold 0.3 (the new default), 38 session files, live stack over the Docker network. Raw: `test-pack/real/batch_720p_m5e/summary.json`, `batch_720p_m5e_log.txt`. **33 passed, 5 failed.** (A first launch against `localhost:8080` failed 38/38 with `ECONNREFUSED` because the prod stack does not publish port 8080; it was discarded and the files deleted.)

| Result | Sessions |
|---|---|
| **FAIL (5)** | `01_worked_example`, `02_caption_cut_restore` (brief phrase "the channel" not in the recording), `04_filler_removal_into_bleep` (no transcribed "um"), `22_meaning_search_beyond_the_words` ("money" below the 25% threshold), `nasa_speaker_scoped_edit` (hint 2 still gives "only one speaker") |
| PASS (33) | all others, including `13b_two_voice_dialogue_guest_old_job` (failed before), and the new `13d_two_voice_dialogue_no_hint` and `nasa_speaker_scoped_edit_no_hint` |

Compared with section 5 (30/36): 13b changed fail to pass; two sessions were added and pass; no session that passed before fails. `worked_example_real`: all 9 statuses and timeline hashes identical to the earlier run; render 103.1 s for 130.4 s of output (47.4 s per output minute at 720p, one run; section 5 said 42.1). I did not check which sessions hit the transcript cache (the cache key changed in M5d, so older entries are not reused, but entries made during the M5d runs may be), so I do not claim which sessions exercised the new threshold freshly. One run, no repeats.
