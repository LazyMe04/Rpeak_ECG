"""Generate the app icons from code rather than shipping opaque binaries.

The mark is a QRS complex on a rounded indigo tile. Drawing it here means the
icon can be re-derived at any size, and that a change to the palette is a
one-line edit instead of a trip through a design tool.

Run from `app/`:
  python scripts/make-icons.py
Then, once per icon change:
  npx tauri icon src-tauri/icons/icon.png
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "src-tauri" / "icons"
S = 1024          # master size
SS = 4            # supersampling factor

# Tile gradient, top-left to bottom-right.
TOP = (79, 70, 229)      # indigo-600
BOTTOM = (124, 58, 237)  # violet-600
INK = (255, 255, 255)

# One cardiac cycle, in fractions of the canvas. y grows downward.
TRACE = [
    (0.06, 0.52),
    (0.26, 0.52),
    (0.31, 0.47),   # P
    (0.36, 0.52),
    (0.43, 0.52),
    (0.46, 0.61),   # Q
    (0.50, 0.21),   # R
    (0.545, 0.73),  # S
    (0.59, 0.52),
    (0.68, 0.52),
    (0.73, 0.45),   # T
    (0.79, 0.52),
    (0.94, 0.52),
]
STROKE = 0.052


def tile(size: int) -> Image.Image:
    """Rounded square with a diagonal gradient."""
    w = size * SS
    grad = Image.new("RGB", (w, w))
    px = grad.load()
    for y in range(w):
        for x in range(w):
            t = (x + y) / (2 * w)
            px[x, y] = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))

    mask = Image.new("L", (w, w), 0)
    d = ImageDraw.Draw(mask)
    inset = int(w * 0.02)
    d.rounded_rectangle((inset, inset, w - inset, w - inset),
                        radius=int(w * 0.225), fill=255)

    out = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def draw_trace(img: Image.Image) -> None:
    w = img.size[0]
    d = ImageDraw.Draw(img)
    pts = [(x * w, y * w) for x, y in TRACE]
    width = max(2, int(STROKE * w))
    d.line(pts, fill=INK, width=width, joint="curve")
    # Round caps: Pillow's line has butt ends.
    r = width / 2
    for x, y in (pts[0], pts[-1]):
        d.ellipse((x - r, y - r, x + r, y + r), fill=INK)


def render(size: int) -> Image.Image:
    img = tile(size)
    draw_trace(img)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = render(S)
    master.save(OUT / "icon.png")

    sizes = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon-512.png": 512,
    }
    for name, px in sizes.items():
        render(px).save(OUT / name)

    # Windows wants a multi-resolution .ico; including 256 px keeps Explorer
    # from upscaling the 32 px image in large-icon views.
    master.save(OUT / "icon.ico",
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64),
                       (128, 128), (256, 256)])
    for p in sorted(OUT.iterdir()):
        print(f"  {p.name:18} {p.stat().st_size:>7} bytes")


if __name__ == "__main__":
    main()
