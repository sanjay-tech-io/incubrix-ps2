# M1b review pack (reviewer addendum)

Prepared for an external reviewer. Sections 1-3 and 5-8 are command output captured on 2026-10-20 (colour disabled with NO_COLOR=1, otherwise untouched).

## 0. What was asked, what was done, where the evidence is

| # | Reviewer item | Done | Evidence |
|---|---|---|---|
| 1 | Lockfile on npmmirror | `.npmrc` pins the public registry; lockfile regenerated | section 1: 0 npmmirror URLs, 208 npmjs URLs, `npm ci` exit 0, `npm test` exit 0 |
| 2 | Which machine / Docker | answered in section 2 | Docker is NOT installed here |
| 3 | Frame rounding | source-side boundaries snapped into silence; output frames by cumulative rounding | `test/frame_rounding.test.ts` (odd counts at 2x and 3/2x, seeded property test), section 3 |
| 4 | Performance | memoized replay, binary search, priming | `docs/PERF_ENGINE.md`, section 4 raw bench JSON |
| 5 | Surviving mutants | tests added, `npm run mutation-check` automated | `test/mutants.test.ts`, section 5 raw output |
| 6 | zod contracts | `packages/contracts`, schema generated and compared | `packages/contracts/test/schema.test.ts`, section 6 |
| 7 | Docs | this file and `docs/STATUS.md` | - |

Commits for this addendum: see the git log in section 8 (from `1c7c3cd` "Pin npm registry" to the docs commit).

## 1. Lockfile and registry

```
$ grep -c npmmirror package-lock.json
0
(exit 1)
$ grep -c registry.npmjs.org package-lock.json
208
$ cat .npmrc
registry=https://registry.npmjs.org/
```

`npm ci` output (tail):

```

56 packages are looking for funding
  run `npm fund` for details

6 vulnerabilities (3 moderate, 1 high, 2 critical)

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
(exit 0)
```

## 2. Machine (item 2)

```
$ hostname
LAPTOP-8G9AORL2
$ powershell: OS
Microsoft Windows 10 Home Single Language 10.0.19045 64-bit
$ uname -a
MINGW64_NT-10.0-19045 LAPTOP-8G9AORL2 3.4.7-25de8b84.x86_64 2023-08-28 21:32 UTC x86_64 Msys
$ docker --version
/usr/bin/bash: line 18: docker: command not found
(exit 127)
$ node --version
v22.17.1
$ cpu
Intel(R) Core(TM) i3-1005G1 CPU @ 1.20GHz 4 threads 8 GB RAM
```

## 3. Frame rounding (item 3)

Rule, in short: a boundary between a silence and a word moves into the silence (floor/ceil on the frame grid); a boundary between two touching words stays and is warned about. Output frames per piece = round(cumulative exact frames) - round(previous cumulative). Tests: `packages/engine/test/frame_rounding.test.ts` (names are listed in section 7b). Design text: `docs/DESIGN.md`, decisions: `CLAUDE.md`.

## 4. Performance (item 4)

Summary table and analysis: `docs/PERF_ENGINE.md`. Raw JSON of every bench run follows (synthetic 60-minute source, 24,001 atoms).

### Before (code at commit 7c046d3)

```
{
  "note": "synthetic 60-minute source, 24,000 atoms; times in milliseconds; this machine only",
  "atoms": 24001,
  "one cut, empty session": {
    "medianMs": 1.2,
    "maxMs": 6.5,
    "runs": 20
  },
  "one cut after 1,500 cuts - cold": {
    "medianMs": 246.8,
    "maxMs": 304.1,
    "runs": 10
  },
  "one cut after 1,500 cuts - warm": {
    "medianMs": 139.8,
    "maxMs": 162.2,
    "runs": 10
  },
  "one cut with 4,000 segments - cold": {
    "medianMs": 849.6,
    "maxMs": 927.8,
    "runs": 5
  },
  "one cut with 4,000 segments - warm": {
    "medianMs": 837.8,
    "maxMs": 851.4,
    "runs": 5
  },
  "undo with 4,000 segments - cold": {
    "medianMs": 1089.1,
    "maxMs": 1516.7,
    "runs": 5
  },
  "current timeline with 4,000 segments - cold": {
    "medianMs": 264.3,
    "maxMs": 275.5,
    "runs": 5
  },
  "resolve an edited range with 4,000 segments": {
    "medianMs": 8.6,
    "maxMs": 12,
    "runs": 5
  },
  "add a caption with 4,000 segments - cold": {
    "medianMs": 836.2,
    "maxMs": 904.6,
    "runs": 5
  },
  "add a caption with 4,000 segments - warm": {
    "medianMs": 839.2,
    "maxMs": 860.1,
    "runs": 5
  },
  "one instruction carrying 4,000 cut ops": {
    "medianMs": 1377.6,
    "maxMs": 1461.2,
    "runs": 3
  }
}
```

### After, run 1 (commit 0e4610e)

