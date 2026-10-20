"""Real-model test. Skipped unless DIARIZATION_TEST_AUDIO points to a wav file and the ONNX models exist
(inside the asr image they are in /models/diarization). Expected speakers come from DIARIZATION_TEST_SPEAKERS."""
import os
from pathlib import Path

import pytest

from asr.diarize import DiarizationSettings
from asr.diarizers.sherpa import SherpaDiarizer

audio = os.environ.get("DIARIZATION_TEST_AUDIO")
pytestmark = pytest.mark.skipif(not audio, reason="DIARIZATION_TEST_AUDIO not set")


def test_real_diarizer_returns_ordered_turns_with_given_speaker_count():
    n = int(os.environ.get("DIARIZATION_TEST_SPEAKERS", "2"))
    d = SherpaDiarizer(os.environ.get("DIARIZATION_MODEL_DIR", "/models/diarization"), DiarizationSettings(num_speakers=n))
    turns = d.diarize(Path(audio).read_bytes())
    assert turns and all(t.start_us < t.end_us for t in turns)
    assert all(a.start_us <= b.start_us for a, b in zip(turns, turns[1:]))
    assert len({t.speaker for t in turns}) == n
