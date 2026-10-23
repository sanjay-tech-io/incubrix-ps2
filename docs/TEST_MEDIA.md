# Test media and deviations (M5c)

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
