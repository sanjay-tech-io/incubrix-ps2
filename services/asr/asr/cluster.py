"""The num_speakers hint, made reliable.

sherpa-onnx's clustering takes a fixed number of clusters OR a distance threshold, and on some clips it ignores the count:
the scripted dialogue clip (two clearly different voices; their turn embeddings have cosine 0.95 within a speaker and 0.72
across) came back with ONE speaker for `num_clusters=2` (docs/TEST_MEDIA.md, docs/raw/m5d_diarization_sweep.jsonl). When a hint of
k >= 2 speakers comes back with fewer than k labels we cluster the turns again ourselves, from the same WeSpeaker turn
embeddings, into exactly k groups. Only labels change, never the turn times.

Method (chosen to be easy to explain): average-linkage agglomerative clustering on cosine distance (1 - cosine) between the
embedded turns; the closest pair of clusters is merged until k are left; ties go to the lowest index, so the result is the
same every run. A turn with no embedding (too short) takes the label of the embedded turn nearest to it in time (the earlier
one on a tie). Labels are renumbered SPEAKER_00, SPEAKER_01, ... in order of first appearance.

Pure arithmetic on plain lists, like asr/swap.py: tested with synthetic vectors, no model.
"""
import math
from typing import Callable, Optional, Sequence

from asr.diarize import Turn

Vector = Sequence[float]


def _cos(a: Vector, b: Vector) -> float:
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return sum(x * y for x, y in zip(a, b)) / (na * nb) if na > 0 and nb > 0 else 0.0


def cluster_turns(turns: Sequence[Turn], embeddings: Sequence[Optional[Vector]], k: int) -> list[Turn]:
    """Relabel `turns` into exactly k speakers from their embeddings; unchanged if fewer than k turns have an embedding."""
    idx = [i for i, e in enumerate(embeddings) if e is not None]
    if k < 1 or len(idx) < k:
        return list(turns)
    dist = {(a, b): 1.0 - _cos(embeddings[a], embeddings[b]) for a in idx for b in idx if a < b}  # type: ignore[arg-type]
    clusters: list[list[int]] = [[i] for i in idx]
    while len(clusters) > k:
        best: Optional[tuple[float, int, int]] = None
        for x in range(len(clusters)):
            for y in range(x + 1, len(clusters)):
                d = sum(dist[(min(a, b), max(a, b))] for a in clusters[x] for b in clusters[y]) / (len(clusters[x]) * len(clusters[y]))
                if best is None or d < best[0] - 1e-12:
                    best = (d, x, y)
        assert best is not None
        _, x, y = best
        clusters[x] = sorted(clusters[x] + clusters[y])
        del clusters[y]
    group = {i: g for g, members in enumerate(clusters) for i in members}
    raw: list[int] = []
    for i, t in enumerate(turns):
        if i in group:
            raw.append(group[i])
            continue
        mid = (t.start_us + t.end_us) / 2
        nearest = min(idx, key=lambda j: (abs((turns[j].start_us + turns[j].end_us) / 2 - mid), j))
        raw.append(group[nearest])
    names: dict[int, str] = {}
    for g in raw:
        names.setdefault(g, f"SPEAKER_{len(names):02d}")
    return [Turn(t.start_us, t.end_us, names[g]) for t, g in zip(turns, raw)]


MIN_SPEAKER_SHARE = 0.05  # a label holding less than this share of the speech is a sliver (a cough, a backchannel), not a speaker


def substantial_speakers(turns: Sequence[Turn]) -> int:
    """Labels that hold at least MIN_SPEAKER_SHARE of the diarized speech."""
    total = sum(t.end_us - t.start_us for t in turns)
    per: dict[str, int] = {}
    for t in turns:
        per[t.speaker] = per.get(t.speaker, 0) + (t.end_us - t.start_us)
    return sum(1 for v in per.values() if total > 0 and v / total >= MIN_SPEAKER_SHARE)


def apply_hint(turns: list[Turn], num_speakers: Optional[int], embed: Callable[[list[Turn]], Sequence[Optional[Vector]]]) -> tuple[list[Turn], bool]:
    """(turns, used): re-cluster only when the hint asks for 2+ speakers and fewer substantial speakers were found.

    "Found" counts only labels with at least 5% of the speech: on the NASA clip sherpa answered a 2-speaker hint with a second
    label of 9 s out of 226 s, no word got that label, and the edit said "only one speaker"."""
    if num_speakers is None or num_speakers < 2 or substantial_speakers(turns) >= num_speakers:
        return turns, False
    out = cluster_turns(turns, embed(turns), num_speakers)
    return out, out != turns
