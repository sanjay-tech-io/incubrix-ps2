#!/bin/sh
# Builds the AI-generated two-voice test clip with espeak-ng (two different voices) from two_voice_script.txt.
# Usage: make_two_voice.sh OUT.wav OUT_TRUTH.json   (16 kHz mono). Nothing generated is committed to git.
# The truth file lists each line's speaker and its start/end in seconds, known by construction.
set -e
here=$(dirname "$0")
tmp=$(mktemp -d)
i=0
: > "$tmp/list.txt"
printf '[' > "$2"
t=0
sep=""
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
  # 0.6 s of silence after each line
  ffmpeg -v error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 0.6 "$tmp/s$i.wav"
  echo "file '$tmp/s$i.wav'" >> "$tmp/list.txt"
  t=$(awk "BEGIN{printf \"%.3f\", $end+0.6}")
done < "$here/two_voice_script.txt"
printf ']\n' >> "$2"
ffmpeg -v error -y -f concat -safe 0 -i "$tmp/list.txt" -ac 1 -ar 16000 "$1"
rm -rf "$tmp"
