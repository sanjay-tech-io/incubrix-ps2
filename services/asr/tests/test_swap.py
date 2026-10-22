"""Speaker-label swap detection: compare each turn's voice embedding with the speaker centroids.
Pure arithmetic on vectors (no model), plus the wiring into the service. The real-model run is in test_swap_real.py."""
import math

import pytest
from fastapi.testclient import TestClient

from asr.adapters.mock import MockAdapter
from asr.diarize import DiarizationSettings, Turn, assign_speakers
from asr.schema import Word
from asr.server import create_app
from asr.swap import SwapSettings, check_turns, mark_swapped_words

S = SwapSettings(margin=0.05, min_turn_us=1_500_000)
SEC = 1_000_000


def vec(angle_deg: float, noise: float = 0.0, dim: int = 8):
    """A unit vector at an angle in the first plane (+ a deterministic wobble in other dimensions)."""
    a = math.radians(angle_deg)
    v = [math.cos(a), math.sin(a)] + [noise * math.sin(7 * k + angle_deg) for k in range(dim - 2)]
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v]


# speaker A's voice is near 0 degrees, speaker B's near 90 degrees
def two_voice_turns():
    t = [(0, "A", 0), (3, "B", 90), (6, "A", 6), (9, "B", 84), (12, "A", -5), (15, "B", 95)]
    turns = [Turn(s * SEC, (s + 2) * SEC, spk) for s, spk, _ in t]
    emb = [vec(a, noise=0.05) for _, _, a in t]
    return turns, emb


def test_faithful_labels_are_not_flagged():
    turns, emb = two_voice_turns()
    r = check_turns(turns, emb, S)
    assert [c.flagged for c in r] == [False] * 6
    assert all(c.testable for c in r)


def test_a_label_swapped_on_purpose_is_flagged_and_only_that_turn():
    turns, emb = two_voice_turns()
    turns[2] = Turn(turns[2].start_us, turns[2].end_us, "B")  # a turn that sounds like A is labelled B
    r = check_turns(turns, emb, S)
    assert [c.flagged for c in r] == [False, False, True, False, False, False]
    assert r[2].speaker == "B" and r[2].nearest == "A"
    assert r[2].best_other_sim > r[2].own_sim + S.margin


def test_swap_is_found_whichever_way_it_goes():
    turns, emb = two_voice_turns()
    turns[3] = Turn(turns[3].start_us, turns[3].end_us, "A")  # B's voice labelled A
    assert [c.flagged for c in check_turns(turns, emb, S)] == [False, False, False, True, False, False]


def test_a_turn_between_two_voices_is_flagged_only_when_the_gap_is_bigger_than_the_margin():
    turns, emb = two_voice_turns()
    emb[2] = vec(50)  # labelled A, but a bit closer to B: cosine to B minus cosine to A is about 0.13
    assert check_turns(turns, emb, SwapSettings(margin=0.05, min_turn_us=1_500_000))[2].flagged is True
    assert check_turns(turns, emb, SwapSettings(margin=0.3, min_turn_us=1_500_000))[2].flagged is False


def test_short_turns_and_missing_embeddings_are_not_judged():
    turns, emb = two_voice_turns()
    turns[2] = Turn(6 * SEC, 6 * SEC + 400_000, "B")  # 0.4 s: too short to trust, and wrongly labelled
    r = check_turns(turns, emb, S)
    assert r[2].testable is False and r[2].flagged is False and "short" in r[2].reason
    emb[4] = None
    r = check_turns(turns, emb, S)
    assert r[4].testable is False and r[4].flagged is False


def test_a_speaker_with_only_one_turn_cannot_be_checked_against_itself():
    turns = [Turn(0, 2 * SEC, "A"), Turn(3 * SEC, 5 * SEC, "A"), Turn(6 * SEC, 8 * SEC, "B")]
    emb = [vec(0), vec(3), vec(0)]  # B's only turn sounds like A
    r = check_turns(turns, emb, S)
    assert r[2].testable is False and r[2].flagged is False and "only one" in r[2].reason
    assert [c.flagged for c in r[:2]] == [False, False]


def test_one_speaker_means_nothing_to_compare():
    turns = [Turn(0, 2 * SEC, "A"), Turn(3 * SEC, 5 * SEC, "A")]
    assert [c.flagged for c in check_turns(turns, [vec(0), vec(5)], S)] == [False, False]


