#!/usr/bin/env python3
"""[APP-ICON-1 2026-08-01] Generate the Android launcher icon set from one source.

Source: design/app-logo2.png (square, logo fills the frame).

WHY A SCRIPT AND NOT A ONE-OFF. Regenerating icons by hand is how a set drifts:
one density gets missed, the adaptive foreground keeps an old logo, and the app
ships two different marks depending on the launcher. This is re-runnable and
overwrites every density from the single source, so the set can never be
partially updated.

WHAT ANDROID ACTUALLY NEEDS
---------------------------
1. LEGACY icons (`ic_launcher.png`, `ic_launcher_round.png`) — used by older
   launchers. Full-bleed: the logo fills the square.

2. ADAPTIVE foreground (`ic_launcher_foreground.png`) — used by Android 8+.
   The canvas is 108dp but the launcher may mask it to a circle, squircle or
   rounded square, and it also parallax-scales it. Only the CENTRE 72dp is
   guaranteed visible — the "safe zone". Art drawn outside that can be clipped
   on some devices and not others.

   This is the step people get wrong: they drop a full-bleed logo straight in as
   the foreground, and every launcher crops the edges off. So the logo is scaled
   to the safe zone and centred on a transparent 108dp canvas.

   Safe-zone ratio here is 0.63 rather than the theoretical 72/108 = 0.667 —
   the source already carries a thin white ring, and a hair of extra margin
   keeps that ring from touching the mask edge on a circular launcher.

The adaptive BACKGROUND stays the existing solid @color/ic_launcher_background
(#FFFFFF), which matches the logo's own white ring so the two blend seamlessly.
"""
import os
import sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "design", "app-logo2.png")
RES = os.path.join(ROOT, "app", "android", "app", "src", "main", "res")

# Legacy launcher icon sizes (px) per density bucket.
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# Adaptive foreground is always 108dp on the same buckets.
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
SAFE_ZONE_RATIO = 0.63


def load_source() -> Image.Image:
    if not os.path.exists(SRC):
        sys.exit(f"source not found: {SRC}")
    im = Image.open(SRC).convert("RGBA")
    # Trim any uniform border so the logo's own bounds drive the scaling rather
    # than whatever padding the export happened to include. Without this the
    # "safe zone" maths is applied to the padding, not the art, and the icon
    # comes out visibly too small.
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    # Square it on a transparent canvas so non-square exports never distort.
    side = max(im.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
    return sq


def write(img: Image.Image, folder: str, name: str) -> None:
    d = os.path.join(RES, folder)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, name)
    img.save(p, "PNG", optimize=True)
    print(f"  {folder}/{name}  {img.width}x{img.height}")


def circular_mask(img: Image.Image) -> Image.Image:
    """Legacy round icon: hard-crop to a circle so old launchers that do NOT
    mask still get a round mark instead of a square with corners."""
    from PIL import ImageDraw
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, img.width - 1, img.height - 1), fill=255)
    out.paste(img, (0, 0), mask)
    return out


def main() -> None:
    src = load_source()
    print(f"source: {SRC}  ({src.width}x{src.height} after trim+square)")

    print("legacy ic_launcher / ic_launcher_round:")
    for bucket, size in LEGACY.items():
        full = src.resize((size, size), Image.LANCZOS)
        write(full, f"mipmap-{bucket}", "ic_launcher.png")
        write(circular_mask(full), f"mipmap-{bucket}", "ic_launcher_round.png")

    print("adaptive ic_launcher_foreground (logo inset to the 72dp safe zone):")
    for bucket, size in ADAPTIVE.items():
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        inner = max(1, int(round(size * SAFE_ZONE_RATIO)))
        logo = src.resize((inner, inner), Image.LANCZOS)
        off = (size - inner) // 2
        canvas.paste(logo, (off, off), logo)
        write(canvas, f"mipmap-{bucket}", "ic_launcher_foreground.png")

    print("done.")


if __name__ == "__main__":
    main()
