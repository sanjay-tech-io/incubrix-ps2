#!/bin/sh
# Builds the AI-generated test clip (espeak-ng, formant TTS) from synthetic_script.txt.
# Usage: make_synthetic.sh OUT.wav     (16 kHz mono). Nothing generated is committed to git.
set -e
here=$(dirname "$0")
espeak-ng -v en-us -s 150 -g 8 -f "$here/synthetic_script.txt" -w "$1.raw.wav"
ffmpeg -v error -y -i "$1.raw.wav" -ac 1 -ar 16000 "$1"
rm -f "$1.raw.wav"
