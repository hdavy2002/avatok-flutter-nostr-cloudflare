#!/usr/bin/env python3
"""[HF-MOTION-1] Writes the small Lottie (bodymovin 5.7, 60 fps) files the app bundles.

    python3 hf-flutter/tool/gen_lottie.py            # write hf-flutter/assets/lottie/*.json
    python3 hf-flutter/tool/gen_lottie.py --check    # fail if the committed files are stale

Files:
  sparkle_burst.json  seven four-point stars pop out from the centre, spin and fade (sunshine/primary)
  heart_pop.json      a heart scales in with a little overshoot, then floats up and fades
  check_draw.json     a circle and a tick draw themselves with trim paths (primary)

Plain python3, no dependencies. Colours are the app tokens (HfColors in lib/core/theme/hf_tokens.dart).
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "lottie"
FPS = 60
SIZE = 200

PRIMARY = "#F28C28"
SUNSHINE = "#FFC93C"
DEEP_ORANGE = "#E8641B"
ROSE_DOT = "#E0527E"

# Bezier easing handles (out of the current keyframe, into the next one).
LINEAR = ((0.0, 0.0), (1.0, 1.0))
EASE_OUT = ((0.33, 1.0), (0.68, 1.0))
EASE_IN_OUT = ((0.42, 0.0), (0.58, 1.0))
BACK_OUT = ((0.34, 1.56), (0.64, 1.0))


def rgba(hex_colour: str) -> list[float]:
    h = hex_colour.lstrip("#")
    return [round(int(h[i:i + 2], 16) / 255, 4) for i in (0, 2, 4)] + [1]


def static(value):
    return {"a": 0, "k": value}


def animated(frames):
    """frames: [(time, value, easing), ...]; the easing of a frame shapes the move to the next one."""
    keys = []
    for index, (time, value, easing) in enumerate(frames):
        start = value if isinstance(value, list) else [value]
        key = {"t": time, "s": start}
        if index < len(frames) - 1:
            (ox, oy), (ix, iy) = easing
            key["o"] = {"x": [ox], "y": [oy]}
            key["i"] = {"x": [ix], "y": [iy]}
        keys.append(key)
    return {"a": 1, "k": keys}


def group_transform():
    return {
        "ty": "tr",
        "nm": "Transform",
        "p": static([0, 0]),
        "a": static([0, 0]),
        "s": static([100, 100]),
        "r": static(0),
        "o": static(100),
        "sk": static(0),
        "sa": static(0),
    }


def path_shape(vertices, ins, outs, closed=True):
    return {
        "ty": "sh",
        "nm": "Path",
        "ks": static({"i": ins, "o": outs, "v": vertices, "c": closed}),
    }


def fill(colour):
    return {"ty": "fl", "nm": "Fill", "c": static(rgba(colour)), "o": static(100), "r": 1}


def stroke(colour, width):
    return {
        "ty": "st",
        "nm": "Stroke",
        "c": static(rgba(colour)),
        "o": static(100),
        "w": static(width),
        "lc": 2,
        "lj": 2,
        "ml": 4,
    }


def trim(end):
    return {"ty": "tm", "nm": "Trim", "s": static(0), "e": end, "o": static(0), "m": 1}


def group(name, items):
    return {"ty": "gr", "nm": name, "np": len(items), "it": items + [group_transform()]}


def layer(index, name, op, shapes, position, scale=None, rotation=None, opacity=None):
    return {
        "ddd": 0,
        "ind": index,
        "ty": 4,
        "nm": name,
        "sr": 1,
        "ks": {
            "o": opacity or static(100),
            "r": rotation or static(0),
            "p": position,
            "a": static([0, 0, 0]),
            "s": scale or static([100, 100, 100]),
        },
        "ao": 0,
        "shapes": shapes,
        "ip": 0,
        # One frame past the end so the last frame (shown with reduced motion) still draws the layer.
        "op": op + 1,
        "st": 0,
        "bm": 0,
    }


def composition(name, op, layers):
    return {
        "v": "5.7.4",
        "fr": FPS,
        "ip": 0,
        "op": op,
        "w": SIZE,
        "h": SIZE,
        "nm": name,
        "ddd": 0,
        "assets": [],
        "layers": layers,
        "markers": [],
    }


def zeros(n):
    return [[0, 0] for _ in range(n)]


def star_path(outer, inner):
    vertices = []
    for k in range(8):
        angle = math.pi / 4 * k - math.pi / 2
        r = outer if k % 2 == 0 else inner
        vertices.append([round(math.cos(angle) * r, 3), round(math.sin(angle) * r, 3)])
    return path_shape(vertices, zeros(8), zeros(8))


def sparkle_burst():
    op = 60
    c = SIZE / 2
    layers = []
    count = 7
    for k in range(count):
        angle = 2 * math.pi * k / count - math.pi / 2
        distance = 62 + (k % 3) * 8
        delay = (k * 3) % 8
        end = [round(c + math.cos(angle) * distance, 2), round(c + math.sin(angle) * distance, 2), 0]
        colour = SUNSHINE if k % 2 == 0 else PRIMARY
        layers.append(layer(
            k + 2,
            f"Star {k + 1}",
            op,
            [group("Star", [star_path(13 if k % 2 == 0 else 10, 3.5), fill(colour)])],
            position=animated([(delay, [c, c, 0], EASE_OUT), (delay + 34, end, LINEAR)]),
            scale=animated([
                (delay, [0, 0, 100], BACK_OUT),
                (delay + 12, [110, 110, 100], EASE_IN_OUT),
                (delay + 40, [40, 40, 100], LINEAR),
            ]),
            rotation=animated([(delay, 0, EASE_OUT), (delay + 40, 90, LINEAR)]),
            opacity=animated([(delay + 24, 100, EASE_IN_OUT), (min(op, delay + 44), 0, LINEAR)]),
        ))
    glow = layer(
        1,
        "Glow",
        op,
        [group("Glow", [{"ty": "el", "nm": "Circle", "p": static([0, 0]), "s": static([44, 44])}, fill(SUNSHINE)])],
        position=static([c, c, 0]),
        scale=animated([(0, [0, 0, 100], BACK_OUT), (10, [120, 120, 100], EASE_IN_OUT), (24, [60, 60, 100], LINEAR)]),
        opacity=animated([(0, 90, EASE_IN_OUT), (24, 0, LINEAR)]),
    )
    # Layer order: first in the list is drawn on top, so the glow goes last.
    return composition("sparkle_burst", op, layers + [glow])


def heart_pop():
    op = 72
    c = SIZE / 2
    s = 1.5
    vertices = [[0, 24], [28, -6], [0, -10], [-28, -6]]
    outs = [[10, -8], [0, -14], [-8, -16], [0, 12]]
    ins = [[-10, -8], [0, 12], [8, -16], [0, -14]]
    scaled = lambda pts: [[round(x * s, 3), round(y * s, 3)] for x, y in pts]  # noqa: E731
    heart = layer(
        1,
        "Heart",
        op,
        [group("Heart", [path_shape(scaled(vertices), scaled(ins), scaled(outs)), fill(ROSE_DOT)])],
        position=animated([(0, [c, c + 16, 0], EASE_IN_OUT), (30, [c, c + 16, 0], EASE_IN_OUT), (op, [c, c - 44, 0], LINEAR)]),
        scale=animated([
            (0, [0, 0, 100], BACK_OUT),
            (16, [118, 118, 100], EASE_IN_OUT),
            (26, [100, 100, 100], LINEAR),
        ]),
        opacity=animated([(36, 100, EASE_IN_OUT), (op, 0, LINEAR)]),
    )
    return composition("heart_pop", op, [heart])


def check_draw():
    op = 60
    c = SIZE / 2
    circle = layer(
        2,
        "Circle",
        op,
        [group("Circle", [
            {"ty": "el", "nm": "Circle", "p": static([0, 0]), "s": static([150, 150])},
            trim(animated([(0, 0, EASE_IN_OUT), (24, 100, LINEAR)])),
            stroke(PRIMARY, 10),
        ])],
        position=static([c, c, 0]),
        scale=animated([
            (40, [100, 100, 100], EASE_IN_OUT),
            (48, [108, 108, 100], EASE_IN_OUT),
            (56, [100, 100, 100], LINEAR),
        ]),
    )
    tick = layer(
        1,
        "Tick",
        op,
        [group("Tick", [
            path_shape([[-34, 2], [-10, 26], [36, -24]], zeros(3), zeros(3), closed=False),
            trim(animated([(20, 0, EASE_OUT), (42, 100, LINEAR)])),
            stroke(DEEP_ORANGE, 12),
        ])],
        position=static([c, c, 0]),
        scale=animated([
            (40, [100, 100, 100], EASE_IN_OUT),
            (48, [108, 108, 100], EASE_IN_OUT),
            (56, [100, 100, 100], LINEAR),
        ]),
    )
    return composition("check_draw", op, [tick, circle])


FILES = {
    "sparkle_burst.json": sparkle_burst,
    "heart_pop.json": heart_pop,
    "check_draw.json": check_draw,
}


def render(builder) -> str:
    return json.dumps(builder(), separators=(",", ":")) + "\n"


def main(argv: list[str]) -> int:
    check = "--check" in argv
    stale = []
    OUT.mkdir(parents=True, exist_ok=True)
    for name, builder in FILES.items():
        text = render(builder)
        target = OUT / name
        if check:
            if not target.exists() or target.read_text(encoding="utf-8") != text:
                stale.append(name)
        else:
            target.write_text(text, encoding="utf-8")
            print(f"wrote {target.relative_to(OUT.parent.parent)} ({len(text)} bytes)")
    if stale:
        print("stale Lottie files (run python3 hf-flutter/tool/gen_lottie.py): " + ", ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
