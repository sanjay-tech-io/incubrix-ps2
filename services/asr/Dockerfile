FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY asr ./asr
# Models are downloaded on first use into /models (mount a volume to keep them).
ENV HF_HOME=/models ASR_ADAPTER=mock
CMD ["uvicorn", "asr.server:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8000"]
