# Demo video script (unedited screen recording, target 7:30, hard limit 8:00)

One take, no cuts. Four required parts: one clean run, one failure and how the system handles it, the tests running, one design decision explained in code. Timings are targets; the runtime of each command was measured earlier (source next to it) except where it says "not timed".

**What I did not do:** I did not run these commands against the live URL while writing this script (that would create sessions on the public demo and needs the token). The file-based commands (`jq`, `npm test`) were run on the saved files and the two test suites; the `npm run session` commands against the URL are copied from `README.md` and the earlier smoke runs. **Do one full rehearsal first.**

## Before recording (off camera)
1. Free the VM: nothing else running (`docker stats --no-stream` shows the live stack idle). Do not start `docker compose run --rm tests` during the recording: it takes about 4 min 17 s (`docs/raw/m5_ci_simulation.txt`) and competes with the demo for the 4 vCPUs.
2. In the terminal that will be recorded, from `~/incubrix-ps2`:
   ```
   export API_URL=https://34.93.140.79.sslip.io
   export API_TOKEN=$(sed -n 's/^API_TOKEN=//p' .env)
   clear
   ```
   Use the environment variable, not `--token`: the runner and `npm run` print command lines, and a token on a command line ended up on screen once (`docs/DEPLOY.md`, M5d). Never run `cat .env` or `env` on camera.
3. Check: `curl -s $API_URL/ready` returns `{"status":"ready","service":"api"}`; `ls media/m6a_smoke.mp4 media/no_audio.mp4` exist; `jq --version` works. Raise the terminal font size so a phone can read it.
4. Open `https://34.93.140.79.sslip.io/docs` in a browser once before recording. `docs/DEPLOY.md` says Swagger UI was fetched but **never opened in a browser**. If "Authorize" or "Try it out" misbehaves, drop minute 0:30-1:00 below and say nothing about it.
5. Keep the dotted host name: `34.93.140.79.sslip.io` (the dashed name also works for the API, but download links only work on the name they were signed for).

## Part 1: introduction (0:00-0:30)
Say: what the system is (type a sentence, get an edit; the source is never touched); the live URL; that nothing is edited or cut.
Show and type:
```
git log --oneline | head -5
curl -s $API_URL/ready
```
Then switch to the browser: `https://34.93.140.79.sslip.io/docs` (Swagger UI generated from `openapi.yaml`). Point to `/api/v1/sessions/{session_id}/instructions` and the three-way answer schema. 15 seconds.

## Part 2: one clean run on the live URL (0:30-2:00)
Say: this uploads a 15-second generated clip (AI-generated speech, `SOURCES.md`), runs real speech recognition and diarization, applies two edits, renders, downloads.
```
npm run session -- sessions/m6a_smoke.yaml --api $API_URL --out /tmp/demo_clean
```
Expected: PASS in about 17 s (earlier runs: `docs/raw/m6a_smoke_after_rotation.txt` 17.3 s, `docs/raw/m6a_smoke_dotted_links.txt`; render 3 s). While it runs, say what each step is: "add captions", "cut 0:05-0:07", render.
Then show the evidence of the run:
```
jq -r '.steps[]|[.step,.say,.status,.time_policy,.timeline_hash[0:12],.duration_s]|@tsv' /tmp/demo_clean/results.json
jq '{frames:.render.rendered_frames,timeline:.render.timeline_frames,diff:.render.frame_difference,av:.render.audio_minus_video_frames,source_unchanged:.render.source.unchanged}' /tmp/demo_clean/render_1_manifest.json
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 /tmp/demo_clean/render_1.mp4
```
Say: the answer states the time policy; the render has exactly the timeline's frames; the source sha256 was checked before and after. (If the file name differs, `ls /tmp/demo_clean`.)

## Part 3: the brief's worked example on real footage, from saved results (2:00-3:15)
Say: the full run uploads a 200 MB video and renders for 2 minutes, so I show the saved run of the same session on the same server software; it is in the repository.
```
jq -r '.steps[]|select(.kind=="say" or .kind=="answer")|[.step,(.say//.answer_sent//""),.status,.timeline_hash[0:12],.duration_s]|@tsv' test-pack/real/worked_example_real/results.json
```
Point out on screen:
- step 3 `needs_clarification` (7 mentions of pricing) with the hash unchanged from step 2 (`b578640252a7`), step 4 `applied` after "the second one";
- step 5 "speed up" gives `ccf60b546a5e`; step 6 "put the intro back" gives `8575c6032834`; step 7 `undo` returns exactly `ccf60b546a5e`. Same hash = the log replays to the same timeline;
- the caption move: `jq -r '.steps[1].summary' test-pack/real/worked_example_real/results.json` prints "caption "Welcome!" moved from 0:39.501 to 0:09.501".
Say plainly: my recording says "our channel" and has 7 pricing mentions, so the numbers differ from the brief (`docs/WORKED_EXAMPLE_REAL.md`).
Render proof: `jq '.render|{rendered_frames,timeline_frames,frame_difference}' test-pack/real/worked_example_real/render_1_manifest.json` (3911, 3911, 0).

