# M1c review pack

Prepared for an external reviewer. Everything in sections 1-8 is command output captured on 2026-10-20 (colour disabled with NO_COLOR=1, otherwise untouched).

## 0. What was asked, what was done

| # | Request | Done | Evidence |
|---|---|---|---|
| 0 | Investigate the 6 npm audit findings; fix only safe upgrades | all 6 are in the dev-only vitest 2.x tree; production tree has 0; the only fix is a major vitest upgrade, so nothing was changed | section 3 |
| 1 | All remaining must-have operations | reorder, mute, bleep, auto-caption (+clear), caption edits, fillers (deterministic "like" rule), silences > N with pad, pinned pauses, music track + ducking envelope, keep-only tests | `new_ops.test.ts`, `reorder.test.ts` |
| 2 | Reorder redesign of time mapping and (a)-(d) rules | two piece indexes; rules documented in docs/DESIGN.md "Reorder" | `reorder.test.ts` (a)-(d) |
| 3 | Hard cases | reordered section then a muted word; filler vs bleep; caption/sentence cut/restore (also after a reorder); "undo the second-to-last cut but keep the music"; caption on moved words follows | `new_ops.test.ts` "hard cases", `reorder.test.ts` |
| 4 | Suite green, mutation check extended and green, bench re-run | 249 tests; 40 mutants; bench | sections 2, 4, 5 |
| 5 | Docs | STATUS.md, PERF_ENGINE.md, DESIGN.md, CLAUDE.md, this file | - |
| F1 | Grid warnings on every span path, in the answer | `gridWarning(s)`, `addGridWarnings`, `submitPlan` | `grid_warnings.test.ts` |
| F2 | Deep-freeze helper; property tests on frozen inputs | `test/freeze.ts` | section 5 (frozen-only mutant killed) |
| F3 | Grid convention in DESIGN.md; ledger row for ffmpeg | done; row 51 "NOT VERIFIED until M3" | DESIGN.md, STATUS.md |
| F4 | Measure findTopicParts (40 captions, 4,000 segments) | 3.5 ms median | section 4 |

## 2. Raw output of `npm test` (root)

