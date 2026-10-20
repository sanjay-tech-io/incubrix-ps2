from fastapi.testclient import TestClient

from asr.adapters.mock import MockAdapter
from asr.server import create_app


def client() -> TestClient:
    return TestClient(create_app(MockAdapter()))


def test_health():
    r = client().get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_transcribe_returns_words_in_integer_microseconds():
    r = client().post("/transcribe", files={"file": ("a.wav", b"RIFFxxxx", "audio/wav")})
    assert r.status_code == 200
    body = r.json()
    w = body["words"][0]
    assert set(w) >= {"text", "start_us", "end_us", "confidence_permille"}
    assert isinstance(w["start_us"], int) and isinstance(w["confidence_permille"], int)
    assert "speaker" not in w  # optional, absent when no diarization ran
    assert body["settings"]["vad_filter"] is True


def test_empty_upload_is_a_structured_error():
    r = client().post("/transcribe", files={"file": ("a.wav", b"", "audio/wav")})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "EMPTY_AUDIO"


def test_initial_prompt_and_vad_are_passed_through():
    r = client().post("/transcribe?initial_prompt=Umm,%20okay&vad_filter=false", files={"file": ("a.wav", b"x", "audio/wav")})
    s = r.json()["settings"]
    assert s["initial_prompt"] == "Umm, okay"
    assert s["vad_filter"] is False
