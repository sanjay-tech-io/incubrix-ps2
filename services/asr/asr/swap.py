"""Possible speaker-label swap detection.

Diarization labels each turn with a speaker. Clustering can put a turn under the wrong label (two voices swapped for a stretch).
We check every turn against the voices of all speakers: embed the turn, compare with each speaker's centroid, and flag the
turn when another speaker's centroid is clearly closer than its own label's. Flagging only: the label is never changed
(CLAUDE.md rule 9: no guessing); the engine turns the flag into a warning on any edit that touches those words.

Pure arithmetic on plain Python lists (no numpy, no model), so it is tested with synthetic vectors.

Rules, chosen by me and validated on synthetic data only (docs/REVIEW_M5.md):
- A turn is judged only if it has an embedding and is at least `min_turn_us` long (short clips give noisy voice prints).
- Centroid of a speaker = mean of the unit-length embeddings of its judged turns, weighted by turn length.
- Own similarity uses the LEAVE-ONE-OUT centroid (the turn itself is left out, otherwise it would vouch for itself).
  A speaker with a single judged turn cannot be checked this way: the turn is reported as not testable.
- Flag when best_other_sim - own_sim > margin.
"""
import math
from dataclasses import dataclass
from typing import Mapping, Optional, Sequence

from asr.diarize import Turn
from asr.schema import Word

Vector = Sequence[float]


@dataclass(frozen=True)
class SwapSettings:
    margin: float = 0.05
    min_turn_us: int = 1_500_000
    enabled: bool = True

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "SwapSettings":
        def get(key: str, default: str) -> str:
            raw = env.get(key)
            return default if raw in (None, "") else raw

        raw_on = get("DIARIZATION_SWAP_DETECTION", "true").lower()
        if raw_on not in ("true", "false"):
            raise ValueError("DIARIZATION_SWAP_DETECTION must be true or false")
        s = SwapSettings(margin=float(get("DIARIZATION_SWAP_MARGIN", "0.05")), min_turn_us=round(float(get("DIARIZATION_SWAP_MIN_TURN_S", "1.5")) * 1_000_000), enabled=raw_on == "true")
        if not 0 <= s.margin < 2:
            raise ValueError("DIARIZATION_SWAP_MARGIN must be in [0, 2)")
        if s.min_turn_us < 0:
            raise ValueError("DIARIZATION_SWAP_MIN_TURN_S must be >= 0")
        return s


@dataclass(frozen=True)
class TurnCheck:
    index: int
    speaker: str
    testable: bool
    flagged: bool
    reason: str = ""
    nearest: Optional[str] = None
    own_sim: float = 0.0
    best_other_sim: float = 0.0


def _unit(v: Vector) -> list[float]:
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n > 0 else list(v)


def _dot(a: Vector, b: Vector) -> float:
    return sum(x * y for x, y in zip(a, b))


def _centroid(members: list[tuple[list[float], int]]) -> list[float]:
    dim = len(members[0][0])
    acc = [0.0] * dim
    for v, w in members:
        for k in range(dim):
            acc[k] += v[k] * w
    return _unit(acc)


def check_turns(turns: Sequence[Turn], embeddings: Sequence[Optional[Vector]], s: SwapSettings) -> list[TurnCheck]:
    judged: list[Optional[list[float]]] = []
    for t, e in zip(turns, embeddings):
        judged.append(_unit(e) if e is not None and t.end_us - t.start_us >= s.min_turn_us else None)

    by_speaker: dict[str, list[int]] = {}
    for i, v in enumerate(judged):
        if v is not None:
            by_speaker.setdefault(turns[i].speaker, []).append(i)

    def members(idx: list[int]) -> list[tuple[list[float], int]]:
        return [(judged[i], turns[i].end_us - turns[i].start_us) for i in idx]  # type: ignore[misc]

    centroids = {spk: _centroid(members(idx)) for spk, idx in by_speaker.items()}
    out: list[TurnCheck] = []
    for i, t in enumerate(turns):
        v = judged[i]
        if v is None:
            out.append(TurnCheck(i, t.speaker, False, False, reason="no embedding" if embeddings[i] is None else "turn too short to judge"))
            continue
        others = [spk for spk in centroids if spk != t.speaker]
        same = [j for j in by_speaker[t.speaker] if j != i]
        if not others:
            out.append(TurnCheck(i, t.speaker, False, False, reason="only one speaker has judged turns"))
            continue
        if not same:
            out.append(TurnCheck(i, t.speaker, False, False, reason="this speaker has only one judged turn, nothing to compare it with"))
            continue
        own = _dot(v, _centroid(members(same)))
        best_spk, best = max(((spk, _dot(v, centroids[spk])) for spk in sorted(others)), key=lambda kv: kv[1])
        out.append(TurnCheck(i, t.speaker, True, best - own > s.margin, nearest=best_spk if best > own else t.speaker, own_sim=own, best_other_sim=best))
    return out


def mark_swapped_words(words: list[Word], turns: Sequence[Turn], checks: Sequence[TurnCheck]) -> list[Word]:
    """Set possible_label_swap on every word: True when the turn of the word's own speaker that covers most of the word is flagged."""
    out: list[Word] = []
    for w in words:
        best, best_ov = None, 0
        for i, t in enumerate(turns):
            if t.speaker != w.speaker:
                continue
            ov = max(0, min(t.end_us, w.end_us) - max(t.start_us, w.start_us))
            if ov > best_ov:
                best, best_ov = i, ov
        out.append(w.model_copy(update={"possible_label_swap": bool(best is not None and checks[best].flagged)}))
    return out


def summarize(turns: Sequence[Turn], checks: Sequence[TurnCheck], s: SwapSettings) -> dict:
    return {
        "enabled": True,
        "margin": s.margin,
        "min_turn_s": s.min_turn_us / 1_000_000,
        "turns_checked": sum(1 for c in checks if c.testable),
        "turns_skipped": sum(1 for c in checks if not c.testable),
        "turns_flagged": sum(1 for c in checks if c.flagged),
        "flagged": [
            {"start_us": turns[c.index].start_us, "end_us": turns[c.index].end_us, "label": c.speaker, "nearest": c.nearest, "own_similarity": round(c.own_sim, 4), "other_similarity": round(c.best_other_sim, 4)}
            for c in checks if c.flagged
        ],
    }
