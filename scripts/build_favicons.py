#!/usr/bin/env python3
"""Build the AI Netscape favicons: a pixel-art "N", white on teal.

Generates, into public/:
  favicon.ico         16x16 + 32x32, pixel-perfect
  favicon.svg         crisp vector version for modern browsers
  apple-touch-icon.png 180x180

Run from the project root:  python3 scripts/build_favicons.py
Requires: Pillow  (pip install pillow)
"""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
PUBLIC.mkdir(exist_ok=True)

TEAL = "#008080"
WHITE = "#ffffff"


def render_n(size):
    """Draw a chunky pixel "N" — left bar, diagonal, right bar."""
    img = Image.new("RGB", (size, size), TEAL)
    d = ImageDraw.Draw(img)
    s = size / 32.0

    def rect(x0, y0, x1, y1):
        d.rectangle([round(x0 * s), round(y0 * s), round(x1 * s), round(y1 * s)], fill=WHITE)

    rect(8, 8, 11, 24)    # left vertical bar
    rect(21, 8, 24, 24)   # right vertical bar
    for i in range(13):   # diagonal, as a staircase of small squares
        x = 10 + i
        y = 9 + i * 1.1
        rect(x, y, x + 2, y + 2)
    return img


def main():
    # ICO with both 16x16 and 32x32 entries
    master = render_n(32)
    ico_path = PUBLIC / "favicon.ico"
    master.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32)])
    print(f"wrote {ico_path}")

    # Apple touch icon
    touch_path = PUBLIC / "apple-touch-icon.png"
    render_n(180).save(touch_path, format="PNG")
    print(f"wrote {touch_path}")

    # SVG version (crisp at any size)
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">\n'
        '  <rect width="32" height="32" fill="#008080"/>\n'
        '  <rect x="8" y="8" width="3" height="16" fill="#ffffff"/>\n'
        '  <rect x="21" y="8" width="3" height="16" fill="#ffffff"/>\n'
        '  <path d="M10 9 L23 24" stroke="#ffffff" stroke-width="3" fill="none"/>\n'
        '</svg>\n'
    )
    svg_path = PUBLIC / "favicon.svg"
    svg_path.write_text(svg, encoding="utf-8")
    print(f"wrote {svg_path}")


if __name__ == "__main__":
    main()
