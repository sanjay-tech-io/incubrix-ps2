import json
from pathlib import Path
from typing import Optional

from asr.schema import Transcript, Word, permille, to_us

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "transcript.json"


class MockAdapter:
    """Returns a fixed transcript (with disfluencies) whatever the audio is. For tests only."""

    name = "mock"

    def transcribe(self, audio: bytes, *, initial_prompt: Optional[str], vad_filter: bool) -> Transcript:
        data = json.loads(FIXTURE.read_text())
        words = [Word(text=w["text"], start_us=to_us(w["start"]), end_us=to_us(w["end"]), confidence_permille=permille(w["p"])) for w in data["words"]]
        return Transcript(
            adapter="mock", model="fixture", language="en", duration_us=to_us(data["duration"]), words=words,
            settings={"initial_prompt": initial_prompt, "vad_filter": vad_filter},
        )
