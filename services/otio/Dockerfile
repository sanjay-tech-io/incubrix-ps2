FROM python:3.12-slim AS base
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY otio_service ./otio_service

# Unit tests of the exporter (they read every exported file back with the library). Used by `docker compose run --rm tests`.
FROM base AS test
COPY requirements-dev.txt pytest.ini ./
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY tests ./tests
CMD ["python", "-m", "pytest", "-q"]

FROM base AS runtime
CMD ["uvicorn", "otio_service.server:app", "--host", "0.0.0.0", "--port", "8001"]