```
{
  "note": "synthetic 60-minute source, 24,000 atoms; times in milliseconds; this machine only",
  "atoms": 24001,
  "one cut, empty session": {
    "medianMs": 0.1,
    "maxMs": 3.2,
    "runs": 20
  },
  "one cut after 1,500 cuts - cold": {
    "medianMs": 28.1,
    "maxMs": 57.9,
    "runs": 10
  },
  "one cut after 1,500 cuts - warm": {
    "medianMs": 11.6,
    "maxMs": 12.8,
    "runs": 10
  },
  "one cut with 4,000 segments - cold": {
    "medianMs": 73.4,
    "maxMs": 94.8,
    "runs": 5
  },
  "one cut with 4,000 segments - warm": {
    "medianMs": 20,
    "maxMs": 33.5,
    "runs": 5
  },
  "undo with 4,000 segments - cold": {
    "medianMs": 40.9,
    "maxMs": 42.9,
    "runs": 5
  },
  "current timeline with 4,000 segments - cold": {
    "medianMs": 39.6,
    "maxMs": 45,
    "runs": 5
  },
  "resolve an edited range with 4,000 segments": {
    "medianMs": 3.7,
    "maxMs": 12.7,
    "runs": 5
  },
  "add a caption with 4,000 segments - cold": {
    "medianMs": 140,
    "maxMs": 155.9,
    "runs": 5
  },
  "add a caption with 4,000 segments - warm": {
    "medianMs": 25.3,
    "maxMs": 28.3,
    "runs": 5
  },
  "one instruction carrying 4,000 cut ops": {
    "medianMs": 57.8,
    "maxMs": 59.8,
    "runs": 3
  }
}
```

### After, run 2

```
{
  "note": "synthetic 60-minute source, 24,000 atoms; times in milliseconds; this machine only",
  "atoms": 24001,
  "one cut, empty session": {
    "medianMs": 0.1,
    "maxMs": 3.2,
    "runs": 20
  },
  "one cut after 1,500 cuts - cold": {
    "medianMs": 29.2,
    "maxMs": 54.2,
    "runs": 10
  },
  "one cut after 1,500 cuts - warm": {
    "medianMs": 8,
    "maxMs": 11.5,
    "runs": 10
  },
  "one cut with 4,000 segments - cold": {
    "medianMs": 68.3,
    "maxMs": 86.8,
    "runs": 5
  },
  "one cut with 4,000 segments - warm": {
    "medianMs": 19.7,
    "maxMs": 20.2,
    "runs": 5
  },
  "undo with 4,000 segments - cold": {
    "medianMs": 31.3,
    "maxMs": 36,
    "runs": 5
  },
  "current timeline with 4,000 segments - cold": {
    "medianMs": 26.7,
    "maxMs": 27.1,
    "runs": 5
  },
  "resolve an edited range with 4,000 segments": {
    "medianMs": 1.3,
    "maxMs": 1.7,
    "runs": 5
  },
  "add a caption with 4,000 segments - cold": {
    "medianMs": 70.4,
    "maxMs": 79.5,
    "runs": 5
  },
  "add a caption with 4,000 segments - warm": {
    "medianMs": 20.9,
    "maxMs": 25.7,
    "runs": 5
  },
  "one instruction carrying 4,000 cut ops": {
    "medianMs": 57.2,
    "maxMs": 61.6,
    "runs": 3
  }
}
```

### After, run 3 (final verification run)

```
{
  "note": "synthetic 60-minute source, 24,000 atoms; times in milliseconds; this machine only",
  "atoms": 24001,
  "one cut, empty session": {
    "medianMs": 0.3,
    "maxMs": 5.2,
    "runs": 20
  },
  "one cut after 1,500 cuts - cold": {
    "medianMs": 28.9,
    "maxMs": 71.2,
    "runs": 10
  },
  "one cut after 1,500 cuts - warm": {
    "medianMs": 8.6,
    "maxMs": 8.8,
    "runs": 10
  },
  "one cut with 4,000 segments - cold": {
    "medianMs": 70.4,
    "maxMs": 81.8,
    "runs": 5
  },
  "one cut with 4,000 segments - warm": {
    "medianMs": 19.6,
    "maxMs": 20.9,
    "runs": 5
  },
  "undo with 4,000 segments - cold": {
    "medianMs": 31.6,
    "maxMs": 35.5,
    "runs": 5
  },
  "current timeline with 4,000 segments - cold": {
    "medianMs": 25.4,
    "maxMs": 26.3,
    "runs": 5
  },
  "resolve an edited range with 4,000 segments": {
    "medianMs": 1.4,
    "maxMs": 1.6,
    "runs": 5
  },
  "add a caption with 4,000 segments - cold": {
    "medianMs": 70.5,
    "maxMs": 82.8,
    "runs": 5
  },
  "add a caption with 4,000 segments - warm": {
    "medianMs": 20.8,
    "maxMs": 21.1,
    "runs": 5
  },
  "one instruction carrying 4,000 cut ops": {
    "medianMs": 49.8,
    "maxMs": 50.9,
    "runs": 3
  }
}
```

## 5. Mutation check (item 5), raw output of `npm run mutation-check`

The first four mutants are the reviewer's. Before the new tests were added, running the same script with `MUTATION_EXCLUDE=test/mutants.test.ts` left four of nine mutants alive (observed in session, not saved to a file; reproduce with that command).

