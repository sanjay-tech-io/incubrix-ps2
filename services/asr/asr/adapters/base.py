from typing import Optional, Protocol

from asr.schema import Transcript


class Adapter(Protocol):
    name: str

    def transcribe(self, audio: bytes, *, initial_prompt: Optional[str], vad_filter: bool) -> Transcript: ...
