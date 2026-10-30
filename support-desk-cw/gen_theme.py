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
        # [HF-DESK-UX-1] no green UI: Chatwoot's teal/green (unread counts, online dot, success) become rani
        "teal": scale(RANI, dark, ink_hex="#5B0B30"),
        "green": scale(RANI, dark, ink_hex="#5B0B30"),
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


# [HF-DESK-UX-1] Indian touches (HF design system: festive, bold, rounded; marigold + rani on plum, block-print texture).
# The sidebar becomes a deep plum panel with a marigold/rani toran (bunting) across its top and a faint block-print
# flower tile; the active item gets a marigold marker. Scoping Chatwoot's variables to the sidebar recolours every
# sidebar component without touching its markup.
import base64
BUTA = ("<svg xmlns='http://www.w3.org/2000/svg' width='72' height='72' viewBox='-8 -8 72 72'>"
        "<g fill='none' stroke='%s' stroke-width='1' opacity='.16'>"
        "<circle cx='28' cy='28' r='3'/>"
        + "".join(f"<ellipse cx='28' cy='19' rx='3.2' ry='7' transform='rotate({a} 28 28)'/>" for a in range(0, 360, 45))
        + "</g><g fill='%s' opacity='.22'><circle cx='0' cy='0' r='1.6'/><circle cx='56' cy='0' r='1.6'/><circle cx='0' cy='56' r='1.6'/><circle cx='56' cy='56' r='1.6'/></g></svg>") % (MARIGOLD, MARIGOLD)
BUTA_URI = "data:image/svg+xml;base64," + base64.b64encode(BUTA.encode()).decode()
PLUM_DEEP = "#3A1238"
side_vars = {
    "--background-color": trip(rgb(PLUM)),
    "--slate-11": "236 214 233", "--slate-12": "255 255 255", "--slate-10": "214 186 211", "--slate-9": "196 160 192",
    "--slate-4": trip(mix(rgb(PLUM), WHITE, 0.2)), "--slate-5": trip(mix(rgb(PLUM), WHITE, 0.26)), "--slate-6": trip(mix(rgb(PLUM), WHITE, 0.3)),
    "--slate-3": trip(mix(rgb(PLUM), WHITE, 0.12)), "--slate-2": trip(mix(rgb(PLUM), WHITE, 0.07)),
    "--alpha-1": "255, 255, 255, 0.08", "--alpha-2": "255, 255, 255, 0.14", "--alpha-black-2": "255, 255, 255, 0.10",
    "--border-weak": trip(mix(rgb(PLUM), WHITE, 0.14)), "--border-container": trip(mix(rgb(PLUM), WHITE, 0.16)),
    "--solid-1": trip(mix(rgb(PLUM), WHITE, 0.06)), "--solid-2": trip(mix(rgb(PLUM), WHITE, 0.1)), "--solid-3": trip(mix(rgb(PLUM), WHITE, 0.14)),
}
SIDEBAR = """
/* --- sidebar: plum panel, toran, block print --- */
aside.bg-n-background, .dark aside.bg-n-background {
  %s
  color-scheme: dark;
  background-color: %s;
  background-image: url("%s"), linear-gradient(180deg, %s 0%%, %s 100%%);
  background-size: 72px 72px, 100%% 100%%;
  padding-top: 14px;
}
aside.bg-n-background::before {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 12px; pointer-events: none; z-index: 1;
  background:
    conic-gradient(from 135deg at 50%% 0, %s 90deg, transparent 0) 0 0 / 20px 12px repeat-x,
    conic-gradient(from 135deg at 50%% 0, %s 90deg, transparent 0) 10px 0 / 20px 8px repeat-x;
  filter: drop-shadow(0 1px 0 rgba(0,0,0,.18));
}
aside.bg-n-background::after { /* the toran's string */
  content: ""; position: absolute; inset: 0 0 auto 0; height: 2px; background: %s; z-index: 2; pointer-events: none;
}
aside.bg-n-background .active, aside.bg-n-background [class*="bg-n-alpha-2"][class*="font-medium"] {
  box-shadow: inset 3px 0 0 %s; border-radius: 10px;
}
aside.bg-n-background .bg-n-brand { background-color: %s; }
/* the profile / status menus open inside the sidebar: keep them on the light card colours */
aside.bg-n-background [data-popover-content], aside.bg-n-background [role="menu"], aside.bg-n-background .bg-n-alpha-3 { color: rgb(%s); }

/* --- main panes: a thin festive band along the top --- */
main.bg-n-surface-1::before {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; z-index: 30; pointer-events: none;
  background: linear-gradient(90deg, %s, %s 45%%, %s 75%%, %s);
}
/* rounder, bolder controls (never boxy) */
button.rounded-lg, .rounded-lg:is(button, a) { border-radius: 12px; }
[class*="bg-n-brand"]:is(button) { font-weight: 800; letter-spacing: .01em; }
""" % (";\n  ".join(f"{k}: {v}" for k, v in side_vars.items()) + ";", PLUM, BUTA_URI, PLUM, PLUM_DEEP,
       MARIGOLD, RANI, MARIGOLD, MARIGOLD, MARIGOLD, trip(rgb(INK)), RANI, MARIGOLD, LAVENDER, RANI)
print(SIDEBAR)