```

> incubrix@0.0.0 test
> npm test --workspaces --if-present


> @incubrix/contracts@0.0.0 test
> vitest run


 RUN  v2.1.9 D:/VSC/incubrix/incubrix-ps2/packages/contracts

 ✓ test/schema.test.ts (4 tests) 332ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  14:34:58
   Duration  1.04s (transform 70ms, setup 0ms, collect 255ms, tests 332ms, environment 0ms, prepare 109ms)


> @incubrix/engine@0.0.0 test
> eslint . && vitest run


 RUN  v2.1.9 D:/VSC/incubrix/incubrix-ps2/packages/engine

 ✓ test/session.test.ts (30 tests) 88ms
 ✓ test/new_ops.test.ts (39 tests) 129ms
 ✓ test/reorder.test.ts (26 tests) 266ms
 ✓ test/replay.test.ts (23 tests) 42ms
 ✓ test/worked_example.test.ts (11 tests | 1 skipped) 87ms
 ✓ test/frame_rounding.test.ts (14 tests) 238ms
 ✓ test/atoms.test.ts (21 tests) 31ms
 ✓ test/search_resolve.test.ts (21 tests) 37ms
 ✓ test/grid_warnings.test.ts (11 tests) 49ms
 ✓ test/mutants.test.ts (14 tests) 28ms
 ✓ test/hard_cases.test.ts (6 tests) 2735ms
   ✓ property: incremental application equals a full replay > after every command of a random edit/undo/redo sequence, snapshots agree with replaying the log 456ms
   ✓ property: the session path (caches, incremental priming) equals a fresh full replay > after every turn of a random session (edits, undo, redo, restore, rejected turns), the cached timeline equals a replay on a brand-new engine 2181ms
 ✓ test/canonical.test.ts (18 tests) 24ms
 ✓ test/schema.test.ts (4 tests) 385ms
   ✓ the schema accepts what the engine really produces > a real session (caption, cut, question, answer, speed, restore, undo, recolour) validates, and so does its materialized timeline 343ms
 ✓ test/lint_guard.test.ts (12 tests) 1069ms
   ✓ engine purity lint rules > forbids Date in packages/engine/src 1003ms

 Test Files  14 passed (14)
      Tests  249 passed | 1 skipped (250)
   Start at  14:35:03
   Duration  8.20s (transform 1.58s, setup 0ms, collect 6.61s, tests 5.21s, environment 6ms, prepare 3.59s)

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

### 2b. Every engine test name (`npx vitest run --reporter=verbose` in packages/engine)

```

 RUN  v2.1.9 D:/VSC/incubrix/incubrix-ps2/packages/engine

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
 ✓ test/new_ops.test.ts > filler "like": a deterministic documented rule > "I like this tool" is NOT a filler
 ✓ test/new_ops.test.ts > filler "like": a deterministic documented rule > R1/R2: commas around it make it a filler
 ✓ test/new_ops.test.ts > filler "like": a deterministic documented rule > R3: isolated by pauses of 0.3 s on both sides
 ✓ test/new_ops.test.ts > filler "like": a deterministic documented rule > R4: right after um/uh
 ✓ test/new_ops.test.ts > filler "like": a deterministic documented rule > an explicit flag always wins over the rule
 ✓ test/new_ops.test.ts > filler "like": a deterministic documented rule > isFillerLike is false for any other word
 ✓ test/new_ops.test.ts > remove fillers > removes um/uh (4 in the fixture) and keeps the non-filler 'like' in 'I like this tool'
 ✓ test/new_ops.test.ts > remove fillers > repeating it is safe: nothing left to remove
 ✓ test/new_ops.test.ts > remove fillers > a short silence right after the filler goes with it; a long one, or a pinned one, stays
 ✓ test/new_ops.test.ts > remove fillers > hard case: a filler that is bleeped is KEPT, with a warning (documented rule)
 ✓ test/new_ops.test.ts > remove fillers > hard case: a bleep range that merely contains a filler also keeps it; fillers outside the range are removed
 ✓ test/new_ops.test.ts > remove silences longer than N > N = 1 s: every pause longer than that is cut down to a 0.15 s pad on each speech side (26 in the fixture)
 ✓ test/new_ops.test.ts > remove silences longer than N > exact numbers: the 1.8 s pause 29.2-31.0 keeps 0.15 s each side rounded INTO the cut on the 30 fps grid; the lead-in and the tail keep pad only next to speech
 ✓ test/new_ops.test.ts > remove silences longer than N > 'longer than' is strict: silences of exactly 2.8 s stay at N = 2.8 s, 16 longer ones go
 ✓ test/new_ops.test.ts > remove silences longer than N > applied, no surviving pause is longer than two pads plus a frame, and speech is untouched
 ✓ test/new_ops.test.ts > remove silences longer than N > a pinned pause survives, and the answer counts it
 ✓ test/new_ops.test.ts > remove silences longer than N > the pad is a setting: a bigger pad leaves more silence
 ✓ test/new_ops.test.ts > remove silences longer than N > rejects a non-positive N, and pinning a moment inside speech
 ✓ test/new_ops.test.ts > mute and bleep > a bleep touching a low-confidence word warns instead of bleeping blindly
 ✓ test/new_ops.test.ts > mute and bleep > so does a mute, and a bleep on confident words does not warn
 ✓ test/new_ops.test.ts > mute and bleep > the effect id counts edit entries, and the effect stays on its word after a cut before it
 ✓ test/new_ops.test.ts > caption edits: text, colour, size, position > each edit changes only its field and keeps the anchor
 ✓ test/new_ops.test.ts > caption edits: text, colour, size, position > a bad colour or size is refused; a non-caption cannot be edited
 ✓ test/new_ops.test.ts > caption edits: text, colour, size, position > 'make it bigger' with no caption: the lookup says none (the caller rejects instead of guessing)
 ✓ test/new_ops.test.ts > background music: speech segments and the ducking envelope > speech segments are the words of the final output, touching words merged
 ✓ test/new_ops.test.ts > background music: speech segments and the ducking envelope > envelope: fully ducked when speech starts, back to base releaseUs after it ends (exact keyframes)
 ✓ test/new_ops.test.ts > background music: speech segments and the ducking envelope > speech from time 0 starts ducked; speech to the very end stays ducked; no speech is a flat line
 ✓ test/new_ops.test.ts > background music: speech segments and the ducking envelope > speech closer than attack + release is one ducked stretch (the music cannot recover in between)
 ✓ test/new_ops.test.ts > background music: speech segments and the ducking envelope > follows the final timeline: a cut shifts the keyframes, a speed-up shortens the ducked stretches
 ✓ test/new_ops.test.ts > background music: speech segments and the ducking envelope > keyframe times strictly increase and stay inside the video
 ✓ test/new_ops.test.ts > hard cases > "undo the second-to-last cut but keep the music": the music op stays, the later cut stays, only that cut returns
 ✓ test/new_ops.test.ts > hard cases > a section reordered, then a word inside it muted: the mute sits on the word at its NEW place
 ✓ test/new_ops.test.ts > hard cases > caption added, sentence reordered, sentence cut, cut restored: the caption returns at the moved place
 ✓ test/new_ops.test.ts > keep only a range > keeps just the span (edited-time resolved), keeps captions on kept words, drops the rest
 ✓ test/new_ops.test.ts > keep only a range > keep_only after a cut keeps only what survives inside the span
 ✓ test/new_ops.test.ts > keep only a range > keeping a range that is entirely cut would leave nothing and is rejected
 ✓ test/new_ops.test.ts > keep only a range > sanity: RED and WHITE helpers differ (keeps the import honest)
 ✓ test/new_ops.test.ts > submitPlan > passes planner warnings into the answer
 ✓ test/new_ops.test.ts > submitPlan > an empty plan is a normal rejection, not an empty edit; repeating a removal ends up here
 ✓ test/reorder.test.ts > reorder: move a section before a point, or to the end > moves 90-92 to just before 98: output order [0,90) [92,98) [90,92) [98,200); length unchanged
 ✓ test/reorder.test.ts > reorder: move a section before a point, or to the end > time mapping follows: original 90 plays at 96, original 92 plays at 90, and back
 ✓ test/reorder.test.ts > reorder: move a section before a point, or to the end > before = null moves the section to the end
 ✓ test/reorder.test.ts > reorder: move a section before a point, or to the end > moving a section back where it came from gives the identical timeline hash (segments are canonical)
 ✓ test/reorder.test.ts > reorder: move a section before a point, or to the end > moving a section before its own end changes nothing, and the answer says so
 ✓ test/reorder.test.ts > reorder: move a section before a point, or to the end > a target inside the section itself is rejected
 ✓ test/reorder.test.ts > reorder: move a section before a point, or to the end > moving a section that is not in the video is rejected
 ✓ test/reorder.test.ts > reorder: move a section before a point, or to the end > (c) target inside CUT material: the section goes before the next surviving material in source order
 ✓ test/reorder.test.ts > reorder: move a section before a point, or to the end > (c) a cut that spans material that has been moved removes it wherever it now is, same result as cutting first
 ✓ test/reorder.test.ts > reorder: move a section before a point, or to the end > (c) a cut strictly inside moved material leaves both remainders, in place (the unordered-list cut path)
 ✓ test/reorder.test.ts > reorder: move a section before a point, or to the end > (c) a move whose span covers already-moved material moves it as one block, keeping its current order
 ✓ test/reorder.test.ts > (a) speed regions stay attached to their source atoms > 2x on 90-92 still applies to that material after it is moved; the region itself does not change
 ✓ test/reorder.test.ts > (a) speed regions stay attached to their source atoms > speed applied AFTER the move still lands on the right material
 ✓ test/reorder.test.ts > (b) effects after a reorder > a caption on moved words keeps following them (shown at the new place, summary says how far it moved)
 ✓ test/reorder.test.ts > (b) effects after a reorder > moving the WHOLE range elsewhere keeps one run (the pause inside the range moves along)
 ✓ test/reorder.test.ts > (b) effects after a reorder > moving only PART of a range splits it: a caption shows on the run holding its first surviving word, and the answer warns
 ✓ test/reorder.test.ts > (b) effects after a reorder > a mute on the same range applies to every run, and the answer says it plays in several places
 ✓ test/reorder.test.ts > (b) effects after a reorder > auto-caption text follows the new order: swap two sentences and their cues swap (output order, not source order)
 ✓ test/reorder.test.ts > (d) undo and restore after a reorder > undo returns the exact earlier timeline; redo brings the reorder back
 ✓ test/reorder.test.ts > (d) undo and restore after a reorder > restoring the reorder while a later cut stays gives the timeline of that cut alone
 ✓ test/reorder.test.ts > (d) undo and restore after a reorder > restoring the cut while the reorder stays gives the reorder alone
 ✓ test/reorder.test.ts > (d) undo and restore after a reorder > an edit after the reorder defined by source position survives restoring the reorder (a cut inside the moved section)
 ✓ test/reorder.test.ts > planMoveEdited: the move as the user states it (edited time) > 'move 1:30-1:32 to before 1:38' (edited == original here) matches the hand-built operation
 ✓ test/reorder.test.ts > planMoveEdited: the move as the user states it (edited time) > to the end, and a range straddling removed material becomes two moves in order
 ✓ test/reorder.test.ts > planMoveEdited: the move as the user states it (edited time) > rejects a target inside the range or beyond the end
 ✓ test/reorder.test.ts > property: any sequence of moves keeps all material, in disjoint pieces, with consistent time mapping > 100 seeded random move sequences (inputs deep-frozen)
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
 ✓ test/replay.test.ts > log replay edge cases > undo then redo of the same group gives the same timeline hash
 ✓ test/replay.test.ts > log replay edge cases > buildPieces splits a segment at speed boundaries
 ✓ test/replay.test.ts > auto-caption text is derived from the words that survive > shows a sentence as one cue at its edited time, and drops cut words from the text
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
 ✓ test/grid_warnings.test.ts > grid warnings on every path that builds spans (touching words, 29.97 fps) > control: the boundary really is off the grid, and snapPoint warns about it
 ✓ test/grid_warnings.test.ts > grid warnings on every path that builds spans (touching words, 29.97 fps) > "remove the part about pricing": findTopicParts carries the warning, and the answer includes it (single match path)
 ✓ test/grid_warnings.test.ts > grid warnings on every path that builds spans (touching words, 29.97 fps) > clarification path: the warning rides along with the chosen option into the answer
 ✓ test/grid_warnings.test.ts > grid warnings on every path that builds spans (touching words, 29.97 fps) > a part bounded by silences has no grid warning (control on the normal fixture, 29.97 fps)
 ✓ test/grid_warnings.test.ts > grid warnings on every path that builds spans (touching words, 29.97 fps) > resolveEditedRange and resolveOriginalRange warn for a start on the touching boundary
 ✓ test/grid_warnings.test.ts > grid warnings on every path that builds spans (touching words, 29.97 fps) > resolveEditedRange also warns when the range STARTS exactly at a segment edge that sits on a touching-words boundary
 ✓ test/grid_warnings.test.ts > grid warnings on every path that builds spans (touching words, 29.97 fps) > they do not warn when both ends are fine (silence on the grid)
 ✓ test/grid_warnings.test.ts > grid warnings on every path that builds spans (touching words, 29.97 fps) > filler removal warns for a filler between two words (both of its boundaries)
 ✓ test/grid_warnings.test.ts > grid warnings on every path that builds spans (touching words, 29.97 fps) > the answer to a filler-removal instruction includes them
 ✓ test/grid_warnings.test.ts > grid warnings on every path that builds spans (touching words, 29.97 fps) > reorder warns when the moved section starts on the touching boundary
 ✓ test/grid_warnings.test.ts > grid warnings on every path that builds spans (touching words, 29.97 fps) > silence removal never produces a grid warning (its cuts are always inside a silence)
 ✓ test/hard_cases.test.ts > hard case: caption added, its sentence cut, the cut restored > the caption goes inactive (but stays in the log), the user is told, and restoring brings it back in place
 ✓ test/hard_cases.test.ts > hard case: caption added, its sentence cut, the cut restored > the same works through undo instead of restore
 ✓ test/hard_cases.test.ts > hard case: cut before, speed over and restore all leave the caption on its words > a cut before it and a 2x speed change just before it move it to the right edited time
 ✓ test/hard_cases.test.ts > property: incremental application equals a full replay > after every command of a random edit/undo/redo sequence, snapshots agree with replaying the log 362ms
 ✓ test/hard_cases.test.ts > property: how a cut is split does not matter > cutting [a,c) equals cutting [a,b) then [b,c): same timeline
 ✓ test/hard_cases.test.ts > property: the session path (caches, incremental priming) equals a fresh full replay > after every turn of a random session (edits, undo, redo, restore, rejected turns), the cached timeline equals a replay on a brand-new engine 1772ms
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
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids Date in packages/engine/src 1040ms
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

 Test Files  14 passed (14)
      Tests  249 passed | 1 skipped (250)
   Start at  14:35:23
   Duration  7.56s (transform 1.70s, setup 0ms, collect 6.30s, tests 4.51s, environment 6ms, prepare 3.58s)
