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

## Not in M1
Reorder (`move`), filler/silence removal, music rendering, instruction parsing, rendering. Reorder throws `NOT_IMPLEMENTED`.
