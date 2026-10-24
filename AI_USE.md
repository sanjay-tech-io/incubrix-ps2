# AI_USE.md — How I used AI in this assessment

The brief allows any AI tool as long as it is disclosed, so this file says plainly which tools I used, what each one did, and what I did myself. I am a college student, and this is the biggest system I have built. I used AI heavily, and I want to be honest about where.

## 1. Tools I used

| Tool | Where it ran | What I used it for |
|---|---|---|
| **Claude Code** (Anthropic) | First on my laptop (VS Code), then on my GCP VM (Debian, e2-standard-4) inside tmux | Wrote most of the code, tests, Docker setup, scripts and documentation in this repository. It also ran the commands whose output is saved under `docs/raw/`, `test-pack/` and quoted in `docs/REVIEW_*.md` (tests, docker compose, ffmpeg renders, real ASR and diarization runs, batch runs, deployment, measurements), and wrote the M6b submission documents (`docs/SUBMISSION_EVIDENCE.md`, `REPORT.md`, `docs/TIMELINE_SCHEMA.md`, `test-pack/INDEX.md`, this file's first draft, `docs/DEMO_VIDEO_SCRIPT.md`). In git, 112 of the first 118 commits (those before the M6b documents) carry the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; that trailer is the only model name recorded in git. Six of the 118 have no trailer: four merge commits (`14c6bca`, `8a58ef3`, `693dcde`, `d756d8d`) and two commits titled `gitignore` (`701d574`) and `docs` (`72c6c69`, the first commit). Author names in git: `Sanjay J` and `sanjay-tech-io` |
| **Claude chat** (claude.ai) | Browser | Planner and reviewer (the model and number of conversations are not recorded in the repository): split the work into milestones, wrote the prompts I gave to Claude Code, and reviewed its results from my screenshots |
| **Gemini 3.5 Flash Lite** (Google, API; model id `gemini-3.5-flash-lite`) | Inside the running service, and called by Claude Code in development (latency probe, 3 session runs, about 14 requests in M4: `docs/REVIEW_M4.md` section 5, `docs/raw/m4_llm_*`) | Runtime fallback only: turns an instruction into structured operations when the rules parser cannot understand it (details in section 4) |
| **Speech synthesis (TTS)** | Test media only | Synthetic speech clips used in tests, marked AI-generated in `SOURCES.md`. The synthesiser is espeak-ng (rule-based formant, not a neural model). Clips: `synthetic.wav`, `two_voice.wav`, `demo.mp4`, the dialogue clip, `two_speaker.mp4`, `vfr_speech.mp4`, the smoke clips and the API test clips. The built-in background music is computed from four sine waves, not made by an AI model |

No AI tool was used to generate the real test video. I recorded `media/test_single.mp4` myself (`SOURCES.md`).

## 2. How the work actually went

I worked in milestones (M1 engine, M2 API, M3 rendering, M4 advanced features, M5 outstanding items, M6 deploy and documents, plus two infra passes). Each milestone went like this:

1. I asked Claude chat what to do next. It wrote a prompt with clear rules: tests first, small commits, never claim anything that was not run, and stop for my approval before big design decisions.
2. I pasted the prompt into Claude Code on the VM.
3. Claude Code wrote a short design first (for example `docs/API_DESIGN.md` and `docs/RENDER_DESIGN.md`) and stopped. I read it, sent it to Claude chat for a second opinion, and then approved it or asked for changes.
4. Claude Code built it, ran the tests and wrote a review file (`docs/REVIEW_*.md`) with raw outputs.
5. I read the summary, sent screenshots to Claude chat, and decided what to fix next. Then I pushed to GitHub.

So the code is mostly AI-written, but the order of work, the approvals and the "is this good enough" decisions went through me.

## 3. What I did myself

- **Infrastructure:** created the GCP VM, grew the disk, reserved the static IP, added the firewall rule for ports 80/443, set up SSH keys and GitHub access, installed Node, Docker and tmux.
- **Git:** pushed every milestone, merged branches, and fixed a merge conflict in `.gitignore`.
- **Secrets:** created `.env` on the VM myself (Gemini key, model name) and kept it out of git. I asked for secrets to be rotated when they leaked: the S3 keys, the database password and the API token. One token leaked because I pasted it into a chat by mistake, and I rotated it.
- **Test media:** recorded my own single-speaker test video. It does not follow the brief's script word for word ("welcome to our channel", "pricing" said 7 times). I decided not to re-record it because of time, and I asked for every deviation to be documented instead of hidden (`docs/TEST_MEDIA.md`, `docs/WORKED_EXAMPLE_REAL.md`).
- **Design decisions I approved or changed** (with Claude chat's review), for example:
  - Keep the transcript cache key tied to the model and settings, not only the file hash.
  - Check HDR/10-bit phone video and convert it in a separate proxy, never touching the original.
  - Run the tests in a separate Docker stack so they never restart the live demo.
  - When the AI changed a test's expected result, ask it to justify each change with a sentence from the brief, or revert it.
  - Allow uploads up to 2 GB on the public URL, since reviewers may upload their own phone videos.
- **Manual checks:** opened the live demo in my browser, tested `/health`, `/ready` and a job lookup in Swagger, and tested the `/pack/` download with its password.

## 4. Where AI runs inside the product

Only one place: **Gemini as a fallback parser.**

- The deterministic **rules parser** (code, no AI) runs first for every instruction.
- Only if it cannot understand the instruction is Gemini asked to translate the words into the structured-operation JSON.
- Gemini never edits the timeline. Its output is checked with a schema (zod), and anything invalid is rejected with a reason. All timeline logic is ordinary code.
- Only the instruction text and a small timeline summary are sent (no transcript, no media). Gemini is off by default: the default `LLM_PROVIDER` is `rules`, and it is used only when `LLM_PROVIDER=gemini` and a key are set. `LLM_PROVIDER=groq` is named in the brief's adapter list but was not built; it fails at startup with a message.
- Calls use temperature 0 and are cached (table `llm_cache`), and operations that came from Gemini are labelled in the answer and the manifest, so replaying a session gives the same `timeline_hash` without calling Gemini again.
- Tests use a mock instead of Gemini, so they need no API key.

Other models in the product, none of them chat AI:

| Component | Purpose | Model output in the result |
|---|---|---|
| faster-whisper (Whisper `base.en` weights, MIT) | Speech to text with word timestamps | The transcript words (`transcript_words: true` in manifests) |
| sherpa-onnx with pyannote segmentation-3.0 and WeSpeaker ResNet34 | Speaker diarization | The speaker labels |
| all-MiniLM-L6-v2 (ONNX) | Sentence embeddings for meaning-based search | Scores; an edit is applied only after the user chooses |
| WeSpeaker voice embeddings | Possible speaker-label swap check | The `possibleLabelSwap` flag; it only produces warnings |

They are listed with their licences in `SOURCES.md` (training-data licences were not checked for any model). Every render and instruction manifest has an `ai_generated` block (`transcript_words`, `llm_used`, `music`, `input_media_marked_ai_generated`); example: `test-pack/real/batch_720p_m5e/worked_example_real/render_1_manifest.json`.

**Gemini terms.** On the free tier Google may use submitted content to improve its products and humans may read it; on the paid tier it does not (`SOURCES.md`, `docs/licence-evidence/gemini-api-terms-excerpts.txt`). Which tier my key belongs to is not recorded in the repository.

## 5. Mistakes AI made that we caught

Being honest about this matters to me, so here are real examples from the review files:

- Claude Code once had "delete the remote infra branch" typed in its input line. I did not run it.
- It exposed the database and storage ports to the internet for about 10 minutes during the first deploy, then found and closed it.
- It printed secrets into the terminal a few times. Each time I asked for them to be rotated. Recorded cases: the old API token and a database URL (`docs/DEPLOY.md`, `docs/raw/m5d_token_rotation.txt`), and on 2026-10-24 the current database password, from `docker compose config | grep` (`docs/DEPLOY.md`, "Session pack download"; not in any file or commit, not rotated at the time of writing).
- It wrote some tests in the same step as the code instead of strictly tests-first, and said so in its reports.
- Its first scenario expectations were partly wrong. Every change is listed with a reason in `docs/REVIEW_M5.md`, section 8 (five wrong expectations are also in section 4).
- Running the tests and changing `.env` restarted the live demo's services (`docs/REVIEW_M5.md` section 8.3, `docs/TEST_MEDIA.md` section 5).
- An over-broad `.gitignore` line hid `packages/media/` from git, so a fresh clone could not run for a few milestones (`docs/raw/m5_ci_simulation_run1_failed.txt`).
- It killed its own shell twice with `pkill -f` (`docs/REVIEW_M3.md` section 8).

## 6. What I learned

I learned that the hard part of this problem is not cutting video but keeping edits attached to the right words when edits pile up. That is why the timeline uses word and silence "atoms" instead of seconds. I also learned that AI-generated code needs someone checking it all the time: reading the designs, asking for proof, and not trusting a summary that says "done".

If I did it again, I would record the test video exactly to the script on day one, and I would run Claude Code inside tmux from the start. I lost time to SSH disconnects.

## 7. Prompts and conversation records

The milestone prompts I gave Claude Code are in my Claude chat history and in the Claude Code sessions on the VM. I can show them in the live session if asked. They are not stored in this repository; parts of them are quoted in `docs/REVIEW_*.md`, and the project rules the agent reads at the start of each session are in `CLAUDE.md`.
