"""Real-model check of label-swap detection. Skipped unless DIARIZATION_TEST_AUDIO points to the two-voice wav made by
spike/make_two_voice.sh (inside the asr image the ONNX models are in /models/diarization). Run:
  docker run --rm -e PYTHONPATH=/app -e DIARIZATION_TEST_AUDIO=/data/two_voice.wav -v <dir>:/data:ro --entrypoint python incubrix-ps2-asr -m pytest -q /app/tests/test_swap_real.py
(the tests/ folder is only in the test image: copy it in or mount it). Synthetic espeak voices only: says nothing about real speech."""
import os
from pathlib import Path

import pytest

from asr.diarize import DiarizationSettings, Turn
from asr.diarizers.sherpa import SherpaDiarizer
from asr.swap import SwapSettings, check_turns

audio_path = os.environ.get("DIARIZATION_TEST_AUDIO")
pytestmark = pytest.mark.skipif(not audio_path, reason="DIARIZATION_TEST_AUDIO not set")

S = SwapSettings()


@pytest.fixture(scope="module")
def clip():
    audio = Path(audio_path).read_bytes()
    d = SherpaDiarizer(os.environ.get("DIARIZATION_MODEL_DIR", "/models/diarization"), DiarizationSettings(num_speakers=2))
    turns = d.diarize(audio, 2)
    return turns, d.turn_embeddings(audio, turns, S.min_turn_us)


def test_faithful_labels_are_not_flagged(clip):
    turns, emb = clip
    assert len({t.speaker for t in turns}) == 2
    assert [c.flagged for c in check_turns(turns, emb, S)] == [False] * len(turns)


def test_every_single_turn_relabelled_on_purpose_is_flagged_and_nothing_else(clip):
    turns, emb = clip
    labels = sorted({t.speaker for t in turns})
    other = {labels[0]: labels[1], labels[1]: labels[0]}
    for i, t in enumerate(turns):
        swapped = list(turns)
        swapped[i] = Turn(t.start_us, t.end_us, other[t.speaker])
        flagged = [c.index for c in check_turns(swapped, emb, S) if c.flagged]
        assert flagged == [i], f"turn {i}"
