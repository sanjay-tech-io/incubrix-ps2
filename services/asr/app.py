# PLACEHOLDER: replaced by the real ASR service in the next commit.
from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok", "service": "asr", "placeholder": True}
