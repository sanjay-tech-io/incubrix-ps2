# Requirements checklist (from the IncuBrix brief)

## Must-haves (all pass/fail)
1. Never damage the original: edits are history steps over the untouched source; verify via source hash and history.
2. Edits stick to content: captions/mutes/bleeps/effects stay on their words after cuts, speed changes, reorders, restores.
3. Three-way answers on every instruction: applied, needs_clarification, rejected.
4. Predictable: same session gives the same timeline_hash on 3 runs; LLM only translates text to operations; all timeline logic is our own code.
5. Render matches the timeline: A/V sync within 1 frame, length within 1 frame, after any mix of edits.
6. All operations work: cut range, keep only range, reorder, speed up/slow down, mute/bleep words, caption/text overlay, auto-caption, remove fillers (um, uh, "like" only as filler), remove silences longer than N s, background music that ducks under speech, undo/redo (1 instruction = 1 undo, new edit clears redo), restore a specific earlier edit.
7. One stated time policy, mentioned in answers.
8. Integration Standard followed, session runner works, live demo works for the whole review period.

## Worked example (must reproduce exactly on our own test video)
1 caption "Welcome!" on "welcome to the channel" (original 0:42-0:44). 2 cut first 30 s: caption now 0:12-0:14 on same words. 3 "remove the part about pricing": needs_clarification (3 mentions); answer "the second one": applied. 4 speed up 1:00-1:30 by 2x (state time policy). 5 "put the intro back": first 30 s return, caption back at 0:42, pricing cut and speed change stay. 6 undo reverses step 5 only. 7 "make that caption red" applies to the only caption. 8 render: in sync, length matches, caption on right words.

## Levels (a level counts only if every item is verified and the previous level is verified)
Core: all must-haves; worked example runs; one single-speaker and one multi-speaker video.
Advanced: captions follow words; caption whose words are cut is removed and user told; defined rule for partial cuts of a captioned phrase; sped-up captions keep a readable minimum (~0.7 s); ambiguity and references ("that caption", "the boring part", "make it shorter", "put back what I removed") ask or state assumption with options; meaning-based search ("pricing" finds "cost") shows matches before cutting; repeated instructions are safe; deliberate pauses survive silence removal; impossible or whole-video cuts rejected; documented rule for overlapping speed changes; multi-part instructions apply all or report exactly which parts applied; two speakers: "remove everything the guest says about their old job" removes only the guest's lines and asks about the host's lead-in.
Outstanding: cuts snap to nearby silence (no clipped words); low-confidence words flagged, not bleeped blindly; variable frame rate and no-audio videos work or fail clearly; overlapping speech and possible speaker-label swaps warn; 60-minute video responds under 3 s per instruction (excluding transcription and render); OpenTimelineIO export; automated suite of at least 40 scripted scenarios with expected results in CI.

## Hard cases (test all, record results, keep failures)
Caption added, its sentence cut, cut restored (caption returns). Section reordered then a word muted; filler removal cutting into a bleeped word. "Remove 0:30-0:40" sent twice; "add a caption at 5:00" on a shorter video; "80 seconds", "a minute twenty", "the last 10 seconds". "Undo the second-to-last cut but keep the music"; "make it bigger" with no caption. "Remove everything after I say thanks" (said four times). "Speed up 10x", "cut everything", a three-part instruction with one impossible part. Two-speaker video with label swap, overlapping speech, background music, and a phone video with variable frame rate.

## Integration Standard (2 marks each, 20 total)
1 docker compose up starts everything (db, storage, local servers); one command runs all tests with no keys; .env.example. 2 openapi.yaml (3.1) matches the running service; routes under /api/v1. 3 Jobs: 202 + job_id; GET /api/v1/jobs/{job_id} with status/progress/result links; optional HMAC callback. 4 Idempotency-Key on every POST. 5 Clear JSON errors with UPPER_SNAKE codes listed in README. 6 All config via env/config file. 7 Inputs by upload or URL; outputs in S3-compatible storage with download links. 8 JSON logs (timestamp, level, job_id, correlation id), /health and /ready. 9 Manifest on every result. 10 Batch runner CLI writing all results to one folder.

## Rules
Adapters + mock for every external service. Everything in the default path must be commercially licensed (no CC BY-NC, avoid AGPL). Rate limit and access token on the live demo. No secrets anywhere. Label AI output in manifests. Individual work: I must be able to explain and change all code live.

## Metrics to report (real runs only)
Instruction latency (median and slowest, 5-min and 60-min video); render accuracy (largest A/V offset and length difference in frames); determinism (share of sessions with identical hash over 3 runs, must be 100%); clarification quality (asked/assumed vs guessed); word clipping (20-cut listening check); cost per minute (speech-to-text + LLM).

## Deliverables
Private GitHub repo with admin@incubrix.com as reviewer and real commit history; live demo URL (+token) up until results; README (architecture diagram, setup in under 10 commands, tests, batch runner, all settings); openapi.yaml; REPORT.md (2-4 pages); SOURCES.md; AI_USE.md; test pack with an index linking claims to files; unedited demo video (max 8 min: one clean run, one failure and how it is handled, tests running, one design decision explained in code); session pack (at least 15 sessions with results.json, final timelines, rendered videos, failures included); timeline JSON Schema with a one-page explanation; completed Submission Form (Excel).
