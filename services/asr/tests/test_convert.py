import pytest

from asr.schema import Word, permille, to_us


def test_to_us_rounds_to_integer_microseconds():
    assert to_us(1.5) == 1_500_000
    assert to_us(0.0000004) == 0
    assert to_us(0.0000006) == 1
    assert isinstance(to_us(2.0), int)


def test_permille_rounds_and_clamps():
    assert permille(0.9996) == 1000
    assert permille(0.5) == 500
    assert permille(-0.2) == 0
    assert permille(1.7) == 1000
    assert isinstance(permille(0.3), int)


def test_word_rejects_end_before_start():
    with pytest.raises(ValueError):
        Word(text="x", start_us=10, end_us=5, confidence_permille=500)


def test_word_speaker_is_optional_and_omitted_when_none():
    w = Word(text="hi", start_us=0, end_us=10, confidence_permille=900)
    assert w.speaker is None
    assert "speaker" not in w.model_dump(exclude_none=True)
