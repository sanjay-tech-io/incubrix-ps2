from asr.adapters.mock import MockAdapter


def test_mock_returns_fixture_with_integer_times_and_disfluencies():
    t = MockAdapter().transcribe(b"ignored", initial_prompt=None, vad_filter=True)
    assert t.adapter == "mock"
    assert len(t.words) > 5
    assert all(isinstance(w.start_us, int) and isinstance(w.end_us, int) for w in t.words)
    assert all(0 <= w.confidence_permille <= 1000 for w in t.words)
    assert any(w.text.lower().strip(",.") in {"um", "uh"} for w in t.words)


def test_mock_words_are_ordered_and_non_overlapping():
    words = MockAdapter().transcribe(b"", initial_prompt=None, vad_filter=True).words
    for a, b in zip(words, words[1:]):
        assert a.end_us <= b.start_us


def test_mock_is_deterministic():
    a = MockAdapter().transcribe(b"x", initial_prompt=None, vad_filter=True)
    b = MockAdapter().transcribe(b"y", initial_prompt=None, vad_filter=True)
    assert a.model_dump() == b.model_dump()
