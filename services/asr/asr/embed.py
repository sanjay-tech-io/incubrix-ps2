"""Sentence embeddings for meaning-based search ("pricing" also finds "cost").

Model: sentence-transformers/all-MiniLM-L6-v2 (Apache-2.0 per its model card), ONNX file run with onnxruntime on CPU, a fixed
revision (see fetch_models.py). One intra-op thread and no randomness, so the same text always gives the same vector on the same
machine. The vectors are L2-normalised, so cosine similarity is a dot product.
"""
import hashlib
import os
from typing import Protocol

import numpy as np

MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"
MAX_TOKENS = 128


class Embedder(Protocol):
    name: str
    model: str
    version: str
    dim: int

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class MiniLMEmbedder:
    name = "minilm-onnx"

    def __init__(self, model_dir: str, revision: str):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        path = os.path.join(model_dir, "model.onnx")
        so = ort.SessionOptions()
        so.intra_op_num_threads = 1  # deterministic summation order
        so.inter_op_num_threads = 1
        self._sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
        self._tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        self._tok.enable_truncation(max_length=MAX_TOKENS)
        self._tok.enable_padding(length=None)
        self.model = MODEL_ID
        sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
        self.version = f"{revision[:12]}+onnx-sha256:{sha[:12]}"
        self.dim = 384

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        enc = self._tok.encode_batch(texts)
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        names = {i.name for i in self._sess.get_inputs()}
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in names:
            feed["token_type_ids"] = np.zeros_like(ids)
        hidden = self._sess.run(None, feed)[0]  # [batch, tokens, 384]
        m = mask[..., None].astype(np.float32)
        pooled = (hidden * m).sum(axis=1) / np.maximum(m.sum(axis=1), 1e-9)
        pooled /= np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-9)
        # 6 decimals keep the JSON small; the rounding is part of the (deterministic) definition of the vector
        return [[round(float(x), 6) for x in row] for row in pooled]


class MockEmbedder:
    """Tests only: a hashed bag of words with a tiny synonym table. NOT a model; it only makes 'cost' close to 'pricing'."""

    name = "mock"
    model = "mock-bow"
    version = "1"
    dim = 64
    SYN = {"price": "pricing", "prices": "pricing", "cost": "pricing", "costs": "pricing", "pay": "pricing", "plans": "pricing", "fee": "pricing", "subscription": "pricing"}

    def embed(self, texts: list[str]) -> list[list[float]]:
        out = []
        for t in texts:
            v = np.zeros(self.dim, dtype=np.float64)
            for w in "".join(c if c.isalnum() else " " for c in t.lower()).split():
                w = self.SYN.get(w, w)
                v[int(hashlib.sha256(w.encode()).hexdigest(), 16) % self.dim] += 1.0
            n = np.linalg.norm(v)
            out.append([round(float(x / n), 6) if n else 0.0 for x in v])
        return out


def build_embedder() -> "Embedder | None":
    name = os.environ.get("EMBED_PROVIDER", "minilm")
    if name == "none":
        return None
    if name == "mock":
        return MockEmbedder()
    return MiniLMEmbedder(os.environ.get("EMBED_MODEL_DIR", "/opt/embed"), os.environ.get("EMBED_MODEL_REVISION", "unknown"))