```

## 3. `npm audit` (item 0), raw

All six findings are reachable only through `vitest` 2.1.9 (a devDependency of the packages, used for tests). `npm audit --omit=dev` reports 0. `npm audit fix` (without --force) changes nothing; the suggested fix is `vitest@5.0.5`, a major upgrade, not applied.

```
$ npm audit
# npm audit report

@vitest/mocker  <=4.1.10
Severity: moderate
Vitest: Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock - https://github.com/advisories/GHSA-82fw-gwwq-j7x9
Depends on vulnerable versions of vite
fix available via `npm audit fix --force`
Will install vitest@5.0.5, which is a breaking change
node_modules/@vitest/mocker
  vitest  <=4.1.10
  Depends on vulnerable versions of @vitest/mocker
  Depends on vulnerable versions of tinypool
  Depends on vulnerable versions of vite
  Depends on vulnerable versions of vite-node
  node_modules/vitest

esbuild  <=0.24.2
Severity: moderate
esbuild enables any website to send any requests to the development server and read the response - https://github.com/advisories/GHSA-67mh-4wv8-2f99
fix available via `npm audit fix --force`
Will install vitest@5.0.5, which is a breaking change
node_modules/esbuild
  vite  <=6.4.2
  Depends on vulnerable versions of esbuild
  node_modules/vite
    vite-node  <=2.2.0-beta.2
    Depends on vulnerable versions of vite
    node_modules/vite-node

