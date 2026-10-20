# M1 review pack

Engine milestone M1, prepared for an external reviewer. Nothing here is paraphrased from memory: sections 1-3 are command output captured on 2026-10-20 (colour codes disabled with NO_COLOR=1, otherwise untouched).

## 1. Raw output of `npm test` (exit code 0)

```

> incubrix@0.0.0 test
> npm test --workspaces --if-present


> @incubrix/engine@0.0.0 test
> eslint . && vitest run


 RUN  v2.1.9 D:/VSC/incubrix/incubrix-ps2/packages/engine

 ✓ test/replay.test.ts (24 tests) 35ms
 ✓ test/worked_example.test.ts (11 tests | 1 skipped) 47ms
 ✓ test/session.test.ts (30 tests) 65ms
 ✓ test/atoms.test.ts (21 tests) 35ms
 ✓ test/search_resolve.test.ts (21 tests) 58ms
 ✓ test/canonical.test.ts (18 tests) 23ms
 ✓ test/hard_cases.test.ts (5 tests) 290ms
 ✓ test/schema.test.ts (4 tests) 239ms
 ✓ test/lint_guard.test.ts (12 tests) 903ms
   ✓ engine purity lint rules > forbids Date in packages/engine/src 847ms

 Test Files  9 passed (9)
      Tests  145 passed | 1 skipped (146)
   Start at  12:53:19
   Duration  4.00s (transform 713ms, setup 0ms, collect 2.94s, tests 1.70s, environment 3ms, prepare 1.79s)

```

### 1b. Every test name (`npx vitest run --reporter=verbose` in packages/engine; the skipped test is the render step, which needs M3)

```

 RUN  v2.1.9 D:/VSC/incubrix/incubrix-ps2/packages/engine

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
 ✓ test/hard_cases.test.ts > hard case: caption added, its sentence cut, the cut restored > the caption goes inactive (but stays in the log), the user is told, and restoring brings it back in place
 ✓ test/hard_cases.test.ts > hard case: caption added, its sentence cut, the cut restored > the same works through undo instead of restore
 ✓ test/hard_cases.test.ts > hard case: cut before, speed over and restore all leave the caption on its words > a cut before it and a 2x speed change just before it move it to the right edited time
 ✓ test/hard_cases.test.ts > property: incremental application equals a full replay > after every command of a random edit/undo/redo sequence, snapshots agree with replaying the log
 ✓ test/hard_cases.test.ts > property: how a cut is split does not matter > cutting [a,c) equals cutting [a,b) then [b,c): same timeline
 ✓ test/schema.test.ts > timeline.schema.json > compiles under strict mode and accepts a sample session document
 ✓ test/schema.test.ts > timeline.schema.json > rejects float times (time must be integer microseconds)
 ✓ test/schema.test.ts > timeline.schema.json > rejects an unknown operation type
 ✓ test/schema.test.ts > the schema accepts what the engine really produces > a real session (caption, cut, question, answer, speed, restore, undo, recolour) validates, and so does its materialized timeline 329ms
 ✓ test/lint_guard.test.ts > engine purity lint rules > forbids Date in packages/engine/src 980ms
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

 Test Files  9 passed (9)
      Tests  145 passed | 1 skipped (146)
   Start at  12:53:26
   Duration  4.39s (transform 704ms, setup 0ms, collect 3.04s, tests 1.90s, environment 3ms, prepare 1.79s)

```

## 2. `git log --oneline` (before the commit that adds this file)

```
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

## 3. Files in packages/engine/src (line counts, `wc -l`)

```
  119 packages/engine/src/atoms.ts
   34 packages/engine/src/canonical.ts
   19 packages/engine/src/context.ts
   72 packages/engine/src/cursor.ts
   30 packages/engine/src/errors.ts
   28 packages/engine/src/frames.ts
   16 packages/engine/src/hash.ts
   56 packages/engine/src/incremental.ts
   15 packages/engine/src/index.ts
   97 packages/engine/src/log.ts
  257 packages/engine/src/replay.ts
  139 packages/engine/src/resolve.ts
  121 packages/engine/src/search.ts
  267 packages/engine/src/session.ts
  175 packages/engine/src/timemap.ts
  319 packages/engine/src/types.ts
 1764 total
