#!/usr/bin/env python3
"""
[POSTER-FIRST-1] Style preview for the option-B poster pipeline.

Proves the shape of the real thing: Vertex paints the ARTWORK ONLY (no text),
this script composites the listing's real data over the reserved colour bands,
at three aspect ratios, from one source artwork.

Nothing here ships. worker/src/lib/poster_compose.ts is the production version;
this exists so the owner can approve the type, palette and layout before that
gets built.

    python3 tool/poster_compose_preview.py <artwork.png> <outdir>
"""
import sys, os, textwrap
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- listing data
# Real values off the owner's own wizard screenshot (2026-09-05). PRICE is a
# stand-in — the money step wasn't visible — and is labelled as such in the
# review notes. In production every one of these comes off the D1 row, which is
# the entire point of compositing rather than letting the model letter it.
L = {
    "status":   "AVAILABLE NOW",
    "category": "COOKING",
    "title":    "FRIDAY NIGHT COOKING",
    "blurb":    "Making murg curry. Come and see me cook live.",
    "price":    "₹250",
    "unit":     "PER HOUR",
    "duration": "1 HOUR",
    "language": "HINDI",
    "vibes":    ["CAM OPTIONAL"],
    "host":     "CASH FREE",
    "rules":    ["Respect is mandatory — be kind and polite.",
                 "No personal info sharing (address, phone, socials).",
                 "Call timing must be respected."],
}

# ------------------------------------------------------------------- ink slabs
# Sampled off the generated artwork so type sits on the model's own inks rather
# than a palette guessed alongside it.
RED    = (220, 3, 4)
YELLOW = (251, 175, 5)
PAPER  = (254, 254, 254)
INK    = (26, 18, 12)
TEAL   = (12, 78, 92)

# Bands measured from the 1024x1536 source (flat-row scan).
SRC_RED  = (26, 302)
SRC_ART  = (314, 1145)
SRC_YEL  = (1154, 1511)

FDIR = "/tmp/f"
ANTON  = os.path.join(FDIR, "Anton-Regular.ttf")
NUNITO = os.path.join(FDIR, "Nunito%5Bwght%5D.ttf")


def anton(px):
    return ImageFont.truetype(ANTON, px)


def nunito(px, weight=800):
    f = ImageFont.truetype(NUNITO, px)
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def tracked(d, xy, text, font, fill, track=0.0, anchor_right=None):
    """Draw with positive letter-spacing.

    Never negative: Anton ships one weight, so bold is synthesised and negative
    tracking on it collides glyphs — the trap already written up in CLAUDE.md.
    """
    sp = font.size * track
    widths = [d.textlength(c, font=font) for c in text]
    total = sum(widths) + sp * max(0, len(text) - 1)
    x, y = xy
    if anchor_right:
        x = anchor_right - total
    for c, w in zip(text, widths):
        d.text((x, y), c, font=font, fill=fill)
        x += w + sp
    return total


def tracked_width(d, text, font, track=0.0):
    return sum(d.textlength(c, font=font) for c in text) + font.size * track * max(0, len(text) - 1)


def wrap_to(d, text, font, max_w, track=0.0):
    """Wrap, measuring WITH tracking.

    Measuring without it is how the wide title ran off the right edge: every
    title here is positively tracked, so plain textlength under-reports.
    """
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if tracked_width(d, t, font, track) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def fit_title(d, text, max_w, start_px, track, max_lines=2, floor=0.5):
    """Shrink Anton until the wrapped title fits the column in <= max_lines."""
    px = start_px
    while px > start_px * floor:
        f = anton(int(px))
        lines = wrap_to(d, text, f, max_w, track)
        if len(lines) <= max_lines and all(
            tracked_width(d, ln, f, track) <= max_w for ln in lines
        ):
            return f, lines
        px *= 0.94
    f = anton(int(px))
    return f, wrap_to(d, text, f, max_w, track)


def chip(d, x, y, text, font, fg, edge, pad=(22, 12), radius=999):
    w = tracked_width(d, text, font, 0.09)
    box = [x, y, x + w + pad[0] * 2, y + font.size + pad[1] * 2]
    d.rounded_rectangle(box, radius=radius, outline=edge, width=3)
    tracked(d, (x + pad[0], y + pad[1] - font.size * 0.08), text, font, fg, 0.09)
    return box[2] - box[0]