```
killed    music dropped from the timeline
killed    effect ids count log length instead of edit entries
killed    protected pauses dropped from the timeline
killed    auto-caption style dropped from the timeline
killed    new edit no longer clears redo (incremental engine)
killed    new edit no longer clears redo (log analysis)
killed    speed overlap: left remainder of the earlier region dropped
killed    speed overlap: right remainder of the earlier region dropped
killed    restore ignored
killed    speed limits not enforced
killed    frames rounded per piece instead of cumulatively
killed    floor/ceil snapping swapped (cut would clip words)
killed    cache primed even when the instruction contains a restore
killed    cache primed with the state BEFORE the new group
killed    binary search finds segments by start instead of end

15/15 mutants killed
exit=0
```

## 6. Contracts (item 6)

`packages/contracts/src/index.ts` holds the zod schemas; `packages/engine/src/types.ts` re-exports inferred types; `packages/contracts/schemas/timeline.schema.json` is generated by `npm run generate -w @incubrix/contracts`. The test `packages/contracts/test/schema.test.ts` fails if the committed file differs from the generated one. Its result is part of the `npm test` output below.

## 7. Raw output of `npm test` (root, exit code in the last line)

```

> incubrix@0.0.0 test
> npm test --workspaces --if-present


> @incubrix/contracts@0.0.0 test
> vitest run


 RUN  v2.1.9 D:/VSC/incubrix/incubrix-ps2/packages/contracts

 ✓ test/schema.test.ts (4 tests) 241ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  13:51:19
   Duration  944ms (transform 78ms, setup 0ms, collect 257ms, tests 241ms, environment 0ms, prepare 155ms)


> @incubrix/engine@0.0.0 test
> eslint . && vitest run


 RUN  v2.1.9 D:/VSC/incubrix/incubrix-ps2/packages/engine

 ✓ test/replay.test.ts (24 tests) 30ms
 ✓ test/session.test.ts (30 tests) 65ms
 ✓ test/frame_rounding.test.ts (14 tests) 176ms
 ✓ test/worked_example.test.ts (11 tests | 1 skipped) 46ms
 ✓ test/search_resolve.test.ts (21 tests) 42ms
 ✓ test/atoms.test.ts (21 tests) 31ms
 ✓ test/mutants.test.ts (14 tests) 27ms
 ✓ test/canonical.test.ts (18 tests) 22ms
 ✓ test/schema.test.ts (4 tests) 315ms
 ✓ test/hard_cases.test.ts (6 tests) 2145ms
   ✓ property: incremental application equals a full replay > after every command of a random edit/undo/redo sequence, snapshots agree with replaying the log 334ms
   ✓ property: the session path (caches, incremental priming) equals a fresh full replay > after every turn of a random session (edits, undo, redo, restore, rejected turns), the cached timeline equals a replay on a brand-new engine 1747ms
 ✓ test/lint_guard.test.ts (12 tests) 916ms
   ✓ engine purity lint rules > forbids Date in packages/engine/src 865ms

 Test Files  11 passed (11)
      Tests  174 passed | 1 skipped (175)
   Start at  13:51:24
   Duration  5.39s (transform 648ms, setup 0ms, collect 3.63s, tests 3.81s, environment 4ms, prepare 2.43s)

exit=0
```

`npm run typecheck`:

```

> incubrix@0.0.0 typecheck
> npm run typecheck --workspaces --if-present


> @incubrix/contracts@0.0.0 typecheck
> tsc -p tsconfig.json


> @incubrix/engine@0.0.0 typecheck
> tsc -p tsconfig.json

exit=0
```

### 7b. Every engine test name (`npx vitest run --reporter=verbose` in packages/engine)