```

## 4. Doubts

1. **Frame snapping is partial.** Only cursors with a non-zero offset (inside silences) are forced onto the frame grid. A cut at a word boundary uses the word's ASR time, which is not frame-aligned, so the engine's integer-microsecond timeline can differ from the rendered video by up to half a frame at each cut. The requirement is sync within 1 frame, and that is untested until M3. If M3 shows drift, the fix is to snap boundaries too, at the cost of moving cuts up to half a frame into a neighbouring silence.
2. **"Put the intro back" needs a mapping I did not build.** `restore` targets a group number. Working out that "the intro" means group 2 is parsing/history lookup (M2/M4). The engine only guarantees that restoring group N is correct.
3. **Topic search is shallow.** "The part about pricing" is the sentence with the word (plus the silence after it). A real "part" may be several sentences, and sentence boundaries depend on the ASR giving punctuation or pauses of 1 s or more. The synonym list is one hand-written group ("pricing/cost/fee..."), a stand-in for the Advanced-level meaning search.
4. **The fixture is idealised.** Sentences are separated by long, clean silences and words are evenly timed. Real speech has shorter gaps, words that touch, and filler words glued to neighbours. Passing here says the logic is right on clean data, not that it works on a real recording.
5. **A cut inside a word with no silence beside it** moves to the nearest word edge, which can still clip a syllable, and only warns. The brief wants no clipped words (Outstanding); this is a known gap until the M5 snapping work.
6. **Effect ids in the hash.** Two histories that produce the same visible video can hash differently (e.g. an extra caption added then removed). I accepted this as approved; hidden "same session gives same hash" tests are unaffected, but anyone comparing two different sessions' hashes should know.
7. **Full replay on every instruction.** `submitOperations` validates by replaying the whole log and `effectDisplay` rebuilds pieces on each call. Fine for 130 atoms; the 60-minute / under-3-second target is untested and may need the `IncrementalTimeline` (which exists, is property-tested, but is not wired into the session layer, and does not support restore).
8. **Mute/bleep/music are data only.** The engine records and keeps them anchored; nothing produces audio. Bleeping "blindly" is not prevented yet beyond the warning on flagged words.
9. **Windows line endings.** Git reports LF to CRLF conversions on every file. It does not affect the timeline hash (the hash is over the timeline, not files) but a `.gitattributes` would stop noisy diffs. I did not add one without asking.
10. **Mutation check was manual.** I proved the property test can fail by temporarily breaking the incremental engine once; that is not part of the suite.
11. **Reorder is missing** although it is a must-have operation; it is deliberately outside M1 and throws `NOT_IMPLEMENTED`.
12. **`docs/REQUIREMENTS.md` item "caption added, its sentence cut, cut restored"** is covered; "section reordered then a word muted" and "filler removal cutting into a bleeped word" are not (need reorder / filler removal).

## 5. Claims ledger

| # | Claim | Evidence | Verified |
|---|---|---|---|
| 1 | The engine cannot read clock, randomness, fs, network, env | `packages/engine/test/lint_guard.test.ts` (11 forbidden constructs fail lint, pure code passes), run by `npm test` | yes (rules cover `src/`; imports of third-party packages are not audited) |
| 2 | Same log replayed on 3 fresh engines gives the same timeline_hash | `session.test.ts` "replayed 3 times"; `worked_example.test.ts` last test | yes (engine only) |
| 3 | Hash ignores what the user typed and clarification turns | `session.test.ts` "does not depend on what the user typed" | yes |
| 4 | SHA-256 implementation is correct | `canonical.test.ts` vs `node:crypto` (oracle, tests only) and the published "abc" vector | yes |
| 5 | Canonical JSON rejects floats, NaN, undefined, functions, bigint | `canonical.test.ts` | yes |
| 6 | Hash of the untouched timeline equals a hand-written canonical string | `replay.test.ts` first test | yes |
| 7 | Source file is never modified / its sha256 is stored | Only the `Source.sha256` field exists; no file ingestion yet | **no** (M2) |
| 8 | Captions/effects stay on their words after cut, speed change, restore | `worked_example.test.ts`, `hard_cases.test.ts`, `replay.test.ts` | yes; after reorder: **no** (not implemented) |
| 9 | Worked example steps 1-7 reproduce exactly | `worked_example.test.ts` (hand-computed numbers, synthetic fixture) | yes on the fixture; **not** on a real video |
| 10 | Worked example step 8 (render in sync) | skipped test "needs M3" | **no** |
| 11 | Every instruction gets exactly one of applied / needs_clarification / rejected | `session.test.ts` | yes at engine level; over HTTP **no** (M2) |
| 12 | One instruction = one undo; new edit clears redo; restore a specific older edit while later ones stay | `session.test.ts`, `worked_example.test.ts` steps 5-6 | yes |
| 13 | Speed outside 0.25x-4x is rejected with the reason and the range | `session.test.ts`, `replay.test.ts` | yes (the `MAX_SPEED` env wiring is **not** built, M2) |
| 14 | Overlapping speed changes follow the documented rule | `replay.test.ts` (3 cases), `docs/DESIGN.md` | yes |
| 15 | Invalid cursors are rejected | `atoms.test.ts` (unknown atom, negative, fractional, too large, inside word, off-grid, end-cursor misuse) | yes |
| 16 | Caption whose words are all cut becomes inactive (never deleted) and returns on restore; partial cut keeps text and names cut words | `hard_cases.test.ts`, `session.test.ts` | yes |
| 17 | Captions keep a 0.7 s minimum after speed-up and the answer warns | `replay.test.ts`, `session.test.ts` | yes |
| 18 | Cut rule: exact inside silence, snap + warn inside a word | `search_resolve.test.ts` | yes (resolution helpers) |
| 19 | Operations touching flagged words warn | `session.test.ts` (speaker uncertain, low confidence) | yes (overlapping-speech flag follows the same code path but has no dedicated test) |
| 20 | Incremental application equals full replay | `hard_cases.test.ts` property test (150 random sequences, fixed seed). A one-off manual mutation (removing redo-clearing) made it fail; mutation check is not automated | yes |
| 21 | JSON Schema matches what the engine produces | `schema.test.ts` validates one real session document and its timeline | yes for that session; not exhaustive |
| 22 | Auto-caption text comes from surviving words | `replay.test.ts` | yes (cue grouping is simple; rendering **no**) |
| 23 | Time policy "original" vs "current" | `search_resolve.test.ts`, answers carry `timePolicy` | yes (policy detection from text is parser work, not built) |
| 24 | Render accuracy, A/V sync, length within 1 frame | none | **no** (M3) |
| 25 | Reorder, filler removal, silence removal, music ducking, mute/bleep audio | not implemented (`move` throws NOT_IMPLEMENTED) | **no** |
| 26 | Instruction latency, 60-minute scale | not measured | **no** |
| 27 | Real ASR, diarization, API, jobs, idempotency, compose, OTIO | not built | **no** |
| 28 | Any metric (latency, cost, clipping, clarification quality) | none produced; nothing is under `test-pack/` | **no** |
