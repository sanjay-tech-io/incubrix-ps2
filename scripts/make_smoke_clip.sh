#!/bin/sh
# ~20 s AI-generated smoke-test video for the public deployment: espeak-ng speech (our own text) over an ffmpeg testsrc picture.
# Nothing generated is committed to git; see SOURCES.md. Usage: scripts/make_smoke_clip.sh OUT.mp4
set -e
out=$1
tmp=$(mktemp -d)
i=0
: > "$tmp/list.txt"
while IFS= read -r line; do
  i=$((i+1))
  espeak-ng -v en-us -s 150 "$line" -w "$tmp/raw$i.wav"
  ffmpeg -v error -y -i "$tmp/raw$i.wav" -ac 1 -ar 16000 "$tmp/l$i.wav"
  ffmpeg -v error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 0.8 "$tmp/g$i.wav"
  printf "file '%s'\nfile '%s'\n" "$tmp/l$i.wav" "$tmp/g$i.wav" >> "$tmp/list.txt"
done <<'TEXT'
Hello and welcome to this short smoke test.
The tool edits a video from plain sentences.
This second sentence is the one we will cut.
Thanks for watching and see you next time.
TEXT
ffmpeg -v error -y -f concat -safe 0 -i "$tmp/list.txt" -c copy "$tmp/speech.wav"
d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$tmp/speech.wav")
ffmpeg -v error -y -f lavfi -i "testsrc2=size=640x360:rate=25" -i "$tmp/speech.wav" -t "$d" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "$out"
rm -rf "$tmp"
