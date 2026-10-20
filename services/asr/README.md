# services/asr

FastAPI service: `POST /transcribe` (multipart `file`; query `initial_prompt`, `vad_filter`, `diarize`), `GET /health`.
Words come back with integer microseconds, integer permille confidence and, when diarization ran, `speaker`, `speaker_uncertain`, `overlaps_speech`.

## Settings (env, all listed in `/.env.example`)
| Variable | Default | Meaning |
|---|---|---|
| `ASR_ADAPTER` | `mock` | `mock` (fixture transcript, tests) or `faster-whisper` |
| `ASR_MODEL` | `base.en` | faster-whisper model name (`tiny.en`, `base.en`, `small.en`, ...) |
| `WHISPER_COMPUTE_TYPE` | `int8` | CTranslate2 compute type |
| `DIARIZATION_PROVIDER` | `none` in the service, `mock` in `.env.example` | `sherpa` (real) / `mock` / `none` |
| `DIARIZATION_MODEL_DIR` | `/models/diarization` | where the two ONNX files live |
| `DIARIZATION_NUM_SPEAKERS` | `-1` | fixed speaker count, `-1` = clustering decides |
| `DIARIZATION_CLUSTER_THRESHOLD` | `0.5` | clustering distance threshold when the count is `-1` |
| `DIARIZATION_UNCERTAIN_BELOW` | `0.6` | `speaker_uncertain` when the winning speaker covers less than this fraction of the word |
| `DIARIZATION_OVERLAP_MIN_FRACTION` | `0.2` | `overlaps_speech` when a second speaker covers at least this fraction of the word |

sherpa-onnx has no min/max speaker setting, so none is exposed.

## Where the models come from
`fetch_models.py` runs **at image build time** (see `Dockerfile`):
- Whisper `ASR_MODEL` (build arg, default `base.en`, about 148 MB download, 142 MB on disk) via `faster_whisper.utils.download_model` into `HF_HOME=/models/hf`.
- WeSpeaker ResNet34 ONNX (26.5 MB) and pyannote segmentation-3.0 ONNX tarball (7.0 MB; `model.onnx` 6.0 MB) from the sherpa-onnx GitHub release, **sha256-checked**, into `/models/diarization`.
The container needs no network at run time for these. Running with a different `ASR_MODEL` (not baked in) downloads it on first use into `/models/hf`; mount a volume on `/models` to keep it. Rebuild with `--build-arg ASR_MODEL=small.en` to bake another one.

## base.en vs small.en
Both were run on one real public-domain clip and one synthetic clip (`docs/SPIKE_ASR.md`). **Which is better on real speech is NOT proven**: there is no hand-labelled reference transcript. base.en is the default because it is about 2.5x faster (RTF 0.21 vs 0.51 on 4 CPUs), not because it is more accurate.

## Tests
`python -m pytest` (mock adapters only, no model loaded). `docker compose run --rm tests` runs them through the `asr-tests` service first. `tests/test_fwhisper_integration.py` and `tests/test_sherpa_integration.py` are skipped unless `ASR_TEST_AUDIO` / `DIARIZATION_TEST_AUDIO` is set.