```

 RUN  v2.1.9 D:/VSC/incubrix/incubrix-ps2/packages/engine

 ✓ test/replay.test.ts > materialize: the empty log > is one segment covering the whole source; hash matches a hand-written canonical string
 ✓ test/replay.test.ts > cut and time mapping > cutting the first 30 s (a point inside the 29.2-31.0 silence) removes exactly 30 s
 ✓ test/replay.test.ts > cut and time mapping > maps original time to edited time and back; cut time maps to null
 ✓ test/replay.test.ts > cut and time mapping > two cuts leave two segments and shift later time by both
 ✓ test/replay.test.ts > cut and time mapping > cutting the same span twice changes nothing (repeated instruction is safe)
 ✓ test/replay.test.ts > cut and time mapping > keep_only keeps just that span
 ✓ test/replay.test.ts > speed regions > 2x over 18 s of source saves 9 s; later time maps with the speed-up
 ✓ test/replay.test.ts > speed regions > rate is stored in lowest terms so 4/2 and 2/1 hash the same
 ✓ test/replay.test.ts > speed regions > rejects a rate above the maximum, naming the allowed range
 ✓ test/replay.test.ts > speed regions > accepts the limits themselves (4x and 0.25x)
 ✓ test/replay.test.ts > speed regions > overlap: a later 1x in the middle of a 2x leaves 2x on both sides
 ✓ test/replay.test.ts > speed regions > overlap: a later 3x over part of a 2x replaces (not multiplies) on the overlap
 ✓ test/replay.test.ts > speed regions > adjacent regions with the same rate merge into one region
 ✓ test/replay.test.ts > speed regions > speed over a cut area is clipped to what remains, and returns when the cut is restored
 ✓ test/replay.test.ts > effects follow their words > an effect is active and keeps its anchor after a cut before it
 ✓ test/replay.test.ts > effects follow their words > is inactive (kept, not deleted) when all its words are cut
 ✓ test/replay.test.ts > effects follow their words > is partial when only some of its words are cut
 ✓ test/replay.test.ts > effects follow their words > a sped-up caption keeps a 0.7 s minimum visible time and says it was extended
 ✓ test/replay.test.ts > effects follow their words > a caption already longer than 0.7 s is not extended
 ✓ test/replay.test.ts > log replay edge cases > an invalid cursor in a logged op makes replay fail loudly
 ✓ test/replay.test.ts > log replay edge cases > reorder is not implemented in M1 and says so
 ✓ test/replay.test.ts > log replay edge cases > undo then redo of the same group gives the same timeline hash
 ✓ test/replay.test.ts > log replay edge cases > buildPieces splits a segment at speed boundaries
 ✓ test/replay.test.ts > auto-caption text is derived from the words that survive > shows a sentence as one cue at its edited time, and drops cut words from the text
 ✓ test/session.test.ts > answer contract > an applied answer has every field of the contract
 ✓ test/session.test.ts > answer contract > states the time policy that was used
 ✓ test/session.test.ts > answer contract > extra warnings from resolving the instruction are passed through
 ✓ test/session.test.ts > undo groups > one instruction with several operations is ONE undo step
 ✓ test/session.test.ts > undo groups > undo then redo returns the same timeline hash
 ✓ test/session.test.ts > undo groups > a new edit clears redo
 ✓ test/session.test.ts > undo groups > undo with nothing to undo is rejected, not an error
 ✓ test/session.test.ts > undo groups > undo only reverses the latest group
 ✓ test/session.test.ts > restore a specific earlier edit while later ones stay > restores edit 1 and keeps edit 2; undoing the restore cuts edit 1 again
 ✓ test/session.test.ts > restore a specific earlier edit while later ones stay > the log is append-only: restoring never removes the original entries
 ✓ test/session.test.ts > restore a specific earlier edit while later ones stay > restoring a restore brings the original edit back
 ✓ test/session.test.ts > restore a specific earlier edit while later ones stay > rejects restoring an edit that never existed
 ✓ test/session.test.ts > restore a specific earlier edit while later ones stay > rejects restoring an edit that was already restored, or one that was undone
 ✓ test/session.test.ts > rejections are normal answers > speed outside the allowed range: rejected with the reason and the range; nothing logged
 ✓ test/session.test.ts > rejections are normal answers > an edit that would remove the whole video is rejected
 ✓ test/session.test.ts > rejections are normal answers > an invalid cursor is rejected, not thrown
 ✓ test/session.test.ts > rejections are normal answers > updating a caption that does not exist is rejected
 ✓ test/session.test.ts > rejections are normal answers > submitRejection records a rejection decided by the caller without touching the log
 ✓ test/session.test.ts > rejections are normal answers > repeating an instruction is safe and says nothing changed
 ✓ test/session.test.ts > clarification > asking changes neither the log nor the timeline hash, and is not an undo group
 ✓ test/session.test.ts > clarification > the answer applies exactly the chosen option's operations and its warnings
 ✓ test/session.test.ts > clarification > an out-of-range choice asks again and keeps the question open
 ✓ test/session.test.ts > clarification > answering when no question is open is rejected
 ✓ test/session.test.ts > determinism and independence from the conversation > the same log replayed 3 times gives the same hash
 ✓ test/session.test.ts > determinism and independence from the conversation > the hash does not depend on what the user typed or on clarification turns
 ✓ test/session.test.ts > warnings about effects and uncertain words > cutting all of a caption's words makes it inactive, says so, and restoring brings it back
 ✓ test/session.test.ts > warnings about effects and uncertain words > a partial cut keeps the literal text and names the cut words
 ✓ test/session.test.ts > warnings about effects and uncertain words > reports how far a caption moved
 ✓ test/session.test.ts > warnings about effects and uncertain words > warns when a speed-up shortens a caption below 0.7 s and extends it
 ✓ test/session.test.ts > warnings about effects and uncertain words > warns when an edit touches low-confidence, overlapping or speaker-uncertain words
 ✓ test/frame_rounding.test.ts > floor/ceil to the frame grid (30000/1001) > floor is the last frame start <= t, ceil the first >= t, both equal t when t is on the grid
 ✓ test/frame_rounding.test.ts > source-side boundaries land on the frame grid, inside a silence, never inside a word > the NTSC fixture really is off-grid at word boundaries (so these tests mean something)
 ✓ test/frame_rounding.test.ts > source-side boundaries land on the frame grid, inside a silence, never inside a word > silence -> word boundary moves EARLIER into the silence (floor); the word is untouched
 ✓ test/frame_rounding.test.ts > source-side boundaries land on the frame grid, inside a silence, never inside a word > word -> silence boundary moves LATER into the silence (ceil)
 ✓ test/frame_rounding.test.ts > source-side boundaries land on the frame grid, inside a silence, never inside a word > two touching words cannot be snapped: the boundary stays (the caller warns)
 ✓ test/frame_rounding.test.ts > source-side boundaries land on the frame grid, inside a silence, never inside a word > an unsnapped word-boundary cursor is rejected when it could have been snapped
 ✓ test/frame_rounding.test.ts > source-side boundaries land on the frame grid, inside a silence, never inside a word > 30 fps fixture: boundaries already on the grid are untouched
 ✓ test/frame_rounding.test.ts > source-side boundaries land on the frame grid, inside a silence, never inside a word > 'remove the part about pricing' on NTSC: both ends on the grid, whole sentence removed, neighbour words untouched
 ✓ test/frame_rounding.test.ts > output frames by cumulative rounding > 2x over two odd-length regions (31 frames each): 16, 29, 15 — total is round(exact)
 ✓ test/frame_rounding.test.ts > output frames by cumulative rounding > 3/2x (1.5x) over two odd-length regions: 21, 29, 20 — exact 20.667 + 29 + 20.667 = 70.333 -> 70
 ✓ test/frame_rounding.test.ts > output frames by cumulative rounding > a single half-frame piece rounds half up (1 frame at 2x = 0.5 -> 1)
 ✓ test/frame_rounding.test.ts > property: sum of piece frames equals round(total), pieces within 1 frame, cuts on the grid > holds for 150 seeded random cut-and-speed sequences on a 29.97 fps source
 ✓ test/frame_rounding.test.ts > a rate that does not divide the frame count still gives whole frames (no fps: microseconds) > audio-only sources round cumulatively in microseconds
 ✓ test/frame_rounding.test.ts > the cut rule warns when a boundary cannot be put on the frame grid > between two touching words on a 29.97 fps source: a warning; on-grid and silence boundaries: none
 ✓ test/worked_example.test.ts > worked example (steps 1-7) > step 1: caption 'Welcome!' on 'welcome to the channel', original 0:42-0:44
 ✓ test/worked_example.test.ts > worked example (steps 1-7) > step 2: cut the first 30 s -> caption now 0:12-0:14 on the same words; length drops by exactly 30 s
 ✓ test/worked_example.test.ts > worked example (steps 1-7) > step 3a: 'remove the part about pricing' -> needs_clarification listing the 3 mentions; nothing changes
 ✓ test/worked_example.test.ts > worked example (steps 1-7) > step 3b: 'the second one' -> applied; exactly the second mention (5.0 s) is removed
 ✓ test/worked_example.test.ts > worked example (steps 1-7) > step 4: speed up 1:00-1:30 by 2x (current-time policy); the range straddles the removed gap
 ✓ test/worked_example.test.ts > worked example (steps 1-7) > step 5: 'put the intro back' -> first 30 s return, caption back at 0:42; pricing cut and speed change stay
 ✓ test/worked_example.test.ts > worked example (steps 1-7) > step 6: undo reverses step 5 only
 ✓ test/worked_example.test.ts > worked example (steps 1-7) > step 7: 'make that caption red' applies to the only caption
 ✓ test/worked_example.test.ts > worked example (steps 1-7) > 'that caption' is ambiguous with two captions and impossible with none (never guessed)
 ✓ test/worked_example.test.ts > worked example (steps 1-7) > the whole example replays to the same hash on 3 fresh engines
 ✓ test/search_resolve.test.ts > fixture sanity (so later numbers can be trusted) > has the planned content: welcome once, pricing 3x after 0:30, thanks 4x, one non-filler like, 4 fillers
 ✓ test/search_resolve.test.ts > phraseRanges > returns the atom range of 'welcome to the channel' at 42.0-44.0
 ✓ test/search_resolve.test.ts > phraseRanges > ignores case and punctuation
 ✓ test/search_resolve.test.ts > phraseRanges > finds nothing for a phrase that is not there
 ✓ test/search_resolve.test.ts > findTopicParts: 'the part about pricing' > finds 3 parts in original time; each is a sentence plus the silence after it
 ✓ test/search_resolve.test.ts > findTopicParts: 'the part about pricing' > reports edited-time starts after the first 30 s are cut
 ✓ test/search_resolve.test.ts > findTopicParts: 'the part about pricing' > a part that is already cut is not offered again
 ✓ test/search_resolve.test.ts > findTopicParts: 'the part about pricing' > 'cost' finds the pricing parts (small built-in synonym group; real meaning search is M4)
 ✓ test/search_resolve.test.ts > findTopicParts: 'the part about pricing' > an unknown topic finds nothing
 ✓ test/search_resolve.test.ts > snapPoint: the cut rule > inside a silence: exact (on the frame grid)
 ✓ test/search_resolve.test.ts > snapPoint: the cut rule > on an atom boundary: unchanged, no warning
 ✓ test/search_resolve.test.ts > snapPoint: the cut rule > inside a word: snaps to the edge that touches a silence, and warns
 ✓ test/search_resolve.test.ts > snapPoint: the cut rule > inside a word with no silence on either side: nearest edge, and says there was no silence nearby
 ✓ test/search_resolve.test.ts > resolveEditedRange (current-time policy) > edited 0:60-0:90 straddling a removed gap becomes two source spans
 ✓ test/search_resolve.test.ts > resolveEditedRange (current-time policy) > an edited range inside one stretch is one span
 ✓ test/search_resolve.test.ts > resolveEditedRange (current-time policy) > accounts for speed regions when mapping edited time back to source
 ✓ test/search_resolve.test.ts > resolveEditedRange (current-time policy) > a boundary that lands inside a word is snapped and warned
 ✓ test/search_resolve.test.ts > resolveEditedRange (current-time policy) > rejects ranges outside the timeline, naming the length
 ✓ test/search_resolve.test.ts > formatTime > writes m:ss.mmm
 ✓ test/search_resolve.test.ts > resolveOriginalRange (time policy 'original') > refers to the untouched source even after the first 30 s were cut
 ✓ test/search_resolve.test.ts > resolveOriginalRange (time policy 'original') > rejects times beyond the original video
 ✓ test/atoms.test.ts > buildAtoms > fills gaps with silence atoms so atoms tile the whole duration
 ✓ test/atoms.test.ts > buildAtoms > flags um/uh as filler by default but not ordinary words
 ✓ test/atoms.test.ts > buildAtoms > respects an explicit filler flag (a filler 'like' vs a normal 'like')
 ✓ test/atoms.test.ts > buildAtoms > marks low confidence below the threshold
 ✓ test/atoms.test.ts > buildAtoms > derives ids from content: same input gives same ids, different source hash gives different ids
 ✓ test/atoms.test.ts > buildAtoms > rejects overlapping or out-of-range words
 ✓ test/atoms.test.ts > indexAtoms > rejects atoms that do not tile the duration
 ✓ test/atoms.test.ts > indexAtoms > finds the atom at a time (boundaries belong to the atom that starts there)
 ✓ test/atoms.test.ts > frame grid with rational fps > 30000/1001: frame starts are rounded to the nearest microsecond
 ✓ test/atoms.test.ts > frame grid with rational fps > snaps to the nearest frame start
 ✓ test/atoms.test.ts > frame grid with rational fps > 30 fps: 30.0 s is on the grid, 30.01 s snaps to 30.0 s
 ✓ test/atoms.test.ts > cursor validation > accepts offset 0 at any atom (a boundary)
 ✓ test/atoms.test.ts > cursor validation > accepts an on-grid offset inside a silence atom
 ✓ test/atoms.test.ts > cursor validation > rejects an unknown atom
 ✓ test/atoms.test.ts > cursor validation > rejects negative, fractional and too-large offsets
 ✓ test/atoms.test.ts > cursor validation > rejects a non-zero offset inside a word
 ✓ test/atoms.test.ts > cursor validation > rejects an offset inside a silence that is off the frame grid
 ✓ test/atoms.test.ts > cursor validation > does not check the grid for audio-only sources (fps null)
 ✓ test/atoms.test.ts > cursor validation > allows the end-of-source cursor only on the last atom, only as an end cursor
 ✓ test/atoms.test.ts > cursor validation > usToCursor is canonical: a boundary is the NEXT atom at offset 0; the end is last atom at its length
 ✓ test/atoms.test.ts > cursor validation > a span needs start < end
 ✓ test/mutants.test.ts > music is part of the timeline and of the hash > set_music appears in the timeline
 ✓ test/mutants.test.ts > music is part of the timeline and of the hash > adding music changes the hash; each music parameter changes it; clearing music restores the original hash
 ✓ test/mutants.test.ts > music is part of the timeline and of the hash > the latest set_music wins
 ✓ test/mutants.test.ts > effect ids count edit entries only, never undo/redo markers > fx ids use the number of edit entries so far
 ✓ test/mutants.test.ts > effect ids count edit entries only, never undo/redo markers > undo and redo markers do not advance the count
 ✓ test/mutants.test.ts > effect ids count edit entries only, never undo/redo markers > an instruction with several ops counts every op entry
 ✓ test/mutants.test.ts > protected pauses are part of the timeline and of the hash > protect_pause is stored in the timeline
 ✓ test/mutants.test.ts > protected pauses are part of the timeline and of the hash > protecting a pause changes the hash; protecting a different pause changes it again; unprotecting restores it
 ✓ test/mutants.test.ts > protected pauses are part of the timeline and of the hash > the order the pauses were protected in does not change the hash (stored in source order)
 ✓ test/mutants.test.ts > protected pauses are part of the timeline and of the hash > protecting the same pause twice is the same as once
 ✓ test/mutants.test.ts > protected pauses are part of the timeline and of the hash > only silence can be protected
 ✓ test/mutants.test.ts > the auto-caption style is part of the timeline and of the hash > auto_caption stores its style in the timeline
 ✓ test/mutants.test.ts > the auto-caption style is part of the timeline and of the hash > turning auto-caption on changes the hash; a different style changes it again
 ✓ test/mutants.test.ts > the auto-caption style is part of the timeline and of the hash > the latest style wins
 ✓ test/canonical.test.ts > canonicalJson > sorts object keys at every depth and writes no whitespace
 ✓ test/canonical.test.ts > canonicalJson > is independent of key insertion order
 ✓ test/canonical.test.ts > canonicalJson > keeps array order
 ✓ test/canonical.test.ts > canonicalJson > escapes strings like JSON
 ✓ test/canonical.test.ts > canonicalJson > throws on a float
 ✓ test/canonical.test.ts > canonicalJson > throws on NaN
 ✓ test/canonical.test.ts > canonicalJson > throws on Infinity
 ✓ test/canonical.test.ts > canonicalJson > throws on undefined
 ✓ test/canonical.test.ts > canonicalJson > throws on undefined in array
 ✓ test/canonical.test.ts > canonicalJson > throws on a function
 ✓ test/canonical.test.ts > canonicalJson > throws on a bigint
 ✓ test/canonical.test.ts > canonicalJson > throws on an unsafe integer
 ✓ test/canonical.test.ts > sha256Hex (pure JS) agrees with node:crypto, used here only as an independent oracle > input of length 0
 ✓ test/canonical.test.ts > sha256Hex (pure JS) agrees with node:crypto, used here only as an independent oracle > input of length 1
 ✓ test/canonical.test.ts > sha256Hex (pure JS) agrees with node:crypto, used here only as an independent oracle > input of length 2
 ✓ test/canonical.test.ts > sha256Hex (pure JS) agrees with node:crypto, used here only as an independent oracle > input of length 3
 ✓ test/canonical.test.ts > sha256Hex (pure JS) agrees with node:crypto, used here only as an independent oracle > input of length 4
 ✓ test/canonical.test.ts > sha256Hex (pure JS) agrees with node:crypto, used here only as an independent oracle > matches the published SHA-256 test vector for 'abc'
 ✓ test/schema.test.ts > timeline.schema.json > compiles under strict mode and accepts a sample session document
 ✓ test/schema.test.ts > timeline.schema.json > rejects float times (time must be integer microseconds)
 ✓ test/schema.test.ts > timeline.schema.json > rejects an unknown operation type
 ✓ test/schema.test.ts > the schema accepts what the engine really produces > a real session (caption, cut, question, answer, speed, restore, undo, recolour) validates, and so does its materialized timeline
 ✓ test/hard_cases.test.ts > hard case: caption added, its sentence cut, the cut restored > the caption goes inactive (but stays in the log), the user is told, and restoring brings it back in place
 ✓ test/hard_cases.test.ts > hard case: caption added, its sentence cut, the cut restored > the same works through undo instead of restore
 ✓ test/hard_cases.test.ts > hard case: cut before, speed over and restore all leave the caption on its words > a cut before it and a 2x speed change just before it move it to the right edited time
 ✓ test/hard_cases.test.ts > property: incremental application equals a full replay > after every command of a random edit/undo/redo sequence, snapshots agree with replaying the log
 ✓ test/hard_cases.test.ts > property: how a cut is split does not matter > cutting [a,c) equals cutting [a,b) then [b,c): same timeline
 ✓ test/hard_cases.test.ts > property: the session path (caches, incremental priming) equals a fresh full replay > after every turn of a random session (edits, undo, redo, restore, rejected turns), the cached timeline equals a replay on a brand-new engine 1581ms
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids Date in packages/engine/src 870ms
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids new Date in packages/engine/src
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids Math.random in packages/engine/src
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids process in packages/engine/src
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids fetch in packages/engine/src
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids node:fs import in packages/engine/src
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids fs import in packages/engine/src
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids http import in packages/engine/src
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids node:crypto import in packages/engine/src
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids crypto global in packages/engine/src
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids setTimeout in packages/engine/src
 ✓ test/lint_guard.test.ts > engine purity lint rules > allows pure code

 Test Files  11 passed (11)
      Tests  174 passed | 1 skipped (175)
   Start at  13:51:39
   Duration  5.61s (transform 676ms, setup 0ms, collect 3.82s, tests 3.69s, environment 5ms, prepare 2.35s)
```

