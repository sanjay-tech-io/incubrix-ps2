import os
import resource
from typing import Optional
import time

from asr.audio import decode_mono_16k
from asr.cluster import apply_hint
from asr.diarize import DiarizationSettings, Turn

SEGMENTATION_MODEL = "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"  # pyannote segmentation-3.0, ONNX export
EMBEDDING_MODEL = "wespeaker_en_voxceleb_resnet34.onnx"  # WeSpeaker ResNet34
HINT_MIN_TURN_US = 1_000_000  # turns at least this long get a voice embedding for the hint fallback (asr/cluster.py)


class SherpaDiarizer:
    """sherpa-onnx offline diarization: pyannote-3.0 segmentation + WeSpeaker embedding + fast clustering.

    The library accepts a fixed number of clusters OR a distance threshold. It has no min/max speaker
    setting, so DIARIZATION_NUM_SPEAKERS is the only speaker-count control we can honestly expose.
    """

    name = "sherpa"

    def __init__(self, model_dir: str, settings: DiarizationSettings, num_threads: int = 4):
        self.model_dir = model_dir
        self.settings = settings
        self.num_threads = num_threads
        self._sds: dict = {}  # one diarizer per requested speaker count (the count is part of its config)
        self.load_s = None
        self.last_timings: dict = {}
        self.last_hint_fallback = False  # True when the last call had to re-cluster to honour the num_speakers hint

    def _load(self, num_speakers: int):
        if num_speakers not in self._sds:
            import sherpa_onnx

            seg = os.path.join(self.model_dir, SEGMENTATION_MODEL)
            emb = os.path.join(self.model_dir, EMBEDDING_MODEL)
            for p in (seg, emb):
                if not os.path.exists(p):
                    raise FileNotFoundError(f"diarization model missing: {p} (set DIARIZATION_MODEL_DIR)")
            cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
                segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                    pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg), num_threads=self.num_threads),
                embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=self.num_threads),
                clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers, threshold=self.settings.cluster_threshold),
                min_duration_on=0.3,
                min_duration_off=0.5,
            )
            t0 = time.perf_counter()
            self._sds[num_speakers] = sherpa_onnx.OfflineSpeakerDiarization(cfg)
            self.load_s = round(time.perf_counter() - t0, 3)
        return self._sds[num_speakers]

    def diarize(self, audio: bytes, num_speakers: Optional[int] = None) -> list[Turn]:
        # A per-request count (the API's num_speakers hint) wins over DIARIZATION_NUM_SPEAKERS.
        sd = self._load(num_speakers if num_speakers is not None else self.settings.num_speakers)
        samples = decode_mono_16k(audio)
        t0 = time.perf_counter()
        result = sd.process(samples).sort_by_start_time()
        self.last_timings = {
            "load_s": self.load_s,
            "process_s": round(time.perf_counter() - t0, 3),
            "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        }
        turns = [Turn(round(r.start * 1_000_000), round(r.end * 1_000_000), f"SPEAKER_{r.speaker:02d}") for r in result]
        # The library sometimes ignores a requested count (the scripted dialogue clip came back with one speaker for 2). A hint of
        # 2+ speakers that comes back with fewer labels is honoured by clustering the turn embeddings ourselves (asr/cluster.py).
        hint = num_speakers if num_speakers is not None else (self.settings.num_speakers if self.settings.num_speakers >= 2 else None)
        turns, self.last_hint_fallback = apply_hint(turns, hint, lambda ts: self.turn_embeddings(audio, ts, HINT_MIN_TURN_US))
        return turns

    def _extractor(self):
        if getattr(self, "_emb", None) is None:
            import sherpa_onnx

            emb = os.path.join(self.model_dir, EMBEDDING_MODEL)
            self._emb = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=self.num_threads))
        return self._emb

    def turn_embeddings(self, audio: bytes, turns: list[Turn], min_turn_us: int) -> list:
        """One voice embedding (WeSpeaker, the same model the clustering used) per turn; None for turns shorter than min_turn_us.

        A turn where two people talk at once embeds a mix of both voices; that is one reason a flag is only a warning."""
        ex = self._extractor()
        samples = decode_mono_16k(audio)
        out: list = []
        for t in turns:
            if t.end_us - t.start_us < min_turn_us:
                out.append(None)
                continue
            seg = samples[int(t.start_us * 16_000 / 1_000_000) : int(t.end_us * 16_000 / 1_000_000)]
            stream = ex.create_stream()
            stream.accept_waveform(sample_rate=16_000, waveform=seg)
            stream.input_finished()
            out.append(list(ex.compute(stream)))
        return out

    def describe(self) -> dict:
        return {"provider": "sherpa", "segmentation": "pyannote-segmentation-3.0 (ONNX)", "embedding": "wespeaker_en_voxceleb_resnet34",
                "num_speakers": self.settings.num_speakers, "cluster_threshold": self.settings.cluster_threshold}
