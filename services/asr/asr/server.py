import os
from typing import Optional

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

from asr.adapters.base import Adapter
from asr.diarize import DiarizationSettings, Diarizer, assign_speakers
from asr.schema import Transcript


def error(status: int, code: str, message: str, retryable: bool = False) -> JSONResponse:
    # Same error envelope as the rest of the system (CLAUDE.md).
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "retryable": retryable, "details": {}}})


def build_adapter(name: Optional[str] = None) -> Adapter:
    # ASR_PROVIDER is the shared switch (same variable the Node services read); ASR_ADAPTER is the old name.
    name = name or os.environ.get("ASR_PROVIDER") or os.environ.get("ASR_ADAPTER", "mock")
    if name == "mock":
        from asr.adapters.mock import MockAdapter

        return MockAdapter()
    if name == "faster-whisper":
        from asr.adapters.fwhisper import FasterWhisperAdapter

        return FasterWhisperAdapter(
            model_size=os.environ.get("ASR_MODEL", "base.en"),
            compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
        )
    raise ValueError(f"unknown ASR_ADAPTER {name!r}")


def build_diarizer(name: Optional[str] = None, settings: Optional[DiarizationSettings] = None) -> Optional[Diarizer]:
    name = name or os.environ.get("DIARIZATION_PROVIDER", "none")
    if name == "none":
        return None
    if name == "mock":
        from asr.diarizers.mock import MockDiarizer

        return MockDiarizer()
    if name == "sherpa":
        from asr.diarizers.sherpa import SherpaDiarizer

        return SherpaDiarizer(os.environ.get("DIARIZATION_MODEL_DIR", "/models/diarization"), settings or DiarizationSettings.from_env(os.environ))
    raise ValueError(f"unknown DIARIZATION_PROVIDER {name!r} (sherpa | mock | none)")


def create_app(adapter: Optional[Adapter] = None, diarizer: Optional[Diarizer] = None) -> FastAPI:
    app = FastAPI(title="incubrix-asr")
    adp = adapter or build_adapter()
    dia_settings = DiarizationSettings.from_env(os.environ)
    # Passing an adapter (tests) without a diarizer means "no diarization", never "read the env".
    dia = diarizer if (adapter is not None or diarizer is not None) else build_diarizer(settings=dia_settings)

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "asr", "adapter": adp.name, "diarization": dia.name if dia else "none"}

    @app.post("/transcribe", response_model=Transcript, response_model_exclude_none=True)
    async def transcribe(
        file: UploadFile = File(...),
        initial_prompt: Optional[str] = None,
        vad_filter: bool = True,
        diarize: bool = True,
        num_speakers: Optional[int] = None,
    ):
        audio = await file.read()
        if not audio:
            return error(400, "EMPTY_AUDIO", "uploaded file is empty")
        prompt = initial_prompt if initial_prompt is not None else (os.environ.get("WHISPER_INITIAL_PROMPT") or None)
        t = adp.transcribe(audio, initial_prompt=prompt, vad_filter=vad_filter)
        if dia is not None and diarize:
            if num_speakers is not None and num_speakers < 1:
                return error(400, "BAD_NUM_SPEAKERS", "num_speakers must be >= 1")
            turns = dia.diarize(audio, num_speakers)
            t.words = assign_speakers(t.words, turns, dia_settings)
            t.settings["diarization"] = {**dia.describe(), "uncertain_below": dia_settings.uncertain_below, "overlap_min_fraction": dia_settings.overlap_min,
                                         "speakers_found": len({x.speaker for x in turns}), "turns": len(turns), "num_speakers_hint": num_speakers}
            t.timings["diarization"] = getattr(dia, "last_timings", {})
        return t

    return app


def app_factory() -> FastAPI:
    return create_app()
