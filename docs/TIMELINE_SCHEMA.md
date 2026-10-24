# Timeline schema: how edits stay attached to content

Schema file: [`packages/contracts/schemas/timeline.schema.json`](../packages/contracts/schemas/timeline.schema.json) (JSON Schema, generated from the zod contracts in `packages/contracts` by `npm run generate -w @incubrix/contracts`; a test, `packages/contracts/test/schema.test.ts`, fails if the committed file differs). The engine's types are inferred from the same zod schemas, so the schema cannot drift from the code. The full rules are in [`DESIGN.md`](DESIGN.md).

## The idea in four lines
1. The source video is never edited. It is turned once into **atoms**: words and silences, back to back, covering the whole duration.
2. Every edit is a line in an **append-only log**. Edits name atoms, not seconds.
3. The edited video is `timeline = replay(log)`. Nothing else is stored as truth.
4. Seconds exist only at the edges: when the user types one (it is resolved to atoms), and when the renderer draws frames.

## The objects (names as in the schema)
| Object | What it holds | Why it keeps edits attached |
|---|---|---|
| `Atom` | `id`, `kind` (word or silence), `startUs`, `endUs`, `text`, `speaker`, `confidencePermille` and flags (`lowConfidence`, `filler`, `overlapsSpeech`, `speakerUncertain`, `possibleLabelSwap`) | The id is derived from the source sha256, position, text and start time. The same video gives the same ids, with no random value or clock. Times are integer microseconds |
| `AtomRange` | `from` and `to` atom ids | A caption, mute or bleep points at a range of atoms. A cut earlier in the video changes where those atoms play, not which atoms they are |
| `Cursor` / `Span` | an atom id plus an offset in microseconds | Cuts need a position. An offset other than 0 is allowed only inside a silence, so a cut can never split a word (a cut inside a word snaps to the nearest silence and warns) |
| `LogEntry` | `seq` and one of: `edit` (with `group` and an `Operation`), `undo`, `redo` | One instruction becomes one `group`, so one undo step. A new edit clears redo. Nothing is rewritten or deleted |
| `Operation` | `cut`, `keep_only`, `move`, `set_speed`, `add_effect`, `update_effect`, `remove_effect`, `auto_caption`, `clear_auto_caption`, `set_music`, `clear_music`, `protect_pause`, `unprotect_pause`, `restore` | Each operation stores resolved atom ranges and cursors. "Restore edit N" is a new `restore` operation that points at group N |
| `Timeline` | `segments` (source intervals in **output order**), `speedRegions` (source intervals with an exact fraction `Rate`), `effects`, `protectedPauses`, `music`, `autoCaption`, `durationUs` | The result of replay. It is derived, so it can always be rebuilt from the log |
| `Effect` | `id`, `range` (an `AtomRange`), `params`, `state` (`active` or `inactive`), `partial`, `fragmented`, `createdInGroup` | `state` and the two flags are computed from which of its atoms survive |
| `Answer` | `status` (applied, needs_clarification, rejected), operations, summary, question, options, reason, time policy, warnings, `timeline_hash`, duration | The one reply shape for every instruction |

## What happens to an effect when the video changes
Take the caption "Welcome!" on the atoms of "welcome to our channel":
- **Cut before it, or speed up before it:** the atoms are untouched, so the caption plays on the same words. Only its position in the edited time changes. The answer reports it ("caption moved from 0:39.501 to 0:09.501" in `test-pack/real/worked_example_real/results.json`).
- **Some of its words are cut:** the caption keeps its literal text on the surviving words, and the answer lists the cut words (`partial` is true).
- **All of its words are cut:** the effect becomes `inactive`. It is never deleted from the log. The answer says so. Restoring the words makes it `active` again (`replay` simply skips the cut).
- **Restore:** a `restore` operation makes replay skip the group it points at. Later edits stay in force, because they are defined by atoms and not by positions.
- **Reorder:** speed regions and effects stay anchored to the source atoms; only the output order of the segments changes. If a reorder splits the words of one effect into separate runs, a caption shows on the first run and `fragmented` is true; mute and bleep apply to every run.
- **Speed change:** regions are stored on the source side and clipped to what survives. A caption shorter than 0.7 s after a speed-up is shown for 0.7 s and the answer warns.

## Hash
`timeline_hash` is the sha256 of the canonical JSON (sorted keys, no floats) of the `Timeline`. It contains no clock, session id, random id or conversation text. Effect ids are `fx_<n>_<k>` where n counts edit operations only. So the same history always gives the same hash. Two different histories that look the same can give different hashes (stated in `DESIGN.md`).

## Evidence
- Same hash after 3 replays: `packages/engine/test/session.test.ts`. A property test checks the cached session path equals a replay on a new engine: `hard_cases.test.ts`.
- Edits that stay with their words after cut, restore and reorder: `hard_cases.test.ts`, `reorder.test.ts`, scenarios S04, S05, S06, S48 in `scenarios/`.
- On real video: the caption sat on frames 1186-1246 before the cut, 286-346 after it, and 1186-1246 again after "put the intro back" (`docs/WORKED_EXAMPLE_REAL.md` section 3, `test-pack/real/caption_frame_scans.json`).
- A real, full `timeline.json` of a session: `test-pack/real/worked_example_real/timeline.json`.

## Limits
- The schema describes the engine's data. The OpenTimelineIO export is a separate format with its own conventions (`docs/REVIEW_M5.md` section 2).
- Atom times come from the speech recognizer (word timestamps are not ground truth). Edits stay attached to the recognizer's words; they cannot be better than its word boundaries.
