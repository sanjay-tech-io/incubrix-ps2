"""Wire format of the ASR service.

Why integers: the engine's time is integer microseconds and confidence is integer permille
(CLAUDE.md rule 4). Floats never leave this service.
"""
from typing import Optional

from pydantic import BaseModel, model_validator


def to_us(seconds: float) -> int:
    return int(round(seconds * 1_000_000))


def permille(p: float) -> int:
    return max(0, min(1000, int(round(p * 1000))))


class Word(BaseModel):
    text: str
    start_us: int
    end_us: int
    confidence_permille: int
    speaker: Optional[str] = None
    # Set only when diarization ran. Wire names are snake_case; the engine's atoms call them
    # speakerUncertain / overlapsSpeech.
    speaker_uncertain: Optional[bool] = None
    overlaps_speech: Optional[bool] = None
    # Set when swap detection ran: the speaker label of this word's turn looks wrong (another speaker's voice is clearly closer).
    possible_label_swap: Optional[bool] = None

    @model_validator(mode="after")
    def _ordered(self):
        if self.end_us < self.start_us:
            raise ValueError("end_us before start_us")
        return self


class Transcript(BaseModel):
    adapter: str
    model: str
    language: Optional[str] = None
    duration_us: int
    words: list[Word]
    settings: dict = {}
    timings: dict = {}