## 8. `git log --oneline` (before the docs commit that adds this file) and source line counts

```
30cae3e Warn when a cut boundary between two touching words cannot be put on the frame grid
3563304 Document engine performance (before/after from real runs) and update design decisions
0e4610e Make instructions fast: binary-search segments, memoize replay, prime from the previous state
7c046d3 Frame-accurate cuts and output: snap boundaries into silence, round frames cumulatively
1a84a51 Kill the four surviving mutants and add an automated mutation check
1418eea Add packages/contracts: zod schemas are the source of truth, JSON Schema is generated
1c7c3cd Pin npm registry to registry.npmjs.org and regenerate the lockfile
2fd5250 Add STATUS.md project memory and REVIEW_M1.md review pack for end of M1
a2d4bd6 Validate real session documents and materialized timelines against the JSON Schema
08ac832 Add design doc, test-video recording script, lint guard test; record M1 decisions and drop the React UI in CLAUDE.md
c67ed14 Test original time policy and auto-caption cues derived from surviving words
3d5d217 Add hard-case tests and property tests for incremental vs full replay
0ffe48d Add worked example steps 1-7 as tests, effect lookup and incremental timeline
e778890 Add session layer: three-way answers, undo/redo/restore, clarification, search and time resolution
ba65225 Add replay, operation log analysis and time mapping with fixture transcript
0314456 Add atom builder, cursor validation and exact frame-grid snapping
49e28dc Add strict canonical JSON and pure-JS sha256 timeline hash
ca16bc7 Record M1 decisions in CLAUDE.md
7fc7a2f Add engine data model types and timeline JSON Schema
3207dac Set up npm workspaces, strict TypeScript, vitest and engine purity lint rules
72c6c69 docs
```

