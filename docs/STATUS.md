# Project status (project memory)

Updated at the end of every milestone. Last update: end of M1b (2026-10-20). Everything below was run, not assumed; "not verified" means exactly that.

## Done and verified
| Item | Proof (command) |
|---|---|
| npm workspaces (engine, contracts), strict TypeScript, vitest, ESLint purity rules | `npm test` exit 0; `npm run typecheck` exit 0 |
| Clean install from the public registry; lockfile has no mirror URLs | `grep -c npmmirror package-lock.json` = 0; `npm ci` then `npm test` exit 0 |
| zod contracts are the source of truth; JSON Schema generated and compared with the committed file | `npm test` (packages/contracts: 4 tests; engine `schema.test.ts`) |
| Canonical JSON, pure-JS SHA-256 | `npm test` (`canonical.test.ts`) |
| Atoms, cursors, frame grid, snapping into silence | `npm test` (`atoms.test.ts`, `frame_rounding.test.ts`) |
| Output frames by cumulative rounding (odd counts, property test) | `npm test` (`frame_rounding.test.ts`) |
| Replay, undo/redo/restore, time mapping, speed rules, effect states | `npm test` (`replay.test.ts`, `session.test.ts`) |
| Worked example steps 1-7 on the synthetic fixture | `npm test` (`worked_example.test.ts`) |
| Incremental == full replay; cached session path == fresh replay | `npm test` (`hard_cases.test.ts`) |
| Engine purity rules actually fire | `npm test` (`lint_guard.test.ts`) |
| Surviving mutants killed; 15 of 15 hand-picked mutants die | `npm test` (`mutants.test.ts`); `npm run mutation-check` |
| Performance targets on a synthetic 60-minute source | `npm run bench -w @incubrix/engine` (docs/PERF_ENGINE.md) |

Latest `npm test` (root): contracts 4 passed; engine 174 passed, 1 skipped (the render step, "needs M3"). Last update of this file: end of M1b (2026-10-20).

## Not verified (not built or not run)
Docker / docker compose (Docker is not installed on the dev machine); rendering and A/V sync (M3); worked example step 8; API, jobs, idempotency, errors, health, manifest, docker compose (M2); real ASR and diarization; LLM adapters; reorder, filler and silence removal, music ducking, mute/bleep audio; multi-speaker handling; OTIO export; performance on a real 60-minute video or through the API (only a synthetic source on one laptop is measured); any real video; any metric; CI.

## Decisions
Full list: `CLAUDE.md` section "Decisions" and `docs/DESIGN.md`. Headlines: Node 22; real ASR/diarization in the demo and mocks for tests only; cursor = (atom, offset) with offset only inside silences and on the frame grid; partial-cut rule and inactive effects; 0.7 s minimum caption time; speed range 0.25x-4x (`MAX_SPEED`); later speed change replaces the earlier rate; restore is a new op that points at a group; effect ids count edit ops only; sha256 from @noble/hashes; no React UI (M7 = Swagger UI/Redoc from openapi.yaml).

## Open items
- Record the single-speaker test video from `docs/TEST_VIDEO_SCRIPT.md`, add it to `SOURCES.md`.
- Decide how to resolve "the intro"/"that caption" style references (parser/history lookup, M2/M4).
- Boundaries between two touching words cannot be frame-snapped; check the drift once M3 can render (REVIEW_M1B doubt 2).
- Install/verify Docker on the GCP VM before M2.
- Reorder (M4) must add a separate source index: binary search in the engine assumes output order == source order.
- `npm audit` reports 6 vulnerabilities in dev dependencies; not investigated.
- Add `.gitattributes` for line endings (needs approval).
- Reorder (`move`), filler/silence removal, music, multi-speaker: M4.
- No `test-pack/` exists yet; no metric may be quoted until real runs are saved there.

## Claims ledger (claim -> evidence -> verified)
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
| 26 | Instruction latency, 60-minute scale | superseded by row 32 (synthetic source only; real 60-minute video, API and database path not measured) | partly |
| 27 | Real ASR, diarization, API, jobs, idempotency, compose, OTIO | not built | **no** |
| 28 | Any metric (latency, cost, clipping, clarification quality) | none produced; nothing is under `test-pack/` | **no** |
| 29 | `registry=https://registry.npmjs.org/` is pinned and the lockfile has no mirror URLs | `.npmrc`; `grep -c npmmirror package-lock.json` = 0; `npm ci` then `npm test` exit 0 (REVIEW_M1B section 1) | yes |
| 30 | Source-side cut boundaries are on the frame grid (silence-to-word boundaries move into the silence, never into a word) | `frame_rounding.test.ts`; mutant "floor/ceil swapped" killed | yes, except boundaries between two touching words (cannot be snapped; warned in `snapPoint`) |
| 31 | Output frames: sum of piece frames = round(total); each piece within 1 frame | `frame_rounding.test.ts` (odd counts at 2x and 3/2x; seeded property, 150 runs, independent BigInt arithmetic); mutant "per-piece rounding" killed | yes (engine arithmetic only; **not** against a rendered video) |
| 32 | Any instruction < 300 ms; 4,000-op instruction < 1 s (synthetic 60 min, 24,001 atoms) | `docs/PERF_ENGINE.md`, `npm run bench -w @incubrix/engine`; worst single observed 155.9 ms; 4,000-op ~50-58 ms | yes on this laptop, synthetic data |
| 33 | Cached session path equals a replay on a brand-new engine | `hard_cases.test.ts` property (100 seeded sessions incl. restore and rejected turns); 3 cache mutants killed | yes |
| 34 | Music, protected pauses, auto-caption style are in the timeline and hash; effect ids count edit entries only | `mutants.test.ts`; 4 original surviving mutants killed (without these tests 4 of 9 survived) | yes |
| 35 | zod contracts are the source of truth; committed JSON Schema equals the generated one | `packages/contracts/test/schema.test.ts` | yes |
| 36 | Docker works on the dev machine / compose runs | `docker --version`: command not found on this machine | **no** |
