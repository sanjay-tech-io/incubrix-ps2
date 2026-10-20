"""Score diarized words against the by-construction truth of the two-voice clip.
Usage: python -I score_two_voice.py TRANSCRIPT.json TRUTH.json
A word's true speaker is the line whose [start,end] contains the word midpoint (words in the gaps are skipped).
Predicted labels are mapped to true speakers by the best one-to-one majority assignment (2 true speakers)."""
import itertools
import json
import sys

tr = json.load(open(sys.argv[1]))
truth = json.load(open(sys.argv[2]))
rows = []
for w in tr["words"]:
    mid = (w["start_us"] + w["end_us"]) / 2e6
    t = next((l["speaker"] for l in truth if l["start_s"] <= mid <= l["end_s"]), None)
    if t:
        rows.append((t, w.get("speaker")))
pred = sorted({p for _, p in rows if p})
best = (0, None)
for perm in itertools.permutations(["A", "B"], min(2, len(pred))) if pred else []:
    m = dict(zip(pred, perm))
    ok = sum(1 for t, p in rows if m.get(p) == t)
    if ok > best[0]:
        best = (ok, m)
d = tr["settings"].get("diarization", {})
print(json.dumps({"words_scored": len(rows), "words_correct": best[0], "accuracy": round(best[0] / len(rows), 3) if rows else None,
                  "speakers_expected": 2, "speakers_found": d.get("speakers_found"), "mapping": best[1],
                  "uncertain": sum(1 for w in tr["words"] if w.get("speaker_uncertain")),
                  "overlaps": sum(1 for w in tr["words"] if w.get("overlaps_speech"))}))