tinypool  <=2.1.1
Severity: critical
Tinypool: Prototype Pollution gadget in worker options leads to Remote Code Execution - https://github.com/advisories/GHSA-5gmw-xhrv-c9v3
Tinypool: Prototype Pollution Gadget to RCE in run() options - https://github.com/advisories/GHSA-85c8-ppgw-ccpr
fix available via `npm audit fix --force`
Will install vitest@5.0.5, which is a breaking change
node_modules/tinypool



6 vulnerabilities (3 moderate, 1 high, 2 critical)

To address all issues (including breaking changes), run:
  npm audit fix --force
(exit 1)

$ npm audit --omit=dev
found 0 vulnerabilities
(exit 0)

$ npm audit fix --dry-run
node_modules/tinypool



6 vulnerabilities (3 moderate, 1 high, 2 critical)

To address all issues (including breaking changes), run:
  npm audit fix --force

$ npm ls vitest tinypool vite vite-node esbuild @vitest/mocker --all (dependency paths)
incubrix@0.0.0 D:\VSC\incubrix\incubrix-ps2
+-- @incubrix/contracts@0.0.0 -> .\packages\contracts
| `-- vitest@2.1.9
|   +-- @vitest/mocker@2.1.9
|   | `-- vite@5.4.21 deduped
|   +-- tinypool@1.1.1
|   +-- vite-node@2.1.9
|   | `-- vite@5.4.21 deduped
|   `-- vite@5.4.21
|     `-- esbuild@0.21.5
`-- @incubrix/engine@0.0.0 -> .\packages\engine
  `-- vitest@2.1.9 deduped
```

