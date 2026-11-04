#!/bin/bash
# Encodes the raw clips from clips.mjs for the website:
#   MEDIA_DIR/raw/<name>.mp4 → MEDIA_DIR/demos/<name>.webm, .mp4 and .webp (poster)
# 1280×800, 25 fps, muted; VP9 and H.264 (faststart). The editor clip plays
# at 1.6× (typing is slow), the others in real time. A clip that comes out
# heavier than the one it replaces: once more with CRF_VP9=43 CRF_H264=32.
#   MEDIA_DIR=… bash scripts/site-media/encode.sh [name …]
set -euo pipefail
DIR="${MEDIA_DIR:-$PWD/.site-media}"
mkdir -p "$DIR/demos"
names=("$@")
[ ${#names[@]} -eq 0 ] && names=($(cd "$DIR/raw" && ls *.mp4 | sed 's/\.mp4$//'))
for n in "${names[@]}"; do
  f="$DIR/raw/$n.mp4"
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  speed=1
  case $n in
    editor*) speed=1.6; poster=$(python3 -c "print(max(0, round($dur/1.6-1.2,2)))") ;;
    db-views*) poster=3.6 ;;
    home) poster=0.5 ;;
    *) poster=$(python3 -c "print(max(0, round($dur-1.5,2)))") ;;
  esac
  vf="setpts=PTS/$speed,fps=25,scale=1280:800:flags=lanczos"
  ffmpeg -loglevel error -y -i "$f" -vf "$vf" -an -c:v libvpx-vp9 -crf ${CRF_VP9:-40} -b:v 0 -row-mt 1 -deadline good -cpu-used 2 -pix_fmt yuv420p "$DIR/demos/$n.webm"
  ffmpeg -loglevel error -y -i "$f" -vf "$vf" -an -c:v libx264 -profile:v high -preset slow -crf ${CRF_H264:-30} -pix_fmt yuv420p -movflags +faststart "$DIR/demos/$n.mp4"
  ffmpeg -loglevel error -y -ss "$poster" -i "$DIR/demos/$n.mp4" -frames:v 1 -c:v libwebp -quality ${POSTER_Q:-72} "$DIR/demos/$n.webp"
  printf '%s  webm %sK  mp4 %sK  poster %sK  %ss\n' "$n" "$(du -k "$DIR/demos/$n.webm" | cut -f1)" "$(du -k "$DIR/demos/$n.mp4" | cut -f1)" "$(du -k "$DIR/demos/$n.webp" | cut -f1)" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$DIR/demos/$n.mp4")"
done
