# Design of the editing engine (M1)

Plain-language summary of `packages/engine`. Code is the source of truth; every rule below has a test.

## The one idea
The original file is never touched. An edit is a line appended to a log, and the "edited video" is just a *recipe* computed by replaying that log over the original. Rendering to a real video file is a separate, later step.

## Atoms: what edits point at
After transcription the source is cut into **atoms**: words and silences, back to back with no gaps, covering the full duration. Each atom has an ID derived from the source hash, its position, its text and its start time, so the same video always gives the same IDs. Atoms carry speaker, confidence, and flags (`lowConfidence`, `filler`, `overlapsSpeech`, `speakerUncertain`).
Captions, mutes and bleeps attach to a **range of atom IDs, never to seconds**. That is why they stay on their words when material before them is cut, sped up or restored.

## Time
All times are integer microseconds; speed is a fraction (2/1, 1/2), never a float. Frame maths uses the exact fps fraction (e.g. 30000/1001) and is only needed to snap cut points.

## Cursors
A cut needs a position that may lie inside a long silence ("cut the first 30 s" when the pause runs 29.2-31.0). A **cursor** is *(atom ID, offset from that atom's start)*:
- offset is a whole number, `0 <= offset < atom length`;
- inside a **word**, the offset must be 0, so a cut can never split a word;
- inside a **silence**, a non-zero offset must sit on a frame boundary;
- source-side cut boundaries lie on the frame grid: a boundary between a silence and a word moves *into the silence* (earlier if the silence is before the word, later if after), never into the word. Only a boundary between two touching words, or a silence too short to hold a grid point, stays off-grid and the answer warns;
- the end of the video is written *(last atom, its length)* and is allowed only as the end of a span.
A boundary between two atoms has one spelling: *(next atom, 0)*.

## The log, groups, undo, redo, restore
The log is append-only. One user instruction becomes one **group** (its operations share a group number) and is one undo step.
- **Undo / redo** are marker entries. Replay keeps a stack of applied groups and a stack of undone groups: undo moves the top group across, redo moves it back, and *any new edit empties the redo stack*.
- **Restore edit N** is a new operation pointing at group N. When replaying, a group that a (still applied) restore points at is skipped. Nothing is deleted, so undoing the restore cuts the material again, and restoring a restore brings the original edit back. Later edits stay in force.
- Asking a question (needs_clarification) or being rejected writes only to the **conversation log**, never to the operation log, so the hash does not change and it is not an undo step.

## Materializing the timeline
`timeline = replay(log)`: start with one segment covering the whole source, then apply each operation of each group in effect. The result (segments, speed regions, effects, protected pauses, music, auto-caption style, duration) is the **timeline**. `IncrementalTimeline` computes the same thing with per-group snapshots and is checked against the full replay by a property test.

## Time mapping
The edited video is a list of *pieces*: a stretch of source played at one rate. Original-to-edited and back are one multiply/divide inside the right piece. The output is a whole number of frames: pieces get frames by *cumulative rounding* (frames = round(exact cumulative frames) minus the previous round), so the total is round(exact total) and each piece is within 1 frame of its exact length. Instructions use the **current edited timeline** unless the user says "original"; every answer states the policy. An edited range that crosses a removed gap becomes several source spans (the gap is skipped).

## The cut rule
A cut point inside a silence is exact (snapped to the frame grid). A cut point inside a word moves to the edge of a nearby silence, and the answer warns. A point already on an atom boundary is left alone.

## Speed
Allowed range is 0.25x to `MAX_SPEED` (default 4x); anything else is rejected with the reason and the range.
**Overlap rule: the later change wins on the overlap and replaces the earlier rate; rates never multiply.** The earlier region is split around it, and 1x clears speed. Example: 2x over 1:30-1:48, then 1x over 1:35-1:40, leaves 2x on 1:30-1:35 and 1:40-1:48. Speed regions are kept in source coordinates and clipped to what survives, so they come back with a restored cut.

## Effects when their words are cut
- **All** anchor words cut: the effect becomes **inactive** (not shown), but it is never deleted from the log. The answer says so; restoring the words reactivates it.
- **Some** words cut (partial rule): the effect keeps its literal text on the surviving words and the answer lists the cut words.
- A caption or text overlay is shown for at least **0.7 s** after a speed-up; if lengthened, the answer warns.
- Auto-caption text is derived from surviving words each time, so it cannot show a cut word.

## Hash
`timeline_hash` = SHA-256 (pure JS) of the canonical JSON (sorted keys, no spaces) of the timeline. Canonical JSON *throws* on floats, NaN and undefined. The timeline holds no times of day, session IDs or conversation text. Effect IDs are `fx_<n>_<k>` where *n* counts edit operations only (not undo/redo markers or conversation turns). Consequence: two different histories that look identical can hash differently; the same history always hashes the same.

## Reorder: output order and source order are independent (M1c)
The materialized timeline lists **segments in output order**, each a source interval. Atoms, speed regions and effects are anchored to **source** positions and never move; only the playing order changes. For time mapping every piece (a stretch of source at one rate) is kept in **two indexes**: the output index (the array itself, sorted by output start) for edited-to-source, and a source index (positions sorted by source start) for source-to-edited, atom lookups and effect runs. Without a reorder the two coincide.
**The move rule.** `move(span, before)` takes every surviving piece inside the source span, as one block that keeps its current output order, and re-inserts it immediately before the surviving material at the source position `before` (splitting a segment if `before` falls inside one). If `before` falls in cut material, the block goes before the next surviving material in source order; null means the end. A target strictly inside the span is rejected. Segments that become contiguous in the source again are merged, so a move and its inverse give the identical hash.
- **(a) Speed regions** stay attached to their source atoms: moving 90-92 s that was sped up 2x keeps it at 2x at its new place; the region itself does not change.
- **(b) An effect whose words end up apart.** The effect has *runs*: walking its surviving words in source order, a word continues the run if it plays after the previous one and everything that plays between them comes from inside the effect's own source range. A caption or text overlay is shown on the **first run** (the one holding its first surviving word) and the answer warns that it is split (`fragmented`); mute and bleep apply to **every** run, since they are about specific words. Moving the whole range keeps one run.
- **(c) A cut that spans moved material** removes those source atoms wherever they now play, so "move then cut" equals "cut" on the same source span. A move whose span covers already-moved pieces moves them together, in their current order.
- **(d) Undo and restore.** Undo removes the group. Restore skips the group, as if that edit never happened, and later edits (defined by source positions) still apply. Two moves do not commute, so restoring an earlier move re-applies the later one on the original order.

## Fillers, silences, pinned pauses, music
- **Fillers.** Atoms flagged `filler` (um, uh, and a "like" decided by a fixed rule). A "like" is a filler only if its own text ends with a comma, or the previous word does, or pauses of 0.3 s or more surround it, or it directly follows um/uh; "I like this tool" is not. A filler inside a mute or bleep you added is **kept**, with a warning. A silence of at most 0.5 s right after a removed filler goes with it. Consecutive fillers become one cut.
- **Silences longer than N.** Each surviving stretch of a silence longer than N is cut down to a **pad** (default 0.15 s, a setting) on each side that touches speech; sides touching a cut or the ends of the video keep none. Pinned pauses (`protect_pause`) are never touched and are counted in the answer. Cuts are rounded to the frame grid inside the silence, so the pad is never shorter than asked. Neighbours are judged in the source.
- **Music** is a timeline track (asset sha256, gain, duck depth, attack, release in integers). `duckingEnvelope` turns the final speech (read from the output, so cuts, speed and reorder are respected) into gain keyframes: fully ducked when speech starts, back to base `release` after it ends; speech closer than attack + release is one ducked stretch; keyframe times strictly increase from 0 to the end.
- **Auto-caption** text and chunks come from the surviving words in output order: a cue ends after 6 words, at . ! ?, or at a gap of 0.5 s or more in the output.

## Grid convention the renderer must follow
Frame `k` starts at `round(k * den * 1e6 / num)` microseconds (round half up) for fps `num/den`. A time "is on the grid" if it equals such a value. The output is a whole number of frames (cumulative rounding, above), so an uncut 10 s source at 29.97 fps lasts 10.01 s (300 frames). A boundary between two touching words cannot be put on the grid and is warned about. **Agreement of these boundaries with ffmpeg is NOT VERIFIED until M3.**

## Not implemented yet
Instruction parsing (rules/LLM), rendering and audio mixing, real transcription/diarization, meaning-based search (a tiny synonym list stands in), multi-speaker handling, OTIO export.
