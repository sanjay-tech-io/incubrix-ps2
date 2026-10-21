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


EMBED_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"


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

    # Meaning search model, pinned to one revision of the Hugging Face repo (Apache-2.0 per the model card). It goes to /opt/embed,
    # NOT /models: /models is a named volume that is filled once and would hide files added to the image later.
    from huggingface_hub import hf_hub_download

    revision = os.environ.get("EMBED_MODEL_REVISION", EMBED_REVISION)
    edir = os.environ.get("EMBED_MODEL_DIR", "/opt/embed")
    os.makedirs(edir, exist_ok=True)
    for remote, local in (("onnx/model.onnx", "model.onnx"), ("tokenizer.json", "tokenizer.json"), ("README.md", "MODEL_CARD.md")):
        src = hf_hub_download("sentence-transformers/all-MiniLM-L6-v2", remote, revision=revision)
        with open(src, "rb") as f, open(os.path.join(edir, local), "wb") as g:
            g.write(f.read())
    print("embedding model downloaded to", edir, "revision", revision)

    from faster_whisper.utils import download_model

    model = os.environ.get("ASR_MODEL", "base.en")
    print("whisper model downloaded to", download_model(model))


if __name__ == "__main__":
    main()
