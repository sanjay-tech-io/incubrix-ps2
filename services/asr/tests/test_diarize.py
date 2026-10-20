"""Word -> speaker assignment (pure), the mock diarizer and the settings. No model, no network."""
import pytest
from fastapi.testclient import TestClient

from asr.adapters.mock import MockAdapter
from asr.diarize import DiarizationSettings, Turn, assign_speakers
from asr.diarizers.mock import MockDiarizer
from asr.schema import Word
from asr.server import build_diarizer, create_app

S = DiarizationSettings(uncertain_below=0.6, overlap_min=0.2)


def w(start, end, text="x"):
    return Word(text=text, start_us=start, end_us=end, confidence_permille=900)


def test_word_takes_the_speaker_with_the_largest_overlap():
    out = assign_speakers([w(0, 1000)], [Turn(0, 700, "A"), Turn(700, 1000, "B")], S)[0]
    assert out.speaker == "A"
    assert not out.speaker_uncertain  # 0.7 >= 0.6


def test_overlap_flag_when_a_second_speaker_covers_enough_of_the_word():
    out = assign_speakers([w(0, 1000)], [Turn(0, 1000, "A"), Turn(500, 1000, "B")], S)[0]
    assert out.speaker == "A"
    assert out.overlaps_speech is True  # B covers 0.5 >= 0.2


def test_no_overlap_flag_when_second_speaker_is_below_the_threshold():
    out = assign_speakers([w(0, 1000)], [Turn(0, 1000, "A"), Turn(900, 1000, "B")], S)[0]
    assert out.overlaps_speech is False  # 0.1 < 0.2


def test_uncertain_when_best_fraction_is_below_threshold():
    out = assign_speakers([w(0, 1000)], [Turn(0, 500, "A"), Turn(500, 1000, "B")], S)[0]
    assert out.speaker_uncertain is True  # best fraction 0.5 < 0.6


def test_word_outside_every_turn_has_no_speaker_and_is_uncertain():
    out = assign_speakers([w(5000, 6000)], [Turn(0, 1000, "A")], S)[0]
    assert out.speaker is None and out.speaker_uncertain is True and out.overlaps_speech is False


def test_ties_are_broken_by_label_so_results_are_deterministic():
    out = assign_speakers([w(0, 1000)], [Turn(0, 500, "B"), Turn(500, 1000, "A")], S)[0]
    assert out.speaker == "A"


def test_turns_of_one_speaker_are_not_counted_twice():
    turns = [Turn(0, 1000, "A"), Turn(0, 1000, "A")]  # duplicate turn must not look like 2 speakers or 2x overlap
    out = assign_speakers([w(0, 1000)], turns, S)[0]
    assert out.speaker == "A" and out.overlaps_speech is False and not out.speaker_uncertain


def test_zero_length_word_uses_the_turn_that_contains_it():
    out = assign_speakers([w(500, 500)], [Turn(0, 1000, "A")], S)[0]
    assert out.speaker == "A"


def test_input_words_are_not_mutated():
    src = w(0, 1000)
    assign_speakers([src], [Turn(0, 1000, "A")], S)
    assert src.speaker is None


def test_settings_come_from_env_and_are_validated():
    s = DiarizationSettings.from_env({"DIARIZATION_UNCERTAIN_BELOW": "0.7", "DIARIZATION_OVERLAP_MIN_FRACTION": "0.3", "DIARIZATION_NUM_SPEAKERS": "2"})
    assert (s.uncertain_below, s.overlap_min, s.num_speakers) == (0.7, 0.3, 2)
    with pytest.raises(ValueError):
        DiarizationSettings.from_env({"DIARIZATION_UNCERTAIN_BELOW": "1.5"})
    with pytest.raises(ValueError):
        DiarizationSettings.from_env({"DIARIZATION_NUM_SPEAKERS": "0"})


def test_build_diarizer_names():
    assert build_diarizer("none") is None
    assert build_diarizer("mock").name == "mock"
    with pytest.raises(ValueError):
        build_diarizer("bogus")


def test_mock_diarizer_is_deterministic_and_has_two_speakers():
    a = MockDiarizer().diarize(b"x")
    assert a == MockDiarizer().diarize(b"x")
    assert {t.speaker for t in a} == {"SPEAKER_00", "SPEAKER_01"}


def test_service_labels_words_when_a_diarizer_is_configured():
    c = TestClient(create_app(MockAdapter(), MockDiarizer()))
    body = c.post("/transcribe", files={"file": ("a.wav", b"x", "audio/wav")}).json()
    assert all("speaker" in x and "speaker_uncertain" in x and "overlaps_speech" in x for x in body["words"])
    assert {x["speaker"] for x in body["words"] if x.get("speaker")} == {"SPEAKER_00", "SPEAKER_01"}
    assert body["settings"]["diarization"]["provider"] == "mock"


def test_service_can_skip_diarization_per_request():
    c = TestClient(create_app(MockAdapter(), MockDiarizer()))
    body = c.post("/transcribe?diarize=false", files={"file": ("a.wav", b"x", "audio/wav")}).json()
    assert "speaker" not in body["words"][0]


def test_health_reports_the_diarizer():
    assert TestClient(create_app(MockAdapter(), MockDiarizer())).get("/health").json()["diarization"] == "mock"
    assert TestClient(create_app(MockAdapter(), None)).get("/health").json()["diarization"] == "none"


def test_num_speakers_hint_reaches_the_diarizer_and_is_reported():
    c = TestClient(create_app(MockAdapter(), MockDiarizer()))
    body = c.post("/transcribe?num_speakers=1", files={"file": ("a.wav", b"x", "audio/wav")}).json()
    assert {x["speaker"] for x in body["words"]} == {"SPEAKER_00"}
    assert body["settings"]["diarization"]["num_speakers_hint"] == 1


def test_bad_num_speakers_is_a_structured_error():
    c = TestClient(create_app(MockAdapter(), MockDiarizer()))
    r = c.post("/transcribe?num_speakers=0", files={"file": ("a.wav", b"x", "audio/wav")})
    assert r.status_code == 400 and r.json()["error"]["code"] == "BAD_NUM_SPEAKERS"
