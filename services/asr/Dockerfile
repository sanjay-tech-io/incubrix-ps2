FROM python:3.12-slim AS base
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Models live in /models (HF_HOME for Whisper, /models/diarization for the ONNX files).
# They are downloaded at BUILD time (sha256-checked) so the container needs no network at run time.
# A different ASR_MODEL at run time is downloaded on first use into /models (mount a volume to keep it).
ENV HF_HOME=/models/hf DIARIZATION_MODEL_DIR=/models/diarization EMBED_MODEL_DIR=/opt/embed EMBED_MODEL_REVISION=1110a243fdf4706b3f48f1d95db1a4f5529b4d41
ARG ASR_MODEL=base.en
COPY fetch_models.py .
RUN ASR_MODEL=$ASR_MODEL python fetch_models.py
COPY asr ./asr

# Mock-only unit tests (no model is loaded). Used by `docker compose run --rm tests`.
FROM base AS test
COPY requirements-dev.txt pytest.ini ./
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY tests ./tests
CMD ["python", "-m", "pytest", "-q"]

# Last stage = what `docker compose up` runs.
FROM base AS runtime
CMD ["uvicorn", "asr.server:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8000"]
