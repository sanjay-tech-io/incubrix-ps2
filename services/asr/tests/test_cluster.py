"""num_speakers hint fallback: when the clustering library returns fewer speakers than the hint asks for, the turns are clustered
again from their voice embeddings into exactly that many groups. Pure arithmetic on vectors, tested with synthetic vectors."""
import math

from asr.cluster import apply_hint, cluster_turns
from asr.diarize import Turn

SEC = 1_000_000


def vec(angle_deg: float, wobble: float = 0.0):
    a = math.radians(angle_deg)
    v = [math.cos(a), math.sin(a), wobble * math.sin(angle_deg), wobble * math.cos(3 * angle_deg)]
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v]


def turns_for(spec):
    return [Turn(s * SEC, (s + 2) * SEC, "SPEAKER_00") for s, _ in spec]


def test_two_voices_become_exactly_two_speakers():
    spec = [(0, 0), (3, 80), (6, 4), (9, 85), (12, -3), (15, 78)]
    out = cluster_turns(turns_for(spec), [vec(a, 0.05) for _, a in spec], 2)
    assert [t.speaker for t in out] == ["SPEAKER_00", "SPEAKER_01", "SPEAKER_00", "SPEAKER_01", "SPEAKER_00", "SPEAKER_01"]
    assert [(t.start_us, t.end_us) for t in out] == [(t.start_us, t.end_us) for t in turns_for(spec)]  # only labels change


def test_three_voices_with_k_3_and_k_2():
    spec = [(0, 0), (3, 90), (6, 180), (9, 3), (12, 92), (15, 178)]
    e = [vec(a, 0.02) for _, a in spec]
    three = cluster_turns(turns_for(spec), e, 3)
    assert len({t.speaker for t in three}) == 3 and three[0].speaker == three[3].speaker and three[1].speaker == three[4].speaker and three[2].speaker == three[5].speaker
    two = cluster_turns(turns_for(spec), e, 2)
    assert len({t.speaker for t in two}) == 2


def test_labels_are_numbered_by_first_appearance_whatever_the_input_labels():
    spec = [(0, 90), (3, 0), (6, 92)]
    out = cluster_turns([Turn(0, SEC, "SPEAKER_07"), Turn(3 * SEC, 4 * SEC, "SPEAKER_02"), Turn(6 * SEC, 7 * SEC, "SPEAKER_07")], [vec(a) for _, a in spec], 2)
    assert [t.speaker for t in out] == ["SPEAKER_00", "SPEAKER_01", "SPEAKER_00"]


def test_a_turn_without_embedding_takes_the_label_of_the_nearest_embedded_turn_in_time():
    t = [Turn(0, 2 * SEC, "x"), Turn(3 * SEC, 3_400_000, "x"), Turn(8 * SEC, 10 * SEC, "x"), Turn(12 * SEC, 12_300_000, "x")]
    e = [vec(0), None, vec(90), None]
    out = cluster_turns(t, e, 2)
    assert [x.speaker for x in out] == ["SPEAKER_00", "SPEAKER_00", "SPEAKER_01", "SPEAKER_01"]


def test_cannot_split_when_fewer_embedded_turns_than_speakers_asked():
    t = [Turn(0, 2 * SEC, "SPEAKER_00"), Turn(3 * SEC, 5 * SEC, "SPEAKER_00")]
    assert cluster_turns(t, [vec(0), None], 2) == t


def test_k_1_gives_one_speaker_and_the_result_is_deterministic():
    spec = [(0, 0), (3, 80), (6, 4)]
    e = [vec(a, 0.05) for _, a in spec]
    assert {x.speaker for x in cluster_turns(turns_for(spec), e, 1)} == {"SPEAKER_00"}
    assert cluster_turns(turns_for(spec), e, 2) == cluster_turns(turns_for(spec), e, 2)


def test_apply_hint_only_acts_when_the_library_found_fewer_speakers_than_asked():
    spec = [(0, 0), (3, 80), (6, 4), (9, 85)]
    one_label = turns_for(spec)
    calls = []

    def embed(turns):
        calls.append(1)
        return [vec(a, 0.05) for _, a in spec]

    out, used = apply_hint(one_label, 2, embed)
    assert used is True and len({t.speaker for t in out}) == 2 and calls == [1]
    already = [Turn(t.start_us, t.end_us, "SPEAKER_0%d" % (i % 2)) for i, t in enumerate(one_label)]
    out2, used2 = apply_hint(already, 2, embed)
    assert used2 is False and out2 == already and calls == [1]  # no embedding work when the library already found 2
    out3, used3 = apply_hint(one_label, None, embed)
    assert used3 is False and out3 == one_label
    out4, used4 = apply_hint(one_label, 1, embed)
    assert used4 is False


def test_a_sliver_label_does_not_count_as_a_found_speaker():
    # sherpa answered the hint with a second label that holds 3% of the speech (the NASA clip: 9 s of 226 s). That is not a
    # second speaker, so the hint is still unmet and the turns are clustered again.
    spec = [(0, 0), (3, 80), (6, 4), (9, 85)]
    turns = [Turn(0, 40 * SEC, "SPEAKER_00"), Turn(41 * SEC, 80 * SEC, "SPEAKER_00"), Turn(81 * SEC, 120 * SEC, "SPEAKER_00"), Turn(121 * SEC, 124 * SEC, "SPEAKER_01")]
    out, used = apply_hint(turns, 2, lambda ts: [vec(a, 0.05) for _, a in spec])
    assert used is True
    assert [t.speaker for t in out] == ["SPEAKER_00", "SPEAKER_01", "SPEAKER_00", "SPEAKER_01"]
    # the same two labels with a real share (30% for the second) are accepted as they are
    fair = [Turn(0, 70 * SEC, "SPEAKER_00"), Turn(71 * SEC, 100 * SEC, "SPEAKER_01")]
    out2, used2 = apply_hint(fair, 2, lambda ts: [vec(0), vec(90)])
    assert used2 is False and out2 == fair
