import math
import os

import pytest
from fastapi.testclient import TestClient

from asr.adapters.mock import MockAdapter
from asr.embed import MockEmbedder
from asr.server import create_app


def client(emb=None) -> TestClient:
    return TestClient(create_app(MockAdapter(), None, emb))


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def test_embed_returns_unit_vectors_and_the_model_identity():
    r = client(MockEmbedder()).post("/embed", json={"texts": ["the pricing is simple", "what is the cost"]})
    assert r.status_code == 200
    b = r.json()
    assert b["model"] == "mock-bow" and b["version"] == "1" and b["dim"] == 64 and len(b["vectors"]) == 2
    assert all(abs(math.sqrt(dot(v, v)) - 1) < 1e-4 for v in b["vectors"])


def test_same_text_same_vector_and_related_text_is_closer():
    e = MockEmbedder()
    a, b, c = e.embed(["pricing", "the cost is low", "my dog is brown"])
    assert e.embed(["pricing"])[0] == a
    assert dot(a, b) > dot(a, c)


def test_no_embedder_is_a_structured_503_and_bad_input_a_400():
    assert client(None).post("/embed", json={"texts": ["x"]}).json()["error"]["code"] == "EMBED_UNAVAILABLE"
    assert client(MockEmbedder()).post("/embed", json={"texts": "x"}).status_code == 400


@pytest.mark.skipif(not os.path.exists(os.environ.get("EMBED_MODEL_DIR", "/opt/embed") + "/model.onnx"), reason="embedding model not in this image")
def test_real_model_pricing_is_closer_to_cost_than_to_weather_and_is_deterministic():
    from asr.embed import build_embedder

    e = build_embedder()
    q, near1, near2, far = e.embed(["pricing", "how much it costs per month", "the cost of each plan", "it rained all day in the mountains"])
    assert dot(q, near1) > dot(q, far) + 0.1 and dot(q, near2) > dot(q, far) + 0.1
    assert e.embed(["pricing"])[0] == q
