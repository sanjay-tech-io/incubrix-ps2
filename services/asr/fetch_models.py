"""Build-time model download. Run by the Dockerfile; checks sha256 of the diarization files.

Why at build time: the demo must not depend on the network at first request, and the image then
carries exactly the models that were verified here.
"""
import hashlib
import os
import sys
import tarfile
import urllib.request

BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
# "recongition" is the upstream release tag's spelling, not ours.
EMBEDDING = (f"{BASE}/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx", "5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94")
SEGMENTATION = (f"{BASE}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488")


def fetch(url: str, sha: str, dest: str) -> None:
    urllib.request.urlretrieve(url, dest)
    got = hashlib.sha256(open(dest, "rb").read()).hexdigest()
    if got != sha:
        sys.exit(f"sha256 mismatch for {url}: expected {sha}, got {got}")


def main() -> None:
    out = os.environ.get("DIARIZATION_MODEL_DIR", "/models/diarization")
    os.makedirs(out, exist_ok=True)
    fetch(*EMBEDDING, os.path.join(out, "wespeaker_en_voxceleb_resnet34.onnx"))
    tar = os.path.join(out, "seg.tar.bz2")
    fetch(*SEGMENTATION, tar)
    with tarfile.open(tar) as t:
        t.extractall(out, filter="data")
    os.remove(tar)

    from faster_whisper.utils import download_model

    model = os.environ.get("ASR_MODEL", "base.en")
    print("whisper model downloaded to", download_model(model))


if __name__ == "__main__":
    main()
