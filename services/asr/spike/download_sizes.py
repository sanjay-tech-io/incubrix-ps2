"""Time a clean download of each model: deletes the model's cache dir first. Usage: download_sizes.py MODEL[,MODEL...]"""
import shutil
import sys
import time
from pathlib import Path

from faster_whisper.utils import download_model

hub = Path.home() / ".cache" / "huggingface" / "hub"
for m in sys.argv[1].split(","):
    d = hub / f"models--Systran--faster-whisper-{m}"
    shutil.rmtree(d, ignore_errors=True)
    t0 = time.perf_counter()
    path = Path(download_model(m))
    dt = time.perf_counter() - t0
    size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    print({"model": m, "download_s": round(dt, 1), "size_mb": round(size / 1e6, 1), "files": sorted(f.name for f in path.iterdir())})