## 4. Benchmark (synthetic 60-minute source, 24,001 atoms), raw JSON of the final run

Summary table and analysis: `docs/PERF_ENGINE.md`.

```
{
  "note": "synthetic 60-minute source, 24,000 atoms; times in milliseconds; this machine only",
  "atoms": 24001,
  "one cut, empty session": {
    "medianMs": 0.2,
    "maxMs": 3.2,
    "runs": 20
  },
  "one cut after 1,500 cuts - cold": {
    "medianMs": 24.9,
    "maxMs": 51.6,
    "runs": 10
  },
  "one cut after 1,500 cuts - warm": {
    "medianMs": 7.4,
    "maxMs": 11.5,
    "runs": 10
  },
  "one cut with 4,000 segments - cold": {
    "medianMs": 69.1,
    "maxMs": 82.8,
    "runs": 5
  },
  "one cut with 4,000 segments - warm": {
    "medianMs": 19.1,
    "maxMs": 19.8,
    "runs": 5
  },
  "undo with 4,000 segments - cold": {
    "medianMs": 30.4,
    "maxMs": 33.9,
    "runs": 5
  },
  "current timeline with 4,000 segments - cold": {
    "medianMs": 25.8,
    "maxMs": 29.1,
    "runs": 5
  },
  "resolve an edited range with 4,000 segments": {
    "medianMs": 1.5,
    "maxMs": 1.9,
    "runs": 5
  },
  "add a caption with 4,000 segments - cold": {
    "medianMs": 66.4,
    "maxMs": 90.2,
    "runs": 5
  },
  "add a caption with 4,000 segments - warm": {
    "medianMs": 19.9,
    "maxMs": 21,
    "runs": 5
  },
  "one instruction carrying 4,000 cut ops": {
    "medianMs": 49.6,
    "maxMs": 53.7,
    "runs": 3
  },
  "reorder: move 40 atoms to the end with 4,000 segments - cold": {
    "medianMs": 77.3,
    "maxMs": 97.1,
    "runs": 5
  },
  "reorder: move 40 atoms to the end with 4,000 segments - warm": {
    "medianMs": 20.6,
    "maxMs": 23.4,
    "runs": 5
  },
  "plan: remove fillers (240 'um' in 12,000 words)": {
    "medianMs": 3.1,
    "maxMs": 3.6,
    "runs": 5
  },
  "apply: remove fillers as one instruction - cold": {
    "medianMs": 2.9,
    "maxMs": 4.3,
    "runs": 3
  },
  "plan: remove silences > 50 ms (pad 20 ms) = about 12,000 cuts": {
    "medianMs": 16.7,
    "maxMs": 24.5,
    "runs": 3
  },
  "counts: filler cuts / silence cuts planned": [
    240,
    12001
  ],
  "apply: remove silences as ONE instruction of about 12,000 ops": {
    "medianMs": 319.3,
    "maxMs": 326.5,
    "runs": 3
  },
  "plan: move edited 10 minutes to the end (4,000 segments)": {
    "medianMs": 3.9,
    "maxMs": 4.9,
    "runs": 5
  },
  "ducking envelope, 4,000 segments": {
    "medianMs": 2.5,
    "maxMs": 8.5,
    "runs": 5
  },
  "auto-caption cues, 4,000 segments": {
    "medianMs": 7.1,
    "maxMs": 12.3,
    "runs": 5
  },
  "40 captions + 4,000 segments: effect displays (all 40)": {
    "medianMs": 0.1,
    "maxMs": 0.3,
    "runs": 5
  },
  "findTopicParts('pricing'), 40 captions + 4,000 segments": {
    "medianMs": 3.5,
    "maxMs": 6.1,
    "runs": 5
  },
  "findTopicParts: matches found": 40,
  "a caption instruction on top of 40 captions + 4,000 segments - cold": {
    "medianMs": 65.3,
    "maxMs": 78.2,
    "runs": 5
  }
}
```

