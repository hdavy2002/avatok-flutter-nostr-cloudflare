#!/usr/bin/env python3
"""[HF-DESK-THEME-1] hf-theme.css for the agent desk: the website palette (Specs/HF-DESIGN-SYSTEM.md, web class C) mapped onto
Chatwoot's colour variables (app/javascript/dashboard/assets/scss/_next-colors.scss), plus Nunito / Comfortaa.

Chatwoot declares its variables inside `@layer base`; these rules are unlayered, so they win without !important and
without touching Chatwoot's code. Each Chatwoot scale has 12 steps: 1-2 backgrounds, 3-5 component fills, 6-8 borders,
9-10 solid colour, 11-12 text. We build each scale from one brand colour.

  python3 gen_theme.py > dist/hf-theme.css
"""

# Website palette (HF-DESIGN-SYSTEM web class C)
RANI = "#D81B72"       # primary: buttons, links, active tab, unread
PLUM = "#4A1747"       # selected items, headings
PLUM2 = "#6B2468"
LAVENDER = "#6D4FD0"
MARIGOLD = "#F59E0B"   # private notes
INK = "#2B1530"        # text
MUTED = "#6F5B6F"      # secondary text
IVORY = "#FFF8F0"      # page
LINE = "#F1E3D6"       # borders
BLUSH = "#FFE6EF"      # outgoing message bubble
LAVTINT = "#F1EBFF"
DARK_BG = "#170E1A"    # dark mode page (plum-black)


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    """t=0 -> a, t=1 -> b"""
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def trip(c):
    return f"{c[0]} {c[1]} {c[2]}"


WHITE, BLACK = (255, 255, 255), (0, 0, 0)
LIGHT_STEPS = [0.012, 0.03, 0.07, 0.11, 0.16, 0.22, 0.31, 0.45]   # share of the colour mixed into white for steps 1-8
DARK_STEPS = [0.04, 0.07, 0.13, 0.18, 0.23, 0.29, 0.37, 0.5]      # share of the colour mixed into the dark page


def scale(base_hex, dark=False, ink_hex=None):
    base = rgb(base_hex)
    ground = rgb(DARK_BG) if dark else WHITE
    steps = [mix(ground, base, t) for t in (DARK_STEPS if dark else LIGHT_STEPS)]
    if dark:
        steps += [base, mix(base, WHITE, 0.12), mix(base, WHITE, 0.45), mix(base, WHITE, 0.85)]
    else:
        steps += [base, mix(base, BLACK, 0.08), mix(base, BLACK, 0.22), rgb(ink_hex) if ink_hex else mix(base, BLACK, 0.62)]
    return steps


def neutral(dark=False):
    """Warm plum-greys for slate / gray (text, borders, quiet fills)."""
    if not dark:
        bg = rgb(IVORY)
        return [mix(WHITE, bg, 0.6), bg, mix(bg, rgb(LINE), 0.6), rgb(LINE), mix(rgb(LINE), rgb(MUTED), 0.12),
                mix(rgb(LINE), rgb(MUTED), 0.22), mix(rgb(LINE), rgb(MUTED), 0.36), mix(rgb(LINE), rgb(MUTED), 0.55),
                mix(rgb(MUTED), WHITE, 0.12), rgb(MUTED), mix(rgb(MUTED), rgb(INK), 0.45), rgb(INK)]
    bg = rgb(DARK_BG)
    tint = rgb("#E9DCEB")
    return [bg, mix(bg, tint, 0.03), mix(bg, tint, 0.06), mix(bg, tint, 0.09), mix(bg, tint, 0.12), mix(bg, tint, 0.16),
            mix(bg, tint, 0.22), mix(bg, tint, 0.32), mix(bg, tint, 0.42), mix(bg, tint, 0.5), mix(bg, tint, 0.72), mix(bg, tint, 0.94)]