## Part 4: a failure and how it is handled (3:15-4:45)
**4a. A system failure, live (about 1 s).**
```
npm run session -- sessions/15_no_audio_track.yaml --api $API_URL --out /tmp/demo_fail
jq '.intake.error' /tmp/demo_fail/results.json
```
Expected: the job fails with `NO_AUDIO_TRACK`, message "This video has no audio track, so there is nothing to transcribe.", `retryable: false`; the session file expects exactly that, so the runner reports PASS for the right reason (intake took 1.0 s in `test-pack/real/batch_720p_m5e/15_no_audio_track/results.json`). Say: the error is JSON with an UPPER_SNAKE code listed in the README table, and no session is opened.
**4b. A rejected instruction (saved result).**
```
jq -r '.steps[]|[.step,.say,.status,.reason]|@tsv' test-pack/real/batch_720p_m5e/06_caption_beyond_the_end/results.json
```
Shows "add a caption at 5:00" on a 3:00 video: `rejected`, HTTP 200, reason stated, timeline unchanged. Say: rejected is a normal answer, not an HTTP error.
**4c. A failure I did not fix.**
```
jq -r '.sessions[]|select(.passed==false)|.name' test-pack/real/batch_720p_m5e/summary.json
```
Prints 5 names (33 of 38 sessions pass). Pick `nasa_speaker_scoped_edit`: open `docs/TEST_MEDIA.md`, search "M5d update", and say in two sentences: on a real two-person podcast clip the speaker separation does not work, so "remove everything the guest says" is answered "Only one speaker was found" (or asks "Speaker A, B or C"), not guessed. Also say 01 and 02 fail because the brief's phrase is not in my recording. Do not claim the multi-speaker feature works on real speech.

## Part 5: the tests running (4:45-5:45)
```
npm test -w @incubrix/engine
npm test -w @incubrix/nlu
```
Expected (timed on this VM today): engine 251 passed, 1 skipped, 14 files, about 12 s wall; nlu 71 passed, about 6 s. Say what they cover: engine = replay, hashes, undo/restore, reorder, frame rounding, purity lint (no clock, random, fs, network); nlu = the rules parser.
Then the full suite, from the saved log, said out loud as a saved log:
```
ls scenarios | wc -l
tail -25 docs/raw/m5b_scenarios_run.txt
```
(48 scenarios; 50 of 50 tests pass, 99.7 s in that run.) Say: the one command for everything is `docker compose run --rm tests`; it runs on its own throwaway Postgres and storage and takes about four minutes with cached layers, so I did not run it in this video (`docs/raw/m5_ci_simulation.txt`). Say that no GitHub Actions run has happened.

## Part 6: one design decision, explained in code (5:45-7:15)
Decision: **edits point at atoms (words and silences with stable ids), never at seconds.** Open `packages/engine/src/replay.ts`:
1. Lines 246-253, `case "add_effect"`: the effect is stored with `range: op.range`, an `AtomRange` (two atom ids), not times. Say: a caption knows its words, not its seconds.
2. Lines 229-232 (`case "cut"`): a cut only removes an interval from the list of segments; it does not touch effects.
3. Lines 342-357 (`const effects ... state: alive > 0 ? "active" : "inactive"`, `partial`): after replay, an effect's state is computed from which of its words survive. All words cut gives `inactive` (kept in the log, returns on restore); some cut gives `partial`.
4. Line 290, `case "restore"`: "Realized by excluding the target group when the log is replayed". Restore is an operation, not an undo of the past; the log is never rewritten.
Then show the consequence in the data (already on screen from Part 3): the same caption moved from 0:39.501 to 0:09.501 after the cut and came back after the restore, with no code touching the caption. Optional 20 seconds: `sed -n 1,30p docs/DESIGN.md` for "The one idea".
Say the cost: effect ids count edit operations, so two different histories that look identical can hash differently; and the atoms are only as good as the recognizer's word boundaries.

## Part 7: close (7:15-7:30)
Say what is not verified in one breath: no real two-person edit, no 60-minute video through the API, nobody listened to the renders, GitHub Actions not run. Point to `docs/SUBMISSION_EVIDENCE.md` and `test-pack/INDEX.md`. Stop recording.

## Time budget
| Part | Start | Length |
|---|---|---|
| 1 Introduction | 0:00 | 0:30 |
| 2 Clean run | 0:30 | 1:30 |
| 3 Worked example (saved) | 2:00 | 1:15 |
| 4 Failure | 3:15 | 1:30 |
| 5 Tests | 4:45 | 1:00 |
| 6 Design decision | 5:45 | 1:30 |
| 7 Close | 7:15 | 0:15 |
| **Total** | | **7:30** (30 s spare) |

## If something goes wrong on camera
Keep recording; say what happened. A failed command is part of an unedited recording, and every failure in this project is documented. If the live URL is down, run Part 2 against a local stack (`docker compose up -d`, `API_URL=http://localhost:8080`, no token) and say so.
