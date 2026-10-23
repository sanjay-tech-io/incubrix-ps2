#!/bin/sh
# Builds the two-voice host/guest test clip from scripts/dialogue_script.txt with espeak-ng (two different voices:
# host en-us, guest en-gb-x-rp+f3). AI-generated (synthetic) speech, listed in SOURCES.md. Nothing generated is committed.
# Usage: scripts/make_dialogue_clip.sh OUT.mp4 OUT_TRUTH.json     (video: ffmpeg testsrc2 640x360 25 fps; audio: 16 kHz mono AAC)
# The truth file lists each line's speaker, start/end in seconds and text, known by construction (0.6 s of silence between lines).
set -e
here=$(dirname "$0")
tmp=$(mktemp -d)
i=0
: > "$tmp/list.txt"
printf '[' > "$2"
t=0
sep=""
ffmpeg -v error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 0.6 "$tmp/gap.wav"
while IFS='|' read -r who text; do
  i=$((i+1))
  case "$who" in A) voice="en-us" ;; B) voice="en-gb-x-rp+f3" ;; esac
  espeak-ng -v "$voice" -s 150 "$text" -w "$tmp/raw$i.wav"
  ffmpeg -v error -y -i "$tmp/raw$i.wav" -ac 1 -ar 16000 "$tmp/l$i.wav"
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$tmp/l$i.wav")
  end=$(awk "BEGIN{printf \"%.3f\", $t+$d}")
  printf '%s{"speaker":"%s","start_s":%s,"end_s":%s,"text":"%s"}' "$sep" "$who" "$t" "$end" "$text" >> "$2"
  sep=","
  echo "file '$tmp/l$i.wav'" >> "$tmp/list.txt"
  echo "file '$tmp/gap.wav'" >> "$tmp/list.txt"
  t=$(awk "BEGIN{printf \"%.3f\", $end+0.6}")
done < "$here/dialogue_script.txt"
printf ']\n' >> "$2"
ffmpeg -v error -y -f concat -safe 0 -i "$tmp/list.txt" -ac 1 -ar 16000 "$tmp/all.wav"
d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$tmp/all.wav")
ffmpeg -v error -y -f lavfi -i "testsrc2=size=640x360:rate=25" -i "$tmp/all.wav" -t "$d" -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 96k "$1"
cp "$tmp/all.wav" "${1%.mp4}.wav"
rm -rf "$tmp"