## 5. Mutation check, raw output of `npm run mutation-check`

### 5a. First run (before the last three tests were added): 3 of 40 survived

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
killed    reorder: moved block inserted AFTER the target
killed    reorder: moved material also left in place (duplicated)
killed    reorder: 'to the end' goes to the start
killed    reorder: moving a section into itself allowed
killed    reorder: merge of source-contiguous neighbours removed (move and its inverse differ)
SURVIVED  reorder: cut after a move loses the right remainder
killed    reorder: source index never built (binary search over unsorted pieces)
killed    reorder: speed regions looked up from the wrong index
killed    reorder: an effect split by a move is still treated as one run
SURVIVED  reorder: auto-caption cues in source order instead of output order
killed    fillers: the filler flag is ignored
killed    fillers: a bleeped filler is removed anyway
killed    fillers: 'like' rule R1 (own comma) removed
killed    fillers: 'like' rule R4 (after um/uh) removed
killed    silences: pinned pauses are cut anyway
killed    silences: no pad kept next to speech
killed    silences: 'longer than N' becomes 'at least N'
killed    music: ducked level at speech start replaced by the base level
killed    music: release uses the attack time
killed    music: close speech is not merged (music would jump up between)
killed    warnings: bleep/mute no longer warns about low-confidence words
killed    warnings: topic search drops the grid warnings
killed    warnings: filler removal drops the grid warnings
SURVIVED  warnings: edited/original range resolution drops the grid warnings
killed    immutability: a cut edits the previous state's list in place

