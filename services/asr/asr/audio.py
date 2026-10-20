"""Decode any container PyAV/ffmpeg understands to 16 kHz mono float32 (what sherpa-onnx wants)."""
import io

import numpy as np


def decode_mono_16k(audio: bytes) -> np.ndarray:
    import av  # imported lazily so mock-only runs do not need the codec libraries

    chunks = []
    with av.open(io.BytesIO(audio)) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in container.decode(stream):
            for r in resampler.resample(frame):
                chunks.append(r.to_ndarray().reshape(-1))
        for r in resampler.resample(None):  # flush
            chunks.append(r.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0
