"""Real-model test. Skipped unless ASR_TEST_AUDIO points to a speech file (the model is downloaded on first use)."""
import os
from pathlib import Path

import pytest

from asr.adapters.fwhisper import FasterWhisperAdapter

audio = os.environ.get("ASR_TEST_AUDIO")
pytestmark = pytest.mark.skipif(not audio, reason="ASR_TEST_AUDIO not set")


def test_real_model_returns_ordered_integer_words():
    t = FasterWhisperAdapter(os.environ.get("WHISPER_MODEL", "tiny.en")).transcribe(Path(audio).read_bytes(), initial_prompt=None, vad_filter=True)
    assert len(t.words) > 0
    assert all(isinstance(w.start_us, int) and isinstance(w.end_us, int) for w in t.words)
    assert all(a.start_us <= b.start_us for a, b in zip(t.words, t.words[1:]))
    assert t.timings["rtf"] > 0
