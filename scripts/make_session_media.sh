#!/bin/sh
# Builds the generated media the sessions in sessions/ need besides media/test_single.mp4 (our own recording, not in git).
# All speech is espeak-ng (AI/synthetic, listed in SOURCES.md); the pictures are ffmpeg testsrc2. Nothing generated is committed.
#   media/two_speaker.mp4  host (en-us) + guest (en-gb-x-rp+f3), 8 lines, 25 fps
#   media/vfr_speech.mp4   a single voice, ~25 s, variable frame rate (about 30% of frames dropped at random, original timestamps kept)
#   media/no_audio.mp4     20 s picture, no audio track
# Usage: scripts/make_session_media.sh [OUTDIR=media]
set -e
out=${1:-media}
mkdir -p "$out"
tmp=$(mktemp -d)

speak() { # voice text outfile.wav
  espeak-ng -v "$1" -s 150 "$2" -w "$tmp/raw.wav"
  ffmpeg -v error -y -i "$tmp/raw.wav" -ac 1 -ar 16000 "$3"
}
build() { # listfile outwav
  ffmpeg -v error -y -f concat -safe 0 -i "$1" -ac 1 -ar 16000 "$2"
}

# --- two speakers ---
i=0; : > "$tmp/two.txt"
ffmpeg -v error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 0.6 "$tmp/gap.wav"
while IFS='|' read -r who text; do
  i=$((i+1))
  case "$who" in A) v="en-us" ;; B) v="en-gb-x-rp+f3" ;; esac
  speak "$v" "$text" "$tmp/two$i.wav"
  echo "file '$tmp/two$i.wav'" >> "$tmp/two.txt"
  echo "file '$tmp/gap.wav'" >> "$tmp/two.txt"
done <<'TEXT'
A|Welcome to the show. Today my guest is here to talk about careers.
A|So tell me about your old job.
B|My old job was in a factory and I worked there for ten years.
B|The old job was hard but I learned a lot.
A|What do you do now?
B|Now I build software and I love it.
A|Thanks for being here.
B|Thank you for having me.
TEXT
build "$tmp/two.txt" "$tmp/two.wav"
d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$tmp/two.wav")
ffmpeg -v error -y -f lavfi -i "testsrc2=size=640x360:rate=25" -i "$tmp/two.wav" -t "$d" -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 96k "$out/two_speaker.mp4"

# --- one voice, variable frame rate ---
i=0; : > "$tmp/one.txt"
while IFS= read -r text; do
  i=$((i+1))
  speak en-us "$text" "$tmp/one$i.wav"
  echo "file '$tmp/one$i.wav'" >> "$tmp/one.txt"
  echo "file '$tmp/gap.wav'" >> "$tmp/one.txt"
done <<'TEXT'
Hi everyone and thanks for watching.
This clip was filmed on a phone, so its frame rate is not constant.
Welcome to the channel.
Today I will cut a few parts and add a caption.
The pricing is simple and it is free for small teams.
Thanks and see you next time.
TEXT
build "$tmp/one.txt" "$tmp/one.wav"
d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$tmp/one.wav")
ffmpeg -v error -y -f lavfi -i "testsrc2=size=640x360:rate=30" -i "$tmp/one.wav" -t "$d" \
  -vf "select='gt(random(1),0.3)'" -fps_mode vfr -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 96k "$out/vfr_speech.mp4"

# --- no audio track ---
ffmpeg -v error -y -f lavfi -i "testsrc2=size=640x360:rate=25" -t 20 -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -an "$out/no_audio.mp4"
rm -rf "$tmp"
ls -la "$out"