37/40 mutants killed
exit=1
```

The survivors and their fixes: (1) "cut after a move loses the right remainder": no test cut strictly inside moved material, fixed by a test of exactly that; (2) "auto-caption cues in source order": my test moved a sentence to a place that kept the relative order, so it could not tell, fixed by swapping two sentences; (3) "range resolution drops the grid warnings": the existing test was satisfied by snapPoint's own warning, fixed by a test whose start sits exactly on a segment edge at a touching-words boundary.

### 5b. Second run: 1 of 40 survived (range-resolution grid warning; my first fix test was still satisfied by another warning)

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
killed    reorder: moved block inserted AFTER the target
killed    reorder: moved material also left in place (duplicated)
killed    reorder: 'to the end' goes to the start
killed    reorder: moving a section into itself allowed
killed    reorder: merge of source-contiguous neighbours removed (move and its inverse differ)
killed    reorder: cut after a move loses the right remainder
killed    reorder: source index never built (binary search over unsorted pieces)
killed    reorder: speed regions looked up from the wrong index
killed    reorder: an effect split by a move is still treated as one run
killed    reorder: auto-caption cues in source order instead of output order
killed    fillers: the filler flag is ignored
killed    fillers: a bleeped filler is removed anyway
killed    fillers: 'like' rule R1 (own comma) removed
killed    fillers: 'like' rule R4 (after um/uh) removed
killed    silences: pinned pauses are cut anyway
killed    silences: no pad kept next to speech
killed    silences: 'longer than N' becomes 'at least N'
killed    music: ducked level at speech start replaced by the base level
killed    music: release uses the attack time
killed    music: close speech is not merged (music would jump up between)
killed    warnings: bleep/mute no longer warns about low-confidence words
killed    warnings: topic search drops the grid warnings
killed    warnings: filler removal drops the grid warnings
SURVIVED  warnings: edited/original range resolution drops the grid warnings
killed    immutability: a cut edits the previous state's list in place

39/40 mutants killed
exit=1
```

### 5c. Final run (after the last fix)

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
killed    reorder: moved block inserted AFTER the target
killed    reorder: moved material also left in place (duplicated)
killed    reorder: 'to the end' goes to the start
killed    reorder: moving a section into itself allowed
killed    reorder: merge of source-contiguous neighbours removed (move and its inverse differ)
killed    reorder: cut after a move loses the right remainder
killed    reorder: source index never built (binary search over unsorted pieces)
killed    reorder: speed regions looked up from the wrong index
killed    reorder: an effect split by a move is still treated as one run
killed    reorder: auto-caption cues in source order instead of output order
killed    fillers: the filler flag is ignored
killed    fillers: a bleeped filler is removed anyway
killed    fillers: 'like' rule R1 (own comma) removed
killed    fillers: 'like' rule R4 (after um/uh) removed
killed    silences: pinned pauses are cut anyway
killed    silences: no pad kept next to speech
killed    silences: 'longer than N' becomes 'at least N'
killed    music: ducked level at speech start replaced by the base level
killed    music: release uses the attack time
killed    music: close speech is not merged (music would jump up between)
killed    warnings: bleep/mute no longer warns about low-confidence words
killed    warnings: topic search drops the grid warnings
killed    warnings: filler removal drops the grid warnings
killed    warnings: edited/original range resolution drops the grid warnings
killed    immutability: a cut edits the previous state's list in place

