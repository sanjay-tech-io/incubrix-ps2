# AI use

Every AI tool used on this project. Facts below come from the repository, its git history and the files named. Where only the candidate knows the answer, the text says **TO BE COMPLETED BY THE CANDIDATE**. All such places are listed together at the end of the file.

## 1. AI tools used to build the project

| Tool | Used for | Where it shows |
|---|---|---|
| **Claude Code** (Anthropic's CLI coding agent), running in a terminal session on the project's GCP VM | Writing and editing code, tests, SQL migrations, Dockerfiles, compose files, scripts and documentation in this repository. Running the commands whose output is saved under `docs/raw/`, `test-pack/` and quoted in `docs/REVIEW_*.md`: tests, docker compose, ffmpeg renders, real ASR and diarization runs, batch runs, deployment (Caddy, secret rotation), and measurements. Also wrote the submission documents of M6b: `docs/SUBMISSION_EVIDENCE.md`, `REPORT.md`, `docs/TIMELINE_SCHEMA.md`, `test-pack/INDEX.md`, this file and `docs/DEMO_VIDEO_SCRIPT.md` | `git log`: 112 of the first 118 commits (those before the M6b documents) carry the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. The trailer is the only model name recorded in git. `docs/REVIEW_*.md`, `docs/STATUS.md`, `docs/SPIKE_ASR.md` and `docs/raw/*` were written by it |
| **Claude chat** (Anthropic), used outside the repository | Reviewer and planner: reviewing the design and review documents, planning milestones, and writing the task prompts that were given to Claude Code. The review documents refer to its feedback ("the reviewer's list", the rules and approvals the candidate passed on) | Not recorded in the repository. Which model, how many conversations, exports: **TO BE COMPLETED BY THE CANDIDATE** |
| **Gemini API** (`gemini-3.5-flash-lite`), called by Claude Code during development | The development runs of the runtime fallback below: latency probe, 3 session runs, about 14 requests in M4 (`docs/REVIEW_M4.md` section 5). The key was set by the candidate in `.env`, which is not committed | `docs/raw/m4_llm_*`; tokens and the cost estimate are in the manifests |

### What the repository does and does not show about who wrote what
- 118 commits before the M6b documents, from 20 to 24 October 2026; every later commit carries the trailer too. Author names in git: `Sanjay J` and `sanjay-tech-io`.
- 6 of those 118 commits have **no** AI trailer: four merge commits (`14c6bca`, `8a58ef3`, `693dcde`, `d756d8d`) and two commits titled `gitignore` (`701d574`) and `docs` (`72c6c69`, the first commit). How those two were produced: **TO BE COMPLETED BY THE CANDIDATE**.
- Claude Code wrote most of the code and all review documents. The review documents record where it did not work test-first (nlu, worker, API, embedding service, render code were written together with their tests and then run and fixed: `docs/REVIEW_M2.md` section 6, `docs/REVIEW_M3.md` section 9, `docs/REVIEW_M4.md` section 7).
- The recording `media/test_single.mp4` is the candidate's own (`SOURCES.md`).
- What the candidate wrote by hand versus accepted from AI, and how much of the code the candidate has read and can explain: **TO BE COMPLETED BY THE CANDIDATE**.

### Mistakes made by the AI agent in this project (all recorded where they were found)
- Ran `docker compose up` without the production file: ports 8080 and 8333 were published for about 10 minutes (`docs/DEPLOY.md`).
- `docker compose run tests` and an `.env` change restarted the live demo's services (`docs/REVIEW_M5.md` section 8.3, `docs/TEST_MEDIA.md` section 5).
- Printed the old API token and a database URL into its own terminal output once; both secrets were later rotated (`docs/DEPLOY.md`, `docs/raw/m5d_token_rotation.txt`).
- Hid `packages/media/` from git with an over-broad `.gitignore` line, so a fresh clone could not run for a few milestones (`docs/raw/m5_ci_simulation_run1_failed.txt`).
- Wrote five wrong test expectations (`docs/REVIEW_M5.md` section 4) and killed its own shell twice with `pkill -f` (`docs/REVIEW_M3.md` section 8).

## 2. AI inside the product (runtime)

| Component | Purpose | AI-generated output? | Default? |
|---|---|---|---|
| faster-whisper (Whisper `base.en` weights, MIT) | Speech to text with word timestamps | Transcript words are model output; flagged `transcript_words: true` in manifests | yes |
| sherpa-onnx with pyannote segmentation-3.0 and WeSpeaker ResNet34 | Speaker diarization | Speaker labels are model output | yes |
| Gemini fallback (`LLM_PROVIDER=gemini`, model `gemini-3.5-flash-lite`) | Translates an instruction the rules parser cannot read into a closed list of commands that our own code validates and applies. Only the instruction text and a small timeline summary are sent (no transcript, no media). Temperature 0, cached in `llm_cache` | Operations that came from it are labelled in the answer and the manifest. It never edits the timeline itself | **No.** The default is `rules`; it is on only when `LLM_PROVIDER=gemini` and a key are set. Whether the live demo has a key now: **TO BE COMPLETED BY THE CANDIDATE** |
| all-MiniLM-L6-v2 (ONNX, Apache-2.0 per its card) | Sentence embeddings for meaning-based search | Scores are model output. The edit is applied only after the user chooses | yes |
| WeSpeaker voice embeddings (same model as diarization) | Possible speaker-label swap check | The `possibleLabelSwap` flag is model-derived and only produces warnings | yes |
| Groq | Named in the brief's adapter list | **Not built.** `LLM_PROVIDER=groq` fails at startup with a message | no |

Licence and training-data status of each model is in `SOURCES.md` (training-data licences were not checked for any model).

**Gemini terms and tier.** On the free tier Google may use submitted content to improve its products and humans may read it; on the paid tier it does not (`SOURCES.md`, `docs/licence-evidence/gemini-api-terms-excerpts.txt`). The agent does not know which tier the candidate's key belongs to, so it cannot say whether the instruction texts sent during development were used by Google. Tier: **TO BE COMPLETED BY THE CANDIDATE**.

## 3. AI-generated media and outputs
- Speech in the generated test clips is synthesised by espeak-ng (a rule-based formant synthesiser, not a neural model). The clips are flagged "AI-generated: YES" in `SOURCES.md`: `synthetic.wav`, `two_voice.wav`, `demo.mp4`, the dialogue clip, `two_speaker.mp4`, `vfr_speech.mp4`, the smoke clips and the API test clips.
- The built-in background music is computed by arithmetic (four sine waves); it is not made by an AI model (`ai_generated.music=false` in manifests).
- Captions typed by the user are user text. Auto-captions are built from transcript words, which are model output.
- Every render and instruction manifest has an `ai_generated` block (`transcript_words`, `llm_used`, `music`, `input_media_marked_ai_generated`); example: `test-pack/real/batch_720p_m5e/worked_example_real/render_1_manifest.json`.

## 4. Prompts and conversations
- Claude Code session transcripts and the Claude chat conversations are not stored in this repository. If the submission needs them: **TO BE COMPLETED BY THE CANDIDATE** (export and attach, or state why not).
- The task prompts that shaped the work are quoted in part in `docs/REVIEW_*.md` and in the project instructions `CLAUDE.md`, which the agent reads at the start of each session.

## 5. Places the candidate must complete
1. Claude chat: model(s) used, number of conversations, export or screenshot, and what it was asked to review (section 1).
2. How the two commits without an AI trailer (`701d574` `gitignore`, `72c6c69` `docs`) were produced (section 1).
3. Which Claude Code model versions were used across the whole history. Git records `Claude Sonnet 5.5` on 112 of the 118 commits and nothing else; confirm that no other model was used before the trailer was added (section 1).
4. What was written by hand and what was accepted from AI, and the candidate's own statement that they can explain and change the code live (section 1).
5. Whether the live demo has a Gemini key set, and which Gemini tier (free or paid) the key belongs to (section 2).
6. Export or location of the prompts and conversations (section 4).
