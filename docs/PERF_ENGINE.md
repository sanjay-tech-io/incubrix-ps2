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
