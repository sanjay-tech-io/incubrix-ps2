import io
import resource
import time
from typing import Optional

from asr.schema import Transcript, Word, permille, to_us


class FasterWhisperAdapter:
    """faster-whisper on CPU. The model is loaded lazily once and the load time is reported."""

    name = "faster-whisper"

    def __init__(self, model_size: str = "base.en", compute_type: str = "int8", cpu_threads: int = 0):
        self.model_size = model_size
        self.compute_type = compute_type
        self.cpu_threads = cpu_threads
        self._model = None
        self.load_s: Optional[float] = None

    def _load(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            t0 = time.perf_counter()
            self._model = WhisperModel(self.model_size, device="cpu", compute_type=self.compute_type, cpu_threads=self.cpu_threads)
            self.load_s = time.perf_counter() - t0
        return self._model

    def transcribe(self, audio: bytes, *, initial_prompt: Optional[str], vad_filter: bool) -> Transcript:
        model = self._load()
        t0 = time.perf_counter()
        # Why word_timestamps + vad: the engine needs per-word times, and VAD stops Whisper inventing
        # text over silence. condition_on_previous_text=False limits repetition loops on long audio.
        segments, info = model.transcribe(
            io.BytesIO(audio),
            word_timestamps=True,
            vad_filter=vad_filter,
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
            beam_size=5,
        )
        words: list[Word] = []
        for seg in segments:  # generator: decoding happens here, so it is inside the timed block
            for w in seg.words or []:
                s, e = to_us(w.start), to_us(w.end)
                words.append(Word(text=w.word.strip(), start_us=s, end_us=max(s, e), confidence_permille=permille(w.probability)))
        took = time.perf_counter() - t0
        return Transcript(
            adapter=self.name,
            model=self.model_size,
            language=info.language,
            duration_us=to_us(info.duration),
            words=words,
            settings={"compute_type": self.compute_type, "vad_filter": vad_filter, "initial_prompt": initial_prompt, "word_timestamps": True, "beam_size": 5},
            timings={
                "load_s": self.load_s,
                "transcribe_s": round(took, 3),
                "rtf": round(took / info.duration, 4) if info.duration else None,
                "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
            },
        )
