"""Benchmark faster-whisper model sizes on one clip. One fresh subprocess per model so peak RSS is per model.

Usage: python -I spike/bench_models.py AUDIO OUT.json MODEL[,MODEL...]
Reported per model: on-disk model size, load time (from local cache),
transcription time, real-time factor (transcribe_s / audio_s), peak RSS, word count.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def one(model: str, audio: str) -> None:
    sys.path.insert(0, str(ROOT))
    from asr.adapters.fwhisper import FasterWhisperAdapter

    a = FasterWhisperAdapter(model)
    t = a.transcribe(Path(audio).read_bytes(), initial_prompt=None, vad_filter=True)
    print("RESULT" + json.dumps({"words": len(t.words), "load_s": a.load_s, **t.timings, "audio_s": t.duration_us / 1e6}))


def cache_size(model: str) -> int:
    # Snapshot files are symlinks into blobs/, so stat() (which follows them) gives the real size.
    hub = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub"
    return sum(f.stat().st_size for d in hub.glob(f"models--Systran--faster-whisper-{model}") for f in (d / "snapshots").rglob("*") if f.is_file())


def main(audio: str, out: str, models: list[str]) -> None:
    rows = []
    for m in models:
        row = {"model": m}
        for label in ("run_1", "run_2"):
            t0 = time.perf_counter()
            p = subprocess.run([sys.executable, "-I", __file__, "--one", m, audio], capture_output=True, text=True)
            wall = time.perf_counter() - t0
            line = [l for l in p.stdout.splitlines() if l.startswith("RESULT")]
            if not line:
                row[label] = {"error": p.stderr[-500:]}
                break
            row[label] = {"wall_s": round(wall, 2), **json.loads(line[0][6:])}
        row["model_cache_mb"] = round(cache_size(m) / 1e6, 1)
        rows.append(row)
        print(json.dumps(row), flush=True)
    Path(out).write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    if sys.argv[1] == "--one":
        one(sys.argv[2], sys.argv[3])
    else:
        main(sys.argv[1], sys.argv[2], sys.argv[3].split(","))