def block(dark):
    out = []
    scales = {
        "slate": neutral(dark), "gray": neutral(dark),
        "blue": scale(RANI, dark, ink_hex="#5B0B30"),
        "iris": scale(PLUM2, dark, ink_hex=PLUM),
        "violet": scale(LAVENDER, dark),
        "amber": scale(MARIGOLD, dark, ink_hex="#5A3500"),
    }
    for name, steps in scales.items():
        for i, c in enumerate(steps, 1):
            out.append(f"--{name}-{i}: {trip(c)};")
    r = rgb
    if not dark:
        out += [
            f"--background-color: {trip(r(IVORY))};", "--surface-1: 255 252 248;", "--surface-2: 255 255 255;", "--surface-active: 255 255 255;",
            f"--text-blue: {trip(mix(r(RANI), BLACK, 0.55))};", f"--text-purple: {trip(r(PLUM))};",
            f"--border-container: {trip(r(LINE))};", f"--border-strong: {trip(mix(r(LINE), r(MUTED), 0.2))};", f"--border-weak: {trip(mix(r(LINE), WHITE, 0.3))};",
            f"--border-blue-strong: {trip(mix(r(RANI), BLACK, 0.3))};",
            f"--solid-blue: {trip(r(BLUSH))};", f"--solid-blue-2: {trip(mix(r(BLUSH), WHITE, 0.6))};",
            f"--solid-iris: {trip(r(LAVTINT))};", f"--solid-purple: {trip(r(LAVTINT))};",
            "--solid-amber: 255 241 214;", "--solid-amber-button: 251 191 36;",
            f"--label-background: {trip(mix(r(IVORY), r(LINE), 0.5))};", f"--border-blue: {', '.join(map(str, r(RANI)))}, 0.5;",
        ]
    else:
        bg = r(DARK_BG)
        tint = r("#E9DCEB")
        out += [
            f"--background-color: {trip(mix(bg, tint, 0.04))};", f"--surface-1: {trip(bg)};", f"--surface-2: {trip(mix(bg, tint, 0.02))};",
            f"--surface-active: {trip(mix(bg, tint, 0.16))};", f"--text-blue: {trip(mix(r(RANI), WHITE, 0.8))};", f"--text-purple: {trip(mix(r(PLUM2), WHITE, 0.85))};",
            f"--border-strong: {trip(mix(bg, tint, 0.14))};", f"--border-weak: {trip(mix(bg, tint, 0.07))};", f"--border-blue-strong: {trip(mix(r(RANI), WHITE, 0.7))};",
            f"--solid-1: {trip(mix(bg, tint, 0.03))};", f"--solid-2: {trip(mix(bg, tint, 0.06))};", f"--solid-3: {trip(mix(bg, tint, 0.12))};",
            f"--solid-active: {trip(mix(bg, tint, 0.16))};", f"--solid-blue: {trip(mix(bg, r(RANI), 0.32))};", f"--solid-blue-2: {trip(mix(bg, r(RANI), 0.08))};",
            f"--solid-iris: {trip(mix(bg, r(PLUM2), 0.4))};", f"--solid-purple: {trip(mix(bg, r(LAVENDER), 0.35))};", f"--solid-amber: {trip(mix(bg, r(MARIGOLD), 0.22))};",
            f"--card-color: {trip(mix(bg, tint, 0.05))};", f"--button-color: {trip(mix(bg, tint, 0.1))};", f"--label-background: {trip(mix(bg, tint, 0.09))};",
            f"--border-blue: {', '.join(map(str, r(RANI)))}, 0.5;",
        ]
    return "\n  ".join(out)


FONTS = """
/* Nunito: headings, buttons, labels, numbers. Comfortaa: body text. (HF design system) */
html, body, .font-inter, .font-sans, input, textarea, select, .ProseMirror { font-family: 'Comfortaa', system-ui, -apple-system, 'Segoe UI', sans-serif; }
h1, h2, h3, h4, h5, h6, button, label, th, .font-interDisplay, [class*="font-medium"], [class*="font-semibold"], [class*="font-bold"],
[class*="text-heading"], nav a, aside a { font-family: 'Nunito', system-ui, -apple-system, 'Segoe UI', sans-serif; }
code, pre, kbd, samp { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
/* message text stays easy to read in a busy inbox */
.ProseMirror, [class*="prose"] { line-height: 1.6; }
"""

print("/* generated by support-desk-cw/gen_theme.py - do not edit */")
print(f":root {{\n  {block(False)}\n}}")
print(f".dark {{\n  {block(True)}\n}}")
print(FONTS)
