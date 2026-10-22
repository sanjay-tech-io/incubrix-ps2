import json
from typing import Optional

import opentimelineio as otio
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from otio_service.build import build_timeline, inspect_timeline


def error(status: int, code: str, message: str, details: Optional[dict] = None) -> JSONResponse:
    # Same error envelope as the rest of the system (CLAUDE.md).
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "retryable": False, "details": details or {}}})


class Rational(BaseModel):
    model_config = ConfigDict(extra="forbid")
    num: int = Field(gt=0)
    den: int = Field(gt=0)


class Source(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    sha256: str
    duration_units: int = Field(ge=0)
    has_video: bool
    has_audio: bool


class Clip(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    src_start: int = Field(ge=0)
    out_duration: int = Field(ge=0)
    speed: Rational
    src_start_us: int = Field(ge=0)
    src_end_us: int = Field(ge=0)


class Marker(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    start: int = Field(ge=0)
    duration: int = Field(ge=0)
    color: Optional[str] = None
    kind: str
    text: Optional[str] = None
    effect_id: Optional[str] = None
    detail: Optional[str] = None


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    rate: Optional[Rational] = None
    source: Source
    clips: list[Clip]
    markers: list[Marker]
    metadata: dict = {}


app = FastAPI(title="IncuBrix OpenTimelineIO export")


@app.exception_handler(RequestValidationError)
async def _validation(_req: Request, exc: RequestValidationError):
    return error(400, "VALIDATION_FAILED", "The request body is invalid.", {"issues": [{"path": ".".join(str(x) for x in e["loc"]), "message": e["msg"]} for e in exc.errors()]})


@app.get("/health")
def health():
    return {"status": "ok", "service": "otio", "opentimelineio": otio.__version__}


@app.get("/ready")
def ready():
    return {"status": "ready", "service": "otio"}


@app.post("/export")
def export(p: Payload):
    """Payload in, the text of an .otio file out (deterministic: the same payload gives the same bytes)."""
    text = otio.adapters.write_to_string(build_timeline(p.model_dump()), "otio_json")
    return Response(content=text, media_type="application/json")


@app.post("/inspect")
async def inspect(request: Request):
    """Read an .otio file with the library and report what a video editor would see (used by the tests)."""
    body = await request.body()
    try:
        tl = otio.adapters.read_from_string(body.decode("utf-8"), "otio_json")
        if not isinstance(tl, otio.schema.Timeline):
            raise ValueError("not a Timeline")
        return inspect_timeline(tl)
    except Exception as e:  # the library raises several exception types for bad input
        return error(400, "VALIDATION_FAILED", f"Not a readable .otio timeline: {str(e)[:200]}")
