# Engine performance (M1b)

All numbers below come from real runs of `npm run bench -w @incubrix/engine` (`packages/engine/bench/perf.ts`) on the machine described here. The source is **synthetic**: a generated 60-minute transcript with 24,001 atoms (12,000 words of 0.2 s separated by 0.1 s silences, 30 fps). No real video, no transcription, no render is involved. Nothing here says anything about other machines.

- Machine: LAPTOP-8G9AORL2, Windows 10 Home 10.0.19045, Intel Core i3-1005G1 @ 1.20 GHz (4 threads), 8 GB RAM, Node v22.17.1.
- "ms" = median of N runs (N in the table), max in brackets where useful.
- **cold** = the engine has never seen this log object (as after loading a session from the database): nothing cached, the whole log is replayed. **warm** = the next instruction of a running session (the previous answer's timeline is remembered). Cold is the honest worst case.
- Targets from the reviewer: any instruction < 300 ms; one instruction carrying 4,000 cut ops < 1 s.

## Reviewer's reported measurements (not mine, quoted for reference)
One cut ~2 ms at session start; 142 ms after 1,500 cuts; ~0.8-1.1 s with 4,000 segments; a 4,000-op instruction ~2 s.

## Before (commit `7c046d3`, bench run on the code before this change)

| Scenario | median ms | runs |
|---|---|---|
| one cut, empty session | 1.2 | 20 |
| one cut after 1,500 cuts - cold | 246.8 | 10 |
| one cut after 1,500 cuts - warm | 139.8 | 10 |
| one cut with 4,000 segments - cold | 849.6 | 5 |
| one cut with 4,000 segments - warm | 837.8 | 5 |
| undo with 4,000 segments - cold | 1089.1 | 5 |
| current timeline with 4,000 segments - cold | 264.3 | 5 |
| resolve an edited range, 4,000 segments | 8.6 | 5 |
| add a caption, 4,000 segments - cold | 836.2 | 5 |
| add a caption, 4,000 segments - warm | 839.2 | 5 |
| one instruction carrying 4,000 cut ops | 1377.6 | 3 |

(Before-code has no cache, so "warm" equals "cold" up to noise; the 1,500-cut pair differs because the first scenarios run on a cold JIT. These reproduce the reviewer's finding.)

## After (commit `0e4610e`), two separate runs

| Scenario | run 1 median ms | run 2 median ms | runs |
|---|---|---|---|
| one cut, empty session | 0.1 | 0.1 | 20 |
| one cut after 1,500 cuts - cold | 28.1 | 29.2 | 10 |
| one cut after 1,500 cuts - warm | 11.6 | 8.0 | 10 |
| one cut with 4,000 segments - cold | 73.4 | 68.3 | 5 |
| one cut with 4,000 segments - warm | 20.0 | 19.7 | 5 |
| undo with 4,000 segments - cold | 40.9 | 31.3 | 5 |
| current timeline with 4,000 segments - cold | 39.6 | 26.7 | 5 |
| resolve an edited range, 4,000 segments | 3.7 | 1.3 | 5 |
| add a caption, 4,000 segments - cold | 140.0 | 70.4 | 5 |
| add a caption, 4,000 segments - warm | 25.3 | 20.9 | 5 |
| one instruction carrying 4,000 cut ops | 57.8 | 57.2 | 3 |

Worst observed single run in either run of the "after" table: 155.9 ms (add a caption, cold). Both targets are met on this machine: every instruction < 300 ms, the 4,000-op instruction ~58 ms.
Raw JSON of every run is in `docs/REVIEW_M1B.md`.

## What was slow, and what changed
| Cause (reviewer's list) | Fix |
|---|---|
| Full log replay several times per instruction (before, validate, after, answer) | Logs/timelines are immutable, so analysis, raw state, timeline, pieces and hash are memoized per object. An instruction now validates once and primes the cache with "previous state + this group" (not when it contains a restore). |
| Per-op linear segment scans, O(n) per op and O(n^2) per batch | Segment and speed lists are sorted and disjoint: binary search to the first overlap, one array splice per op. Speed clipping is a two-pointer pass. |
| Pieces rebuilt for every effect | Built once per timeline (finalize hands them to a cache). |
| Linear atom-to-output lookups | Binary search over pieces; `atomsOverlapping` binary-searches the atom list instead of scanning all 24,000. |
| Hash computed three times per answer | Memoized per timeline object. |
| Per-cursor re-validation when turning intervals back into cursors | Internal unchecked conversion (inputs were already validated). |

## Not done, on purpose
- `IncrementalTimeline` (snapshots per group) is **not** wired into the session layer. The memo-plus-priming design met the targets without it, and it has no restore support. It stays as an independent oracle in the property test.
- Undo/redo/restore still replay the active groups from scratch (cold undo with 4,000 segments: ~31-41 ms). That is within target, so no snapshot stack was added.

## Correctness guards for the optimisation
- Property test (100 seeded random sessions of edits, undo, redo, restore and rejected turns): after every turn the session's cached timeline equals a full replay on a brand-new engine (`test/hard_cases.test.ts`).
- Mutation check (`npm run mutation-check`): breaking the cache priming (wrong state, or priming despite a restore) or the binary search makes the suite fail (15 of 15 mutants killed at the time of writing).

## Caveats
- Binary search relies on output order equal to source order. **Reorder (`move`, M4) will break it and must come with a separate source index.**
- Caches are keyed by object identity and assume logs are never mutated in place (the API returns new arrays). A caller that mutates a log array after using it would get stale results.
- Memory: caches are WeakMaps, so they are released with the log.
- Not measured: effects count in the thousands, 60-minute `findTopicParts` (still scans all sentences linearly), and any path through the future API/database.

## M1c: the new operations (reorder, fillers, silences, music, topic search)
Same machine, same synthetic 60-minute source (the generator now also puts a sentence end every 12th word, "pricing" every 300th word and an "um" every 50th word, which does not change the earlier scenarios). Raw JSON: docs/REVIEW_M1C.md section 4. Planned operations: 240 filler cuts, 12001 silence cuts. `findTopicParts("pricing")` found 40 matches.

| Scenario | median ms | max ms | runs |
|---|---|---|---|
| one cut, empty session | 0.2 | 3.2 | 20 |
| one cut after 1,500 cuts - cold | 24.9 | 51.6 | 10 |
| one cut after 1,500 cuts - warm | 7.4 | 11.5 | 10 |
| one cut with 4,000 segments - cold | 69.1 | 82.8 | 5 |
| one cut with 4,000 segments - warm | 19.1 | 19.8 | 5 |
| undo with 4,000 segments - cold | 30.4 | 33.9 | 5 |
| current timeline with 4,000 segments - cold | 25.8 | 29.1 | 5 |
| resolve an edited range with 4,000 segments | 1.5 | 1.9 | 5 |
| add a caption with 4,000 segments - cold | 66.4 | 90.2 | 5 |
| add a caption with 4,000 segments - warm | 19.9 | 21 | 5 |
| one instruction carrying 4,000 cut ops | 49.6 | 53.7 | 3 |
| reorder: move 40 atoms to the end with 4,000 segments - cold | 77.3 | 97.1 | 5 |
| reorder: move 40 atoms to the end with 4,000 segments - warm | 20.6 | 23.4 | 5 |
| plan: remove fillers (240 'um' in 12,000 words) | 3.1 | 3.6 | 5 |
| apply: remove fillers as one instruction - cold | 2.9 | 4.3 | 3 |
| plan: remove silences > 50 ms (pad 20 ms) = about 12,000 cuts | 16.7 | 24.5 | 3 |
| apply: remove silences as ONE instruction of about 12,000 ops | 319.3 | 326.5 | 3 |
| plan: move edited 10 minutes to the end (4,000 segments) | 3.9 | 4.9 | 5 |
| ducking envelope, 4,000 segments | 2.5 | 8.5 | 5 |
| auto-caption cues, 4,000 segments | 7.1 | 12.3 | 5 |
| 40 captions + 4,000 segments: effect displays (all 40) | 0.1 | 0.3 | 5 |
| findTopicParts('pricing'), 40 captions + 4,000 segments | 3.5 | 6.1 | 5 |
| a caption instruction on top of 40 captions + 4,000 segments - cold | 65.3 | 78.2 | 5 |

Reading it:
- Every single-operation instruction, cold or warm, stays under 300 ms (the worst row is 97 ms), and the 4,000-op instruction is about 50 ms, with reorder in the code path (the first scenarios of the table are the earlier ones re-measured).
- The silence-removal instruction carries about 12001 cut operations in ONE instruction. That is three times the 4,000-op target size; its time is in the table and is above 300 ms. It is outside the stated target, reported for honesty, not claimed as meeting it.
- Follow-up 4 (reviewer): `findTopicParts` with 40 captions and 4,000 segments is the row "findTopicParts('pricing'), 40 captions + 4,000 segments". It is still a linear scan over all sentences on every call (nothing is cached); it is fast enough here, and was measured, not assumed.
- Segment lookups after a reorder: a cut on a reordered (unsorted) segment list falls back to a linear scan; the 4,000-segment reorder rows include that.