`wc -l` of packages/engine/src and packages/contracts/src:

```
  119 packages/engine/src/atoms.ts
   34 packages/engine/src/canonical.ts
   19 packages/engine/src/context.ts
  111 packages/engine/src/cursor.ts
   30 packages/engine/src/errors.ts
   45 packages/engine/src/frames.ts
   23 packages/engine/src/hash.ts
   56 packages/engine/src/incremental.ts
   15 packages/engine/src/index.ts
  108 packages/engine/src/log.ts
  331 packages/engine/src/replay.ts
  154 packages/engine/src/resolve.ts
  124 packages/engine/src/search.ts
  273 packages/engine/src/session.ts
  275 packages/engine/src/timemap.ts
   60 packages/engine/src/types.ts
  243 packages/contracts/src/index.ts
 2020 total
```

## 9. Doubts

1. **Docker is not on this machine.** `docker --version` fails here, so nothing Docker-related (compose, the single `docker compose run tests` command, MinIO, Postgres) has been run by me. M2 must be developed or at least verified on the GCP VM. Until then every compose/e2e claim is unverified.
2. **Touching words still cannot be grid-snapped.** A cut between two words with no silence between them stays off the frame grid (a word would be clipped otherwise). The engine accepts it. `snapPoint` (used when resolving typed times) now warns about it, but spans built by `findTopicParts` do not pass that warning on, and the rendered result at such a cut is untested until M3. Output frame counts treat such a time as an exact fraction of a frame, so the arithmetic is still exact.
3. **"On the grid" is defined by the microsecond-rounded frame start.** A time t counts as frame k if it equals frameStart(k) rounded to a microsecond. With fractional fps that is the convention the renderer must also use (round to nearest microsecond), or boundaries will disagree by 1 microsecond. Unverified against ffmpeg.
4. **Performance numbers are one laptop, synthetic data.** i3-1005G1, 8 GB, 60-minute generated transcript with perfectly regular words. A real 60-minute video has uneven gaps, thousands of effects and the API/database in the path. `findTopicParts` still scans every sentence linearly and was not measured.
5. **Caches rely on immutability by convention.** Logs and timelines are plain arrays/objects; nothing freezes them. A caller that mutates one in place would get stale answers. The property test covers the engine's own use only.
6. **Binary search assumes output order equals source order.** Reorder (M4) will invalidate `removeFromSorted`, `replaceSpeed`, `sourceToEdited` and friends; it is flagged in comments, PERF_ENGINE.md and CLAUDE.md, but only a future test will catch it if forgotten (`move` currently throws NOT_IMPLEMENTED, which protects us until then).
7. **`IncrementalTimeline` is unused in production code.** It remains as a test oracle. I did not wire it in because the simpler memo-plus-priming design met the targets; the reviewer allowed that.
8. **Mutation testing is hand-rolled** (15 hand-picked mutants). It proves those mutants die, not that no others survive; a real mutation tool (e.g. Stryker) would find more.
9. **zod JSON Schema output carries large `maximum: 9007199254740991` bounds** on every integer (zod's safe-integer bounds). Harmless but noisy; consumers generating code from the schema will see them.
10. **`npm audit` reports 6 vulnerabilities** (3 moderate, 1 high, 2 critical) in the dev dependency tree after the fresh install. I have not investigated or changed anything; they are not in code that ships (all dev tooling as far as I can tell, but I did not verify which packages).
11. **Earlier doubts still open** (REVIEW_M1.md): synthetic fixture, shallow topic search, reorder and filler/silence removal missing, no real video, no renderer.

## 10. Claims ledger

The full ledger (rows 1-36) is in `docs/STATUS.md`. Rows added or changed by this addendum:

| # | Claim | Evidence | Verified |
|---|---|---|---|
| 29 | `registry=https://registry.npmjs.org/` is pinned and the lockfile has no mirror URLs | `.npmrc`; `grep -c npmmirror package-lock.json` = 0; `npm ci` then `npm test` exit 0 (REVIEW_M1B section 1) | yes |
| 30 | Source-side cut boundaries are on the frame grid (silence-to-word boundaries move into the silence, never into a word) | `frame_rounding.test.ts`; mutant "floor/ceil swapped" killed | yes, except boundaries between two touching words (cannot be snapped; warned in `snapPoint`) |
| 31 | Output frames: sum of piece frames = round(total); each piece within 1 frame | `frame_rounding.test.ts` (odd counts at 2x and 3/2x; seeded property, 150 runs, independent BigInt arithmetic); mutant "per-piece rounding" killed | yes (engine arithmetic only; **not** against a rendered video) |
| 32 | Any instruction < 300 ms; 4,000-op instruction < 1 s (synthetic 60 min, 24,001 atoms) | `docs/PERF_ENGINE.md`, `npm run bench -w @incubrix/engine`; worst single observed 155.9 ms; 4,000-op ~50-58 ms | yes on this laptop, synthetic data |
| 33 | Cached session path equals a replay on a brand-new engine | `hard_cases.test.ts` property (100 seeded sessions incl. restore and rejected turns); 3 cache mutants killed | yes |
| 34 | Music, protected pauses, auto-caption style are in the timeline and hash; effect ids count edit entries only | `mutants.test.ts`; 4 original surviving mutants killed (without these tests 4 of 9 survived) | yes |
| 35 | zod contracts are the source of truth; committed JSON Schema equals the generated one | `packages/contracts/test/schema.test.ts` | yes |
| 36 | Docker works on the dev machine / compose runs | `docker --version`: command not found on this machine | **no** |
