#!/usr/bin/env python3
"""MEDIA_DIR/shots/*.png -> .github/assets/readme/screenshot-*.png

Scales the desktop shots to 1600 px, puts the two phone shots side by side
on one 16:10 canvas, and quantises everything to 256 colours (Pillow; UI
screenshots barely change). Usage: python3 scripts/readme-media/optimise.py
"""
import os
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw

DIR = Path(os.environ.get("MEDIA_DIR", os.path.join(tempfile.gettempdir(), "flowplan-readme-media"))) / "shots"
OUT = Path(__file__).resolve().parents[2] / ".github" / "assets" / "readme"
WIDTH = 1600
BACKGROUND = {"light": (238, 236, 246), "dark": (22, 21, 28)}


def save(img: Image.Image, path: Path) -> None:
    img.convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)
    print(path.name, path.stat().st_size // 1024, "KB")


for scheme in ("light", "dark"):
    for name in ("document", "database", "whiteboard"):
        img = Image.open(DIR / f"{name}-{scheme}.png")
        img = img.resize((WIDTH, round(img.height * WIDTH / img.width)), Image.Resampling.LANCZOS)
        save(img, OUT / f"screenshot-{name}-{scheme}.png")
    # Two phones on one canvas with the proportions of the desktop shots.
    canvas = Image.new("RGB", (WIDTH, 1000), BACKGROUND[scheme])
    phones = [Image.open(DIR / f"{n}-{scheme}.png") for n in ("phone", "phone-wiki")]
    height = 900
    gap = 60
    scaled = [p.resize((round(p.width * height / p.height), height), Image.Resampling.LANCZOS) for p in phones]
    total = sum(p.width for p in scaled) + gap
    x = (WIDTH - total) // 2
    for p in scaled:
        mask = Image.new("L", p.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, p.width - 1, p.height - 1), radius=36, fill=255)
        canvas.paste(p, (x, 50), mask)
        x += p.width + gap
    save(canvas, OUT / f"screenshot-phone-{scheme}.png")