def test_result_does_not_depend_on_the_order_of_the_turns():
    turns, emb = two_voice_turns()
    turns[2] = Turn(turns[2].start_us, turns[2].end_us, "B")
    fwd = {(c.speaker, round(c.own_sim, 9)) for c in check_turns(turns, emb, S) if c.flagged}
    rev = {(c.speaker, round(c.own_sim, 9)) for c in check_turns(turns[::-1], emb[::-1], S) if c.flagged}
    assert fwd == rev and len(fwd) == 1


def test_words_inside_a_flagged_turn_get_the_flag_the_others_do_not():
    turns, emb = two_voice_turns()
    turns[2] = Turn(turns[2].start_us, turns[2].end_us, "B")
    checks = check_turns(turns, emb, S)
    words = [Word(text="a", start_us=1 * SEC, end_us=2 * SEC, confidence_permille=900), Word(text="b", start_us=6 * SEC + 100_000, end_us=7 * SEC, confidence_permille=900)]
    assigned = assign_speakers(words, turns, DiarizationSettings())
    out = mark_swapped_words(assigned, turns, checks)
    assert [w.possible_label_swap for w in out] == [False, True]
    assert [w.speaker for w in out] == ["A", "B"]  # the label itself is NOT changed: it is only flagged


class FakeDiarizer:
    name = "fake"

    def __init__(self, swap: bool):
        self.swap = swap
        self.turns, self.emb = two_voice_turns()
        if swap:
            self.turns[2] = Turn(self.turns[2].start_us, self.turns[2].end_us, "B")

    def diarize(self, audio, num_speakers=None):
        return self.turns

    def turn_embeddings(self, audio, turns, min_turn_us):
        return self.emb

    def describe(self):
        return {"provider": "fake"}


def words_json():
    return [Word(text=t, start_us=s * SEC + 200_000, end_us=s * SEC + 900_000, confidence_permille=900) for t, s in (("one", 0), ("two", 3), ("three", 6), ("four", 9))]


class WordsAdapter(MockAdapter):
    def transcribe(self, audio, *, initial_prompt=None, vad_filter=True):
        t = super().transcribe(audio, initial_prompt=initial_prompt, vad_filter=vad_filter)
        t.words = words_json()
        return t


@pytest.mark.parametrize("swap", [False, True])
def test_service_flags_words_and_reports_a_summary(swap):
    app = create_app(adapter=WordsAdapter(), diarizer=FakeDiarizer(swap))
    r = TestClient(app).post("/transcribe", files={"file": ("a.wav", b"RIFFxxxx", "audio/wav")})
    assert r.status_code == 200
    j = r.json()
    flags = [w.get("possible_label_swap") for w in j["words"]]
    assert flags == ([False, False, True, False] if swap else [False, False, False, False])
    d = j["settings"]["diarization"]["label_swap"]
    assert d["turns_checked"] == 6 and d["turns_flagged"] == (1 if swap else 0)
    if swap:
        assert d["flagged"][0]["label"] == "B" and d["flagged"][0]["nearest"] == "A"


def test_detection_is_skipped_for_a_diarizer_without_embeddings():
    class NoEmb(FakeDiarizer):
        turn_embeddings = None  # type: ignore

    app = create_app(adapter=WordsAdapter(), diarizer=NoEmb(False))
    j = TestClient(app).post("/transcribe", files={"file": ("a.wav", b"RIFFxxxx", "audio/wav")}).json()
    assert "possible_label_swap" not in j["words"][0]
    assert j["settings"]["diarization"]["label_swap"] == {"enabled": False, "reason": "this diarizer provides no turn embeddings"}


def test_settings_come_from_env_and_are_validated():
    assert SwapSettings.from_env({}) == SwapSettings(margin=0.05, min_turn_us=1_500_000, enabled=True)
    assert SwapSettings.from_env({"DIARIZATION_SWAP_MARGIN": "0.1", "DIARIZATION_SWAP_MIN_TURN_S": "2", "DIARIZATION_SWAP_DETECTION": "false"}) == SwapSettings(margin=0.1, min_turn_us=2_000_000, enabled=False)
    with pytest.raises(ValueError):
        SwapSettings.from_env({"DIARIZATION_SWAP_MARGIN": "-1"})
    with pytest.raises(ValueError):
        SwapSettings.from_env({"DIARIZATION_SWAP_DETECTION": "maybe"})
