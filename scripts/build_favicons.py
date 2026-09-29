#!/usr/bin/env python3
"""Build the AI Netscape favicons from the flaming "N" mark.

Generates, into public/:
  favicon.ico          16 + 32 + 48, multi-size
  favicon.svg          the raster wrapped in SVG, so the existing
                       <link rel="icon" type="image/svg+xml"> keeps working
  apple-touch-icon.png 180x180

Source: scripts/assets/flaming_n.png (512x512, committed so the build is
reproducible without reaching outside the repo).

This replaced a procedurally drawn white-on-teal pixel N. The mark survives
being shrunk because the letterform is near-white against a dark ground —
checked at 16px before switching, where it is still legibly an N rather than
an orange smudge. A logo that is orange-on-orange would not have made it.

Run from the project root:  python3 scripts/build_favicons.py
Requires: Pillow  (pip install pillow)
"""

import base64
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
SOURCE = ROOT / "scripts" / "assets" / "flaming_n.png"
PUBLIC.mkdir(exist_ok=True)

ICO_SIZES = (16, 32, 48)
APPLE_SIZE = 180
SVG_EMBED_SIZE = 128   # keeps favicon.svg small; it is only ever drawn tiny


def load():
    if not SOURCE.exists():
        raise SystemExit(f"missing source image: {SOURCE}")
    return Image.open(SOURCE).convert("RGB")


def main():
    src = load()

    # ICO carrying all three sizes. Pillow resamples each entry from the
    # master rather than scaling one entry, which keeps 16px from smearing.
    ico_path = PUBLIC / "favicon.ico"
    src.resize((48, 48), Image.LANCZOS).save(
        ico_path, format="ICO", sizes=[(s, s) for s in ICO_SIZES]
    )

    # Apple touch icon. No transparency and a dark ground, which is what iOS
    # wants — it composites onto the home screen without a matte.
    apple = src.resize((APPLE_SIZE, APPLE_SIZE), Image.LANCZOS)
    apple.save(PUBLIC / "apple-touch-icon.png", optimize=True)

    # The old favicon.svg was real vector art. This mark is raster, so the SVG
    # becomes a wrapper around an embedded PNG. Slightly inelegant, but it
    # means every <link rel="icon" type="image/svg+xml"> across the site keeps
    # resolving and no HTML has to change.
    tmp = PUBLIC / "_favicon_embed.png"
    src.resize((SVG_EMBED_SIZE, SVG_EMBED_SIZE), Image.LANCZOS).save(tmp, optimize=True)
    b64 = base64.b64encode(tmp.read_bytes()).decode("ascii")
    tmp.unlink()
    (PUBLIC / "favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{SVG_EMBED_SIZE}" height="{SVG_EMBED_SIZE}" '
        f'viewBox="0 0 {SVG_EMBED_SIZE} {SVG_EMBED_SIZE}">'
        f'<image width="{SVG_EMBED_SIZE}" height="{SVG_EMBED_SIZE}" '
        f'href="data:image/png;base64,{b64}"/></svg>',
        encoding="utf-8",
    )

    for p in ("favicon.ico", "favicon.svg", "apple-touch-icon.png"):
        print(f"  wrote public/{p}  ({(PUBLIC / p).stat().st_size} bytes)")


if __name__ == "__main__":
    main()
