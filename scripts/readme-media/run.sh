#!/bin/sh
# Regenerates the README media against a running dev instance with an EMPTY
# data directory:
#
#   APP_URL=http://127.0.0.1:3583 FLOWPLAN_DATA_DIR=/tmp/media-data npx next dev --hostname 127.0.0.1 -p 3583
#   MEDIA_URL=http://127.0.0.1:3583 sh scripts/readme-media/run.sh
#
# Optional: MEDIA_DIR (working files, default $TMPDIR/flowplan-readme-media), CHROMIUM.
# Needs ffmpeg and Python with Pillow. Order matters: hero.mjs edits the
# seeded pages, so the screenshots come first.
set -eu
cd "$(dirname "$0")/../.."
node scripts/readme-media/seed.mjs
node scripts/readme-media/screenshots.mjs
python3 scripts/readme-media/optimise.py
node scripts/readme-media/hero.mjs
node scripts/readme-media/make-hero.mjs