# ------------------------------------------------------------------- portrait
def portrait(art, out):
    """2:3 — phone card and Flutter grid. Type lands on the reserved bands."""
    W, H = 1080, 1620
    im = art.resize((W, H), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    s = H / 1536.0
    red_t, red_b = SRC_RED[0] * s, SRC_RED[1] * s
    yel_t, yel_b = SRC_YEL[0] * s, SRC_YEL[1] * s
    M = 64

    # --- red band: status, category, title
    f_eyebrow = nunito(26, 900)
    dot_y = red_t + 40
    d.ellipse([M, dot_y + 8, M + 14, dot_y + 22], fill=PAPER)
    w = tracked(d, (M + 28, dot_y), L["status"], f_eyebrow, PAPER, 0.16)
    tracked(d, (0, dot_y), L["category"], f_eyebrow, (255, 214, 214), 0.16,
            anchor_right=W - M)

    f_title, lines = fit_title(d, L["title"], W - M * 2, 92, 0.055)
    ty = red_b - 40 - len(lines) * f_title.size * 1.06
    for ln in lines:
        tracked(d, (M, ty), ln, f_title, PAPER, 0.055)
        ty += f_title.size * 1.06

    # --- yellow band: price, facts, blurb, host
    f_price = anton(126)
    py = yel_t + 26
    tracked(d, (M, py), L["price"], f_price, INK, 0.02)
    # Anton's ₹ descends below the nominal em box; measure rather than assume,
    # or the unit label lands on top of the price.
    price_bottom = d.textbbox((M, py), L["price"], font=f_price)[3]
    f_unit = nunito(26, 900)
    tracked(d, (M + 6, price_bottom + 14), L["unit"], f_unit, (140, 84, 0), 0.16)

    f_fact = anton(50)
    fy = yel_t + 44
    for fact in (L["duration"], L["language"]):
        tracked(d, (0, fy), fact, f_fact, INK, 0.05, anchor_right=W - M)
        fy += f_fact.size * 1.18

    rule_y = yel_t + 218
    d.line([M, rule_y, W - M, rule_y], fill=INK, width=3)

    f_blurb = nunito(30, 700)
    by = rule_y + 26
    for ln in wrap_to(d, L["blurb"], f_blurb, W - M * 2):
        d.text((M, by), ln, font=f_blurb, fill=INK)
        by += f_blurb.size * 1.34

    f_chip = nunito(22, 900)
    cx = M
    for v in L["vibes"]:
        cx += chip(d, cx, yel_b - 92, v, f_chip, INK, INK) + 14
    f_host = nunito(24, 900)
    d.ellipse([W - M - 34, yel_b - 82, W - M, yel_b - 48], fill=TEAL)
    tracked(d, (0, yel_b - 78), L["host"], f_host, INK, 0.09,
            anchor_right=W - M - 48)

    im.save(out, "PNG")
    return im


# ------------------------------------------------ landscape (tablet + desktop)
def landscape(art, out, W, H, art_frac):
    """4:3 and 16:9 — the artwork is not stretched.

    It is cropped to a full-bleed panel and the bands become a typographic
    column beside it, so all three ratios read as one poster instead of three
    unrelated generations.
    """
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)

    # art panel, cover-cropped from the artwork region only
    aw = int(W * art_frac)
    src = art.crop((0, SRC_ART[0], art.width, SRC_ART[1]))
    scale = max(aw / src.width, H / src.height)
    src = src.resize((int(src.width * scale), int(src.height * scale)), Image.LANCZOS)
    left = (src.width - aw) // 2
    top = int((src.height - H) * 0.18)   # bias up: keep the face, drop the pan
    im.paste(src.crop((left, top, left + aw, top + H)), (0, 0))

    cx0 = aw
    cw = W - aw
    M = int(cw * 0.085)

    red_h = int(H * 0.34)
    yel_h = int(H * 0.30)
    d.rectangle([cx0, 0, W, red_h], fill=RED)
    d.rectangle([cx0, H - yel_h, W, H], fill=YELLOW)

    f_eyebrow = nunito(int(H * 0.021), 900)
    ey = int(H * 0.075)
    d.ellipse([cx0 + M, ey + 8, cx0 + M + 14, ey + 22], fill=PAPER)
    tracked(d, (cx0 + M + 28, ey), L["status"], f_eyebrow, PAPER, 0.16)
    tracked(d, (0, ey), L["category"], f_eyebrow, (255, 214, 214), 0.16,
            anchor_right=W - M)

    f_title, lines = fit_title(d, L["title"], cw - M * 2, H * 0.088, 0.055)
    ty = red_h - int(H * 0.045) - len(lines) * f_title.size * 1.06
    for ln in lines:
        tracked(d, (cx0 + M, ty), ln, f_title, PAPER, 0.055)
        ty += f_title.size * 1.06

    # white middle: blurb + facts
    f_blurb = nunito(int(H * 0.029), 700)
    by = red_h + int(H * 0.055)
    for ln in wrap_to(d, L["blurb"], f_blurb, cw - M * 2):
        d.text((cx0 + M, by), ln, font=f_blurb, fill=INK)
        by += f_blurb.size * 1.34

    by += int(H * 0.02)
    f_lab = nunito(int(H * 0.019), 900)
    f_val = anton(int(H * 0.040))
    for lab, val in (("DURATION", L["duration"]), ("LANGUAGE", L["language"])):
        tracked(d, (cx0 + M, by), lab, f_lab, (120, 110, 100), 0.16)
        tracked(d, (0, by - f_lab.size * 0.35), val, f_val, INK, 0.05,
                anchor_right=W - M)
        by += f_val.size * 1.35
        d.line([cx0 + M, by - 12, W - M, by - 12], fill=(226, 220, 210), width=2)

    # Vibe chips flow directly under the facts. Absolute-positioning them off
    # the yellow band is what made them land on top of the house rules.
    by += int(H * 0.012)
    f_chip = nunito(int(H * 0.018), 900)
    cxp = cx0 + M
    for v in L["vibes"]:
        cxp += chip(d, cxp, by, v, f_chip, INK, (200, 190, 178)) + 14
    by += f_chip.size + 24 + int(H * 0.030)

    # House rules — the landscape column has room the phone card doesn't, so the
    # wide poster carries what the quick-info popup would otherwise hold. Drawn
    # only while there is space above the yellow band; the rest is the popup's.
    limit = H - yel_h - int(H * 0.025)
    f_rule = nunito(int(H * 0.021), 600)
    if by + f_lab.size * 2 + f_rule.size * 1.4 < limit:
        tracked(d, (cx0 + M, by), "HOUSE RULES", f_lab, (120, 110, 100), 0.16)
        by += f_lab.size * 2.0
        for r in L["rules"]:
            lines = wrap_to(d, r, f_rule, cw - M * 2 - 24)
            if by + f_rule.size * 1.32 * len(lines) > limit:
                break
            d.ellipse([cx0 + M, by + f_rule.size * 0.42, cx0 + M + 7,
                       by + f_rule.size * 0.42 + 7], fill=RED)
            for ln in lines:
                d.text((cx0 + M + 22, by), ln, font=f_rule, fill=(72, 64, 56))
                by += f_rule.size * 1.32
            by += f_rule.size * 0.24

    f_price = anton(int(H * 0.110))
    py = H - yel_h + int(H * 0.045)
    tracked(d, (cx0 + M, py), L["price"], f_price, INK, 0.02)
    price_bottom = d.textbbox((cx0 + M, py), L["price"], font=f_price)[3]
    f_unit = nunito(int(H * 0.020), 900)
    tracked(d, (cx0 + M + 6, price_bottom + 12), L["unit"], f_unit,
            (140, 84, 0), 0.16)

    f_host = nunito(int(H * 0.021), 900)
    hy = H - int(H * 0.085)
    d.ellipse([W - M - 32, hy - 6, W - M, hy + 26], fill=TEAL)
    tracked(d, (0, hy), L["host"], f_host, INK, 0.09, anchor_right=W - M - 46)

    im.save(out, "PNG")
    return im


def main():
    art_path, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    art = Image.open(art_path).convert("RGB")
    portrait(art, os.path.join(outdir, "poster-portrait-2x3.png"))
    landscape(art, os.path.join(outdir, "poster-tablet-4x3.png"), 1600, 1200, 0.46)
    landscape(art, os.path.join(outdir, "poster-wide-16x9.png"), 2400, 1350, 0.50)
    print("wrote 3 posters to", outdir)


if __name__ == "__main__":
    main()
