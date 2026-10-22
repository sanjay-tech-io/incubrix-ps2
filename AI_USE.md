# AI use

Every AI tool used on this project. Only facts known from the repository and its history are written here; anything else is marked for the candidate to fill in.

| Tool | Used for | Where it shows |
|---|---|---|
| Claude Code (Anthropic CLI agent; the session model is named in each commit's `Co-Authored-By` trailer) | Writing and editing code, tests, scripts, Dockerfiles and documentation in this repository, and running the commands whose output is saved under `docs/raw/` and `docs/REVIEW_*.md`. | Commits with a `Co-Authored-By: Claude` trailer (`git log`); `docs/REVIEW_*.md`, `docs/SPIKE_ASR.md` |
| Claude chat (Anthropic) | Technical reviewer and planner: reviewing designs and review documents, planning milestones and writing task prompts for Claude Code. | Not recorded in the repository. Conversation exports: TO BE COMPLETED BY THE CANDIDATE |

## AI tools inside the product (runtime)
| Component | Purpose | AI-generated output? |
|---|---|---|
| faster-whisper (Whisper weights) | Speech to text with word timestamps | Transcripts are model output |
| sherpa-onnx + pyannote segmentation-3.0 + WeSpeaker | Speaker diarization | Speaker labels are model output |
| Gemini fallback (`LLM_PROVIDER=gemini` with a key; default `rules`; groq not built) | Translates an instruction the rules parser cannot read into a closed list of commands that our own code validates and applies | Operations that came from it are labelled in the answer and the manifest. Whether the final demo has a key: TO BE COMPLETED BY THE CANDIDATE |
| all-MiniLM-L6-v2 (ONNX, in `services/asr`) | Sentence embeddings for meaning-based search | Search scores are model output; the edit is only applied after the user chooses |
| WeSpeaker voice embeddings (same model as the diarization) | Possible speaker-label swap check (`services/asr/asr/swap.py`) | The `possibleLabelSwap` flag is model-derived; it only produces warnings, labels are never changed |

## AI-generated media
`synthetic.wav` and the two-voice diarization clip are speech synthesised by espeak-ng (a rule-based formant synthesiser, not a neural model). They are flagged "AI-generated: YES" in `SOURCES.md`.

## Not recorded
- Which exact Claude model versions were used across the whole history: TO BE COMPLETED BY THE CANDIDATE (the commit trailers record the model for commits that carry one).
- Prompts and conversation exports: TO BE COMPLETED BY THE CANDIDATE.
- What the candidate wrote by hand versus accepted from AI: TO BE COMPLETED BY THE CANDIDATE.
