"""Diarization with sherpa-onnx (Apache-2.0 runtime) + pyannote segmentation-3.0 ONNX (MIT) + a speaker embedding model.

Usage: python -I spike/diarize_sherpa.py AUDIO.wav SEGMENTATION.onnx EMBEDDING.onnx OUT.json [NUM_SPEAKERS]
Prints and saves: speaker turns (integer microseconds), wall time, real-time factor, peak RSS.
"""
import json
import resource
import sys
import time
import wave

import numpy as np
import sherpa_onnx


def main(audio, seg, emb, out, num_speakers=-1):
    with wave.open(audio) as w:
        assert w.getnchannels() == 1 and w.getframerate() == 16000, "need 16 kHz mono wav"
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    dur = len(samples) / 16000
    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg), num_threads=4),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=4),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers, threshold=0.5),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    t0 = time.perf_counter()
    sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    load_s = time.perf_counter() - t0
    t0 = time.perf_counter()
    res = sd.process(samples).sort_by_start_time()
    took = time.perf_counter() - t0
    turns = [{"start_us": round(r.start * 1e6), "end_us": round(r.end * 1e6), "speaker": f"SPEAKER_{r.speaker:02d}"} for r in res]
    summary = {"audio_s": round(dur, 2), "load_s": round(load_s, 3), "process_s": round(took, 3), "rtf": round(took / dur, 4),
               "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
               "speakers": len({t["speaker"] for t in turns}), "turns": len(turns)}
    print(json.dumps(summary))
    open(out, "w").write(json.dumps({"summary": summary, "turns": turns}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]) if len(sys.argv) > 5 else -1)
