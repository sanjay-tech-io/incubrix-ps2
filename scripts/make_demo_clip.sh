#!/bin/sh
# Builds a ~1 minute AI-generated test video: espeak-ng speech (our own text below) over an ffmpeg testsrc picture.
# The intro ends before 30 s and a long pause is placed so that 0:30 falls inside it (the worked example cuts the first 30 seconds).
# "welcome to the channel" is said once after the pause and "pricing" 3 times after it. Nothing generated is committed to git; see SOURCES.md.
# Usage: scripts/make_demo_clip.sh OUT.mp4
set -e
out=$1
tmp=$(mktemp -d)
i=0
t=0
: > "$tmp/list.txt"
add_gap() {
  ffmpeg -v error -y -f lavfi -i anullsrc=r=16000:cl=mono -t "$1" "$tmp/g$i.wav"
  echo "file '$tmp/g$i.wav'" >> "$tmp/list.txt"
  t=$(awk "BEGIN{print $t+$1}")
}
while IFS= read -r line; do
  i=$((i+1))
  if [ "$line" = "---PAUSE---" ]; then
    # one long pause that covers 30.0 s exactly, so "cut the first 30 seconds" lands inside a silence
    gap=$(awk "BEGIN{printf \"%.3f\", 31.0-$t}")
    if ! awk "BEGIN{exit !($gap >= 0.8)}"; then echo "intro is $t s long; shorten it (needs to end before 30.2 s)" >&2; exit 1; fi
    add_gap "$gap"
    continue
  fi
  espeak-ng -v en-us -s 150 "$line" -w "$tmp/raw$i.wav"
  ffmpeg -v error -y -i "$tmp/raw$i.wav" -ac 1 -ar 16000 "$tmp/l$i.wav"
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$tmp/l$i.wav")
  echo "file '$tmp/l$i.wav'" >> "$tmp/list.txt"
  t=$(awk "BEGIN{print $t+$d}")
  add_gap 0.6
done <<'TEXT'
Hi everyone and thanks for watching.
Today I will show you how this editing tool works.
It is fast and it is simple to learn.
First we will look at the basic features.
You can import a video and edit it by typing.
Every edit is a plain sentence that you can undo.
Your original file is never changed.
---PAUSE---
Welcome to the channel.
Now let us talk about pricing.
The tool is free for personal projects.
Another thing is the music feature.
The pricing for teams is different.
Teams get extra storage and support.
Music gets quieter under your voice automatically.
One last word on pricing.
Thanks and see you next time.
TEXT
ffmpeg -v error -y -f concat -safe 0 -i "$tmp/list.txt" -ac 1 -ar 16000 "$tmp/speech.wav"
ffmpeg -v error -y -f lavfi -i "testsrc=size=320x240:rate=25" -i "$tmp/speech.wav" -shortest -c:v libx264 -preset ultrafast -crf 35 -pix_fmt yuv420p -c:a aac -b:a 64k "$out"
rm -rf "$tmp"
