# Recording script: single-speaker test video (about 3:30)

You record this yourself, so you own it (record it in SOURCES.md as "own recording, single speaker, consent: self").
The synthetic fixture used by the M1 tests (`packages/engine/test/fixtures/transcript.ts`) is modelled on this script. Your real recording will not match its timestamps exactly; the tests do not depend on the real video.

## Recording settings
- Talk to the camera, quiet room, no background music, no other voices.
- 1080p (or 720p), **constant 30 fps**, MP4/H.264 + AAC. (Record a separate phone clip later for the variable-frame-rate case.)
- Speak at a normal pace with short natural pauses between sentences. Do not edit the recording.

## Hard rules for the content
1. Say **"welcome to the channel"** exactly **once**, around 0:42-0:44. Never say "welcome" anywhere else.
2. A **silence of about 2 seconds** around 0:29-0:31 (stop talking, keep still). This is where "cut the first 30 seconds" lands.
3. Say the word **"pricing"** three times, each in its own sentence, **all after 0:30**: about 1:05, 1:50 and 2:40. In the second one, also say **"cost"** ("the pricing, I mean the cost, for teams is different").
4. Say **"um"** or **"uh"** about 4 times (one near 0:06, one near 0:18, one near 1:00, one near 2:50), as natural hesitations.
5. Say **"I like this tool"** exactly once (around 0:12) and never use "like" otherwise (no "it's like...", "you know, like"). This is the non-filler "like".
6. Say **"thanks"** exactly **4 times**: about 0:04, 0:48, 2:30 and 3:10 (the last one "thanks, and see you next time").
7. One **deliberate 3-second pause** around 1:20: say "Let me think about that..." then stay silent for 3 seconds on purpose, then continue.
8. One **bleepable word** around 2:00: say it once, clearly, in a normal sentence. Pick something harmless to publish, for example a made-up name ("my colleague Zorbleton told me...") or a mild word you are comfortable having bleeped. Say it only once.

## Timed script (targets; +/- a few seconds is fine)

| Time | What to say / do |
|---|---|
| 0:00-0:02 | Look at the camera, stay silent (about 2 s of lead-in silence). |
| 0:02-0:05 | "Hi everyone and **thanks** for watching." |
| 0:06-0:09 | "**Um**, today I will show you something useful." |
| 0:12-0:15 | "**I like this tool** because it is fast." |
| 0:18-0:21 | "**Uh**, let me explain how it works first." |
| 0:24-0:27 | "It takes only a few minutes to set up." |
| 0:28-0:29 | "Here we go." |
| 0:29-0:31 | **Silence (about 2 s).** |
| 0:31-0:34 | "First, let me show the basic features." |
| 0:36-0:39 | "You can import media and edit it quickly." |
| 0:42-0:44 | "**Welcome to the channel.**" (slowly, once) |
| 0:48-0:50 | "**Thanks** for joining me today." |
| 0:54-0:57 | "The editor works on any video file." |
| 1:00-1:02 | "**Um**, the interface is very clean." |
| 1:05-1:08 | "Now let us talk about **pricing**." (pricing #1) |
| 1:08-1:11 | "It is free for personal projects." |
| 1:15-1:18 | "You can export videos without limits." |
| 1:20-1:26 | "Let me think about that..." **then 3 seconds of silence**, then "OK, moving on." |
| 1:30-1:32 | "Honestly the speed is great." |
| 1:38-1:41 | "Captions are generated from your words." |
| 1:48-1:52 | "The **pricing**, I mean the **cost**, for teams is different." (pricing #2) |
| 1:53-1:56 | "Teams get extra storage and support." |
| 2:00-2:03 | A sentence containing the **bleepable word** (once). |
| 2:10-2:13 | "Another thing is the music feature." |
| 2:20-2:23 | "Music ducks under your voice automatically." |
| 2:30-2:32 | "**Thanks** again for the support." |
| 2:40-2:43 | "One last word on **pricing**." (pricing #3) |
| 2:50-2:53 | "**Uh**, I hope this was helpful." |
| 3:00-3:03 | "Ask me anything in the comments." |
| 3:10-3:13 | "**Thanks**, and see you next time." |
| 3:13-3:30 | Stay still and silent until about 3:30, then stop recording. |

## Checklist after recording
- [ ] "welcome to the channel" appears once; "welcome" nowhere else
- [ ] "pricing" 3 times, all after 0:30 (and "cost" once)
- [ ] "like" only in "I like this tool"
- [ ] "thanks" exactly 4 times
- [ ] a 3 s pause and a ~2 s silence near 0:30
- [ ] 4 um/uh fillers, 1 bleepable word
- [ ] constant 30 fps, file untouched, sha256 recorded in SOURCES.md