40/40 mutants killed
exit=0
```

## 6. `git log --oneline` (before the docs commit that adds this file)

```
134dbe2 Fix the last surviving mutant: grid warning at a segment edge needs a range whose other end is clean; ONLY filter for the mutation check
b0f8580 Kill three surviving mutants (cut inside moved material, swapped-sentence cues, edge-of-segment grid warning); update design and decisions
50eb5ac Add submitPlan, new-operation benchmarks and 25 mutants for the new operations
f0c496b Grid warnings on every span path; freeze inputs in property tests; moves in the property tests
7e224d1 Implement reorder, fillers, silence removal, ducking envelope, caption edits and planners
2e0bad8 STATUS: reconcile the scale row with the measured synthetic result
97d8a51 Add REVIEW_M1B.md with raw outputs and update STATUS.md for M1b
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
   154 packages/engine/src/atoms.ts
    34 packages/engine/src/canonical.ts
    19 packages/engine/src/context.ts
   111 packages/engine/src/cursor.ts
    30 packages/engine/src/errors.ts
    45 packages/engine/src/frames.ts
    23 packages/engine/src/hash.ts
    56 packages/engine/src/incremental.ts
    17 packages/engine/src/index.ts
   108 packages/engine/src/log.ts
    77 packages/engine/src/music.ts
   254 packages/engine/src/plan.ts
   424 packages/engine/src/replay.ts
   181 packages/engine/src/resolve.ts
   127 packages/engine/src/search.ts
   309 packages/engine/src/session.ts
   405 packages/engine/src/timemap.ts
    60 packages/engine/src/types.ts
   248 packages/contracts/src/index.ts
  2682 total
```

## 7. What is still NOT implemented or NOT verified (plain statement)

- **Instruction parsing.** Nothing turns "remove the fillers" or "move this to the end" into operations yet; tests call the planners and build operations directly. The rule-based parser and the LLM fallback do not exist.
- **Rendering and audio.** No video or audio is produced. Bleeps, mutes, music and ducking exist only as timeline data and a gain envelope. A/V sync, length within one frame, and agreement of the frame grid with ffmpeg are **not verified** (M3).
- **Transcription and diarization.** The engine has never seen a real transcript. All tests run on a synthetic transcript with clean, regular timing. The "like" rule and the 0.3 s / 0.5 s thresholds are heuristics that have **not** been measured on real speech.
- **Multi-speaker.** Speaker labels are stored and warnings exist for uncertain speakers, but "remove everything the guest says about X" and speaker-swap handling are not implemented.
- **Meaning-based search.** One tiny synonym group (pricing/cost/fee); a "part about X" is one sentence plus the pause after it.
- **API, jobs, idempotency, manifest, Docker/compose, storage, OpenAPI, session runner CLI, OTIO export, deployment.** None exist. Docker is not installed on this machine.
- **Scale.** Performance was measured only on one laptop with a synthetic source, not on a real 60-minute video or through an API/database. A single instruction with about 12001 operations takes longer than 300 ms (table in section 4).
- **Known engine limits:** boundaries between two touching words cannot be put on the frame grid (warned); the 12 doubts in REVIEW_M1B.md and REVIEW_M1.md that concern the fixture, topic search and caches still apply; caches rely on logs/timelines never being mutated (the frozen-input property tests check this for the engine's own code, nothing prevents a caller from mutating).
- **Minimum caption time (0.7 s)** is applied to captions and text overlays, not to auto-caption cues.
- **Dependencies:** 6 dev-only npm audit findings remain (section 3).
