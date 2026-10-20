"""Does an initial_prompt full of disfluencies make Whisper keep "um"/"uh"?

Usage: python -I spike/disfluency_test.py AUDIO OUT.json MODEL[,MODEL...]
Counts filler words in the transcript for 4 conditions (VAD on/off x prompt none/disfluent).
Counting is a regex over the transcribed words; on the synthetic clip the true count is known
(10, from spike/synthetic_script.txt); on real speech there is NO ground truth, only detected counts.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from asr.adapters.fwhisper import FasterWhisperAdapter  # noqa: E402

PROMPT = "Umm, let me think, like, hmm... okay, so, uh, here is what I think."
FILLER = re.compile(r"^(u+h*m+|u+h+|h+m+|m+h?m+|er+m*|ah+)$")


def norm(t: str) -> str:
    return re.sub(r"[^a-z]", "", t.lower())


def main(audio: str, out: str, models: list[str]) -> None:
    data = Path(audio).read_bytes()
    results = []
    for m in models:
        a = FasterWhisperAdapter(m)
        for vad in (True, False):
            for prompt in (None, PROMPT):
                t = a.transcribe(data, initial_prompt=prompt, vad_filter=vad)
                fillers = [(w.text, w.start_us) for w in t.words if FILLER.match(norm(w.text))]
                text = " ".join(w.text for w in t.words)
                results.append({
                    "model": m, "vad_filter": vad, "prompt": bool(prompt),
                    "words": len(t.words), "fillers": len(fillers), "filler_list": fillers,
                    "prompt_echoed": "let me think, like, hmm" in text.lower(),
                    "rtf": t.timings["rtf"], "text": text,
                })
                print(m, "vad" if vad else "novad", "prompt" if prompt else "plain", "words", len(t.words), "fillers", len(fillers), flush=True)
    Path(out).write_text(json.dumps({"audio": audio, "prompt": PROMPT, "results": results}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3].split(","))
