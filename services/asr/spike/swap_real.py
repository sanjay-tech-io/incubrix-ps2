"""Real-model check of label-swap detection on the by-construction two-voice clip (spike/make_two_voice.sh).
Usage (inside the asr image, models in /models/diarization): python -I swap_real.py TWO_VOICE.wav TRUTH.json
1. diarize (2 speakers) and check the diarizer's OWN labels: any flag here is a false positive on this clip.
2. swap on purpose: relabel ONE turn to the other speaker, check it is flagged and nothing else is; repeat for every turn.
Also prints the similarities so the margin can be judged. Synthetic voices (espeak-ng): says nothing about real speech."""
import json
import os
import sys
from pathlib import Path

from asr.diarize import DiarizationSettings, Turn
from asr.diarizers.sherpa import SherpaDiarizer
from asr.swap import SwapSettings, check_turns

audio = Path(sys.argv[1]).read_bytes()
truth = json.load(open(sys.argv[2]))
s = SwapSettings.from_env(os.environ)
d = SherpaDiarizer(os.environ.get("DIARIZATION_MODEL_DIR", "/models/diarization"), DiarizationSettings(num_speakers=2))
turns = d.diarize(audio, 2)
emb = d.turn_embeddings(audio, turns, s.min_turn_us)
print(json.dumps({"settings": {"margin": s.margin, "min_turn_s": s.min_turn_us / 1e6}, "turns": [{"i": i, "start_s": t.start_us / 1e6, "end_s": t.end_us / 1e6, "label": t.speaker, "true": next((l["speaker"] for l in truth if l["start_s"] <= (t.start_us + t.end_us) / 2e6 <= l["end_s"]), None)} for i, t in enumerate(turns)]}))

base = check_turns(turns, emb, s)
print("FAITHFUL LABELS:", json.dumps([{"i": c.index, "label": c.speaker, "testable": c.testable, "flagged": c.flagged, "own": round(c.own_sim, 3), "other": round(c.best_other_sim, 3), "reason": c.reason} for c in base]))
labels = sorted({t.speaker for t in turns})
assert len(labels) == 2, labels
other = {labels[0]: labels[1], labels[1]: labels[0]}
hits, extra = 0, 0
for i, t in enumerate(turns):
    swapped = list(turns)
    swapped[i] = Turn(t.start_us, t.end_us, other[t.speaker])
    r = check_turns(swapped, emb, s)
    flagged = [c.index for c in r if c.flagged]
    ok = i in flagged
    hits += ok
    extra += len([x for x in flagged if x != i])
    print(f"SWAP turn {i} ({t.speaker} -> {other[t.speaker]}): flagged={flagged} detected={ok} own={r[i].own_sim:.3f} other={r[i].best_other_sim:.3f} testable={r[i].testable} {r[i].reason}")
print(json.dumps({"turns": len(turns), "swaps_detected": hits, "other_turns_flagged_in_swap_trials": extra, "false_positives_on_faithful_labels": sum(c.flagged for c in base)}))
