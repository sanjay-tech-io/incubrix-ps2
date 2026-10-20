import os
from typing import Optional

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

from asr.adapters.base import Adapter
from asr.schema import Transcript


def error(status: int, code: str, message: str, retryable: bool = False) -> JSONResponse:
    # Same error envelope as the rest of the system (CLAUDE.md).
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "retryable": retryable, "details": {}}})


def build_adapter(name: Optional[str] = None) -> Adapter:
    name = name or os.environ.get("ASR_ADAPTER", "mock")
    if name == "mock":
        from asr.adapters.mock import MockAdapter

        return MockAdapter()
    if name == "faster-whisper":
        from asr.adapters.fwhisper import FasterWhisperAdapter

        return FasterWhisperAdapter(
            model_size=os.environ.get("WHISPER_MODEL", "base.en"),
            compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
        )
    raise ValueError(f"unknown ASR_ADAPTER {name!r}")


def create_app(adapter: Optional[Adapter] = None) -> FastAPI:
    app = FastAPI(title="incubrix-asr")
    adp = adapter or build_adapter()

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "asr", "adapter": adp.name}

    @app.post("/transcribe", response_model=Transcript, response_model_exclude_none=True)
    async def transcribe(
        file: UploadFile = File(...),
        initial_prompt: Optional[str] = None,
        vad_filter: bool = True,
    ):
        audio = await file.read()
        if not audio:
            return error(400, "EMPTY_AUDIO", "uploaded file is empty")
        prompt = initial_prompt if initial_prompt is not None else (os.environ.get("WHISPER_INITIAL_PROMPT") or None)
        return adp.transcribe(audio, initial_prompt=prompt, vad_filter=vad_filter)

    return app


def app_factory() -> FastAPI:
    return create_app()
