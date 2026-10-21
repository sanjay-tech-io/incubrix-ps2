from typing import Optional

from asr.diarize import Turn


class MockDiarizer:
    """Fixed two-speaker turns that fit asr/fixtures/transcript.json (4.5 s). For tests only."""

    name = "mock"

    def diarize(self, audio: bytes, num_speakers: Optional[int] = None) -> list[Turn]:
        if num_speakers == 1:
            return [Turn(0, 4_500_000, "SPEAKER_00")]
        return [Turn(0, 2_000_000, "SPEAKER_00"), Turn(2_000_000, 4_500_000, "SPEAKER_01")]

    def describe(self) -> dict:
        return {"provider": "mock"}
