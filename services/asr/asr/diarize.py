"""Speaker assignment for words, plus the diarizer interface and its settings.

Why the assignment lives here and not in a diarizer: it is pure integer arithmetic on microseconds,
so the mock and the real (sherpa) diarizer share it and it is tested without any model.
"""
from dataclasses import dataclass
from typing import Mapping, Optional, Protocol

from asr.schema import Word


@dataclass(frozen=True)
class Turn:
    start_us: int
    end_us: int
    speaker: str


class Diarizer(Protocol):
    name: str

    def diarize(self, audio: bytes) -> list[Turn]: ...

    def describe(self) -> dict: ...


@dataclass(frozen=True)
class DiarizationSettings:
    # A word is speakerUncertain when the winning speaker covers less than this fraction of it.
    uncertain_below: float = 0.6
    # A word overlapsSpeech when a second speaker covers at least this fraction of it.
    overlap_min: float = 0.2
    num_speakers: int = -1  # -1 = let the clustering decide
    cluster_threshold: float = 0.5  # sherpa FastClustering distance threshold, used when num_speakers == -1

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "DiarizationSettings":
        def num(key: str, default: float) -> float:
            raw = env.get(key)
            return default if raw in (None, "") else float(raw)

        s = DiarizationSettings(
            uncertain_below=num("DIARIZATION_UNCERTAIN_BELOW", 0.6),
            overlap_min=num("DIARIZATION_OVERLAP_MIN_FRACTION", 0.2),
            num_speakers=int(num("DIARIZATION_NUM_SPEAKERS", -1)),
            cluster_threshold=num("DIARIZATION_CLUSTER_THRESHOLD", 0.5),
        )
        if not 0 < s.uncertain_below <= 1:
            raise ValueError("DIARIZATION_UNCERTAIN_BELOW must be in (0, 1]")
        if not 0 < s.overlap_min <= 1:
            raise ValueError("DIARIZATION_OVERLAP_MIN_FRACTION must be in (0, 1]")
        if s.num_speakers != -1 and s.num_speakers < 1:
            raise ValueError("DIARIZATION_NUM_SPEAKERS must be -1 (auto) or >= 1")
        if s.cluster_threshold <= 0:
            raise ValueError("DIARIZATION_CLUSTER_THRESHOLD must be > 0")
        return s


def _overlap(a0: int, a1: int, b0: int, b1: int) -> int:
    return max(0, min(a1, b1) - max(a0, b0))


def assign_speakers(words: list[Word], turns: list[Turn], s: DiarizationSettings) -> list[Word]:
    """Return copies of `words` with speaker, speaker_uncertain and overlaps_speech set.

    speaker = the speaker with the largest total overlap with the word (ties: smallest label).
    Turns of one speaker may overlap each other, so that speaker's covered time is the UNION of
    its turns, never the sum.
    """
    by_speaker: dict[str, list[tuple[int, int]]] = {}
    for t in turns:
        by_speaker.setdefault(t.speaker, []).append((t.start_us, t.end_us))

    out: list[Word] = []
    for w in words:
        # Zero-length words get a 1 us window so "inside a turn" still counts.
        dur = max(1, w.end_us - w.start_us)
        w0, w1 = w.start_us, max(w.end_us, w.start_us + 1)
        covered: dict[str, int] = {}
        for spk, spans in by_speaker.items():
            clipped = sorted((max(a, w0), min(b, w1)) for a, b in spans if _overlap(a, b, w0, w1) > 0)
            total, cur_end = 0, None
            for a, b in clipped:  # union length of the clipped spans
                if cur_end is None or a > cur_end:
                    total += b - a
                    cur_end = b
                elif b > cur_end:
                    total += b - cur_end
                    cur_end = b
            if total:
                covered[spk] = total
        ranked = sorted(covered.items(), key=lambda kv: (-kv[1], kv[0]))
        if not ranked:
            out.append(w.model_copy(update={"speaker": None, "speaker_uncertain": True, "overlaps_speech": False}))
            continue
        best, best_us = ranked[0]
        second_us = ranked[1][1] if len(ranked) > 1 else 0
        out.append(w.model_copy(update={
            "speaker": best,
            "speaker_uncertain": best_us / dur < s.uncertain_below,
            "overlaps_speech": second_us / dur >= s.overlap_min,
        }))
    return out
