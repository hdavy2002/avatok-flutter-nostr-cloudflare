# AvaTOK Design System — Instructions for AI Designers

> **Who this is for:** Any AI (or human) designing new screens for the AvaTOK app.
> **What this is:** The complete, binding visual language. Read it fully before producing a single pixel.
> **Reference implementations in this project:**
> - `AvaTOK Landing.html` — the master document. Marketing site, richest component inventory.
> - `AvaTOK Pick Your Handle.html` — onboarding app screen (hero/crest + single-field pattern).
> - `AvaTOK Welcome Back.html` — login app screen (form pattern, error states, success overlay).
> - `AvaVerse Earnings.html` — dashboard app screen (appbar band, cards, metrics, ledger).
> - `avatok-logo.svg` — the brand mark. Always load it from this file; never redraw it.
>
> ⚠️ `AvaExplore Marketplace.html` and `AvaTOK Create Listing.html` are **legacy screens in an older, deprecated style** (white Material-ish UI, teal `#14b8a6` accent, DM Sans). Do NOT copy from them. New screens must use the system below; those two should eventually be migrated.

---

## 1. The vibe (read this first)

AvaTOK is a Gen-Z social app where **users own everything** — their data, their feed, their money. The visual language expresses that with **editorial / zine / collage energy**: it looks hand-assembled, like someone cut things out with scissors and taped them to paper. Confident, playful, a little punk — never corporate, never sterile.

Concretely, that means:

- **Paper, not pixels.** Warm off-white paper background. Everything sits ON the paper like a physical object.
- **Cut-and-paste artifacts.** Tape strips, halftone dot patches, marker-highlighted words, sticker pills, slight rotations (-4° to 4°) on decorative elements.
- **Hard offset shadows, never blurs.** Objects cast flat, solid ink shadows (`6px 7px 0 var(--ink)`) like paper layers. NEVER use blurred drop shadows (`box-shadow: 0 4px 12px rgba(...)` is forbidden).
- **Thick ink outlines.** Almost every component has a `2.5px solid var(--ink)` border. Big containers and the phone frame get `3px`.
- **Flat poster-color fills.** Accents are solid blocks of color — blue, lime, coral, lilac, mint. **NO gradients, anywhere, ever.**
- **NO dark theme.** The only "dark" surface allowed is the deep-teal CTA banner card on the landing page.
- **Light theme, warm ink.** Text is warm near-black, never pure `#000`.

### Forbidden (instant style violations)
- Gradients of any kind (backgrounds, buttons, text)
- Blurred/soft box-shadows
- Dark mode / dark backgrounds (except the one deep-teal banner pattern)
- Borderless "floating" cards
- Glassmorphism, neumorphism
- Thin/hairline (1px) borders as primary container borders
- Pure black `#000` or pure white `#fff` for large surfaces
- Default-blue links, underlined-text-only links
- Sharp 0px corners on cards/buttons (radii are generous)
- Inter, Roboto, Arial, or any font outside the three brand fonts

---

## 2. Color tokens

All colors are defined in `oklch`. Copy this `:root` block verbatim into every new screen:

```css
:root {
  /* surfaces */
  --paper:   oklch(0.975 0.013 95);   /* page background — warm off-white */
  --paper-2: oklch(0.955 0.018 92);   /* tinted band / secondary surface */
  --card:    oklch(0.995 0.004 95);   /* card & component surface (near-white) */

  /* ink (text + borders) */
  --ink:      oklch(0.23 0.018 60);   /* primary text, ALL borders, ALL shadows */
  --ink-soft: oklch(0.42 0.02 62);    /* secondary text */
  --ink-mute: oklch(0.60 0.02 62);    /* tertiary text, disabled, captions */

  /* poster accents — flat fills only */
  --blue:     oklch(0.92 0.085 190);  /* pale aqua-blue — brand fill */
  --blue-ink: oklch(0.52 0.12 196);   /* deep teal-blue — accent TEXT color, "TOK" in logo */
  --lime:     oklch(0.88 0.18 124);   /* acid lime — primary action color, highlights */
  --coral:    oklch(0.70 0.19 32);    /* coral — destructive/error/spicy accents (white text on it) */
  --lilac:    oklch(0.80 0.10 305);   /* lilac — AI/magic features */
  --mint:     oklch(0.86 0.14 158);   /* mint — money/success (Earnings screen) */
  --mint-ink: oklch(0.55 0.13 158);

  /* geometry */
  --r: 22px;                          /* default card radius */
  --r-sm: 16px;                       /* small card / tile radius */
  --shadow: 6px 7px 0 var(--ink);     /* large offset shadow */
  --shadow-sm: 3px 3px 0 var(--ink);  /* small offset shadow */

  /* halftone dot patch (decorative) */
  --dots: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='15' height='15'%3E%3Ccircle cx='2' cy='2' r='1.5' fill='%23231f18'/%3E%3C/svg%3E");
}
```

### Color usage rules
| Token | Use for | Never use for |
|---|---|---|
| `--paper` | page/phone background | cards |
| `--paper-2` | tinted bands, appbar band, disabled fills, secondary tiles | primary actions |
| `--card` | every card, button base, field, chip | page background |
| `--ink` | ALL text, ALL borders, ALL shadows | large fills (except notch/small seals) |
| `--blue` | brand badges, icon badges, secondary buttons, checkmark circles | text |
| `--blue-ink` | accent text ("TOK"), links, kickers, focused-state shadows | large fills |
| `--lime` | THE primary action color: main buttons, active chips, marker highlights, "@" field prefix | error states |
| `--coral` | errors, destructive actions, decorative stars, "taken" states. Text on coral is `#fff` | success |
| `--lilac` | AI-related features (AI chat bubbles, magic actions) | generic accents |
| `--mint` | money, earnings, success seals, payout pills | unrelated decoration |

**White text (`#fff`) is allowed only on `--coral` fills.** Everything else gets `--ink` text, including lime, blue, lilac, mint fills.

Tint variants for subtle backgrounds: use the same hue with alpha, e.g. `oklch(0.88 0.18 124 / 0.62)` (tape), `oklch(0.70 0.19 32 / 0.34)` (coral highlight). Don't invent new hues — if you need a new color, derive it in oklch with chroma/lightness consistent with the existing accents.

---

## 3. Typography

Exactly three fonts. Load via Google Fonts:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:ital,wght@0,400;0,600;0,700;0,800;0,900;1,700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
```

| Font | Role | Rules |
|---|---|---|
| **Fredoka** | Display: all headings, button labels, big numbers, card titles, brand wordmark | weight 600 default (700 sparingly), `letter-spacing: -0.01em` to `-0.03em` (tighter as size grows), `line-height: 1.0–1.1` |
| **Nunito** | Body: paragraphs, descriptions, input text, list labels | **weight 600 minimum — never 400 for UI text.** Body copy 700, emphasized values 800–900. Secondary text gets `color: var(--ink-soft)`, not lighter weight |
| **Space Mono** | Collage labels: kickers, eyebrows, field labels, status bars, tags, captions, sticker text, links | always weight 700, almost always `text-transform: uppercase` + `letter-spacing: 0.04–0.14em`, sizes 10.5–15px |

### Type scale (mobile app screens)
| Element | Font | Size | Notes |
|---|---|---|---|
| Screen hero title | Fredoka 600 | 34–38px | `line-height: 1.08`, center on auth/onboarding |
| Appbar title | Fredoka 600 | 27px | with `.mark` highlight on part of the word |
| Card title | Fredoka 600 | 19px | next to an icon badge |
| Big stat / money | Fredoka 600 | 38–58px | `letter-spacing: -0.02em`+ |
| Button label | Fredoka 600 | 17–22px | |
| Body / subtitle | Nunito 700 | 14.5–16px | `color: var(--ink-soft)`, `text-wrap: pretty`, `max-width: 28–30ch` for centered subs |
| Input text | Nunito 800 | 18–19px | |
| Field label / kicker | Space Mono 700 | 11px | uppercase, `letter-spacing: 0.08em`, `--ink-soft` |
| Caption / tag | Space Mono 700 | 10.5–13px | uppercase |

### The `.mark` marker highlight
Brand signature — a hand-drawn highlighter stripe behind a word (used on the "TOK"/keyword of titles):

```css
.mark { position: relative; z-index: 0; white-space: nowrap; }
.mark::after {
  content: ""; position: absolute; left: -3px; right: -3px; bottom: 0.06em; height: 0.40em;
  background: var(--lime); z-index: -1; border-radius: 3px; transform: rotate(-1.2deg);
}
```
Use on ONE word per title, max. Variants: lime (default), `oklch(0.80 0.16 192 / 0.5)` blue, `oklch(0.70 0.19 32 / 0.34)` coral.

### Brand wordmark
"Ava" in ink + suffix in `var(--blue-ink)`: `Ava<span class="tok">TOK</span>` / AvaVerse / AvaExplore. Fredoka 600–700, `letter-spacing: -0.02em`. Sub-brands follow the same Ava+Word pattern; on app bars the suffix takes the `.mark` highlight instead of color.

---

## 4. Geometry: borders, radii, shadows

- **Borders:** `2.5px solid var(--ink)` on every interactive or contained element. `3px` for the phone frame, hero crest badges, and extra-large containers. `2px` only for tiny things (avatars, mini pips). Dashed `2.5px dashed` for "empty/inactive/ghost" elements.
- **Radii:** cards `22px (--r)`, small tiles `14–18px`, buttons/chips/pills `100px` (full pill), phone frame `46px`, icon badges `11–14px`, circles `50%`.
- **Shadows:** ONLY hard offsets of solid ink. `--shadow-sm: 3px 3px 0 var(--ink)` for buttons/chips/small cards; `--shadow: 6px 7px 0 var(--ink)` for hero cards/badges; `10–12px 12–14px 0` for the phone frame itself. Special states may swap shadow color: focused field → `5px 6px 0 var(--blue-ink)`, error field → `5px 6px 0 var(--coral)`.
- **Spacing rhythm:** screens pad `18–24px` horizontally; gaps between cards `14–16px`; inside cards `18–22px` padding. Section gaps on marketing pages `70–90px`.

---

## 5. Motion & interaction states

The physics: **objects lift toward you on hover, press into the paper on click.**

```css
/* hover: lift up-left, shadow grows */
.thing:hover  { transform: translate(-2px,-2px); box-shadow: 5px 6px 0 var(--ink); }
/* active: press down-right, shadow nearly vanishes */
.thing:active { transform: translate(2px,2px);  box-shadow: 1px 1px 0 var(--ink); }
```

- Transitions: `transition: transform .12s ease, box-shadow .12s ease, background .15s ease;` — fast and snappy, `.1–.34s` range, easing `ease` or `cubic-bezier(.4,0,.2,1)` for larger moves.
- Hover may also recolor the fill (e.g. back button turns lime, social icon turns lime).
- Arrow icons inside buttons nudge: `.btn:hover .arrow { transform: translateX(3px); }`
- Disabled: `background: var(--paper-2); color/border: var(--ink-mute); box-shadow: none; cursor: not-allowed.`
- Loading: swap label for a spinner (`@keyframes spin`), keep button size stable.
- **Always include:** `@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }` (and kill animations).
- No infinite decorative animation inside app screens (marquees are landing-page only).

---

## 6. Iconography & decoration

- **Icons: Iconify + Phosphor**, bold or fill variants only (`ph:wallet-bold`, `ph:lightning-fill`). Load once:
  `<script src="https://code.iconify.design/iconify-icon/2.1.0/iconify-icon.min.js"></script>`
  Never mix icon sets; never use thin/outline-light variants.
- **Icon badge** (precedes every card title): 34×34px, `border-radius: 11px`, `2.5px` ink border, flat accent fill, 18px icon. Rotate accent colors so adjacent cards differ (blue, lime, coral, lilac, mint).
- **Tape strip:** translucent lime rectangle with dashed edges, rotated ±4°, overlapping a card's top edge. One per screen max.
  ```css
  .tape { position: absolute; width: 92px; height: 24px; background: oklch(0.88 0.18 124 / 0.6);
    border-left: 1px dashed rgba(0,0,0,.18); border-right: 1px dashed rgba(0,0,0,.18);
    top: -8px; transform: rotate(4deg); }
  ```
- **Dot patch:** halftone texture block placed behind/beside heroes. `background-image: var(--dots); background-size: 15px 15px; opacity: .55–.85;`
- **Stars/sparkles:** small coral 4-point stars as accents near crests. Use the existing SVGs from reference files.
- **Paper texture** on app backgrounds: `background-image: radial-gradient(oklch(0.23 0.018 60 / 0.05) 1px, transparent 1px); background-size: 22px 22px;`
- **Imagery:** never hand-draw illustration SVGs. Use striped placeholder blocks with a Space Mono tag describing the needed asset (see `.post-img .ph-tag` in the landing). Avatars are bordered circles with flat color fills + Fredoka initials.
- **Emoji:** allowed sparingly as icon stand-ins in chips/stickers (it's a Gen-Z brand), never in headings or body copy.

---

## 7. Component recipes

Copy these exactly; don't reinvent. Full working CSS lives in the reference files.

### 7.1 Primary button (lime pill)
```css
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 19px;
  padding: 14px 24px; border-radius: 100px; border: 2.5px solid var(--ink);
  background: var(--lime); color: var(--ink);
  box-shadow: var(--shadow-sm); cursor: pointer; white-space: nowrap;
  transition: transform .12s ease, box-shadow .12s ease, background .15s ease;
}
.btn:hover  { transform: translate(-2px,-2px); box-shadow: 5px 6px 0 var(--ink); }
.btn:active { transform: translate(2px,2px);  box-shadow: 1px 1px 0 var(--ink); }
```
Variants: `.blue` (secondary), `.coral` (destructive, white text), `.ghost` (card fill). Full-width on mobile forms (`width: 100%`, font-size 21–22px, padding 17px). Hierarchy: ONE lime button per screen.

### 7.2 Text field (the "field" pattern)
A pill-ish box (radius 18px) with ink border + small shadow, containing an optional **leading cell** (lime fill, right ink border — holds "@" or an icon), the input (Nunito 800, 18–19px), and optional trailing cell (reveal-password etc., left ink border).
- Label above: Space Mono 700, 11px, uppercase, `--ink-soft`.
- Focus: `box-shadow: 5px 6px 0 var(--blue-ink); transform: translate(-1px,-1px);`
- Error: shadow turns coral + error message below in Space Mono coral with `ph:warning-bold`.
- Placeholder: `oklch(0.62 0.02 62)`, Nunito 700.

### 7.3 Card
```css
.card { background: var(--card); border: 2.5px solid var(--ink);
        border-radius: var(--r); box-shadow: var(--shadow-sm); padding: 18px; }
```
Card head = icon badge + Fredoka 19px title + optional right-aligned Space Mono tag. Accent-filled cards (`--blue`, `--lime`, `--coral`) are allowed for emphasis cells in grids.

### 7.4 Chips (filter/segmented)
Pill, `2.5px` ink border, card fill, Space Mono 700 12.5px. Active: `background: var(--lime); box-shadow: var(--shadow-sm);` plus a `ph:check-bold` icon that appears only when active. Equal-width row: `display: flex; gap: 9px;` with `flex: 1`.

### 7.5 Sticker / tag pill
Space Mono 700 12–14px uppercase pill with ink border + `--shadow-sm` (or `2px 2px 0`). Used for availability states (`.avail.ok` lime / `.avail.no` coral / hint = dashed border, no shadow), suggestion chips, eyebrow labels.

### 7.6 Links
Space Mono 700, colored `var(--blue-ink)`, **underlined with a 2.5px solid accent border-bottom** (blue or coral), and on hover the accent becomes the background. Never default underlines.

### 7.7 Back button / icon button
42×42px circle, ink border, card fill, `--shadow-sm`, Phosphor bold icon 20px. Hover: lift + lime fill.

### 7.8 Step indicator (onboarding)
Row of 9px circle pips with ink borders; active pip filled `--coral`; trailing Space Mono label like `STEP 2 / 4`.

### 7.9 Hero crest (auth/onboarding screens)
Centered 104–116px circle badge (blue fill, 3px border, `--shadow`) holding the logo SVG, with tape strip on top, dot patch behind one corner, small coral star floating beside. See `Pick Your Handle`.

### 7.10 Ledger rows (money/data lists)
Label (Nunito 700, `--ink-soft`) + dotted leader line filling the middle + value (Nunito 900). Highlighted row's value becomes a mint pill with ink border + shadow. See `Earnings`.

### 7.11 Metric card
Icon badge + title, then Fredoka 38px number, then Space Mono uppercase caption. Two-up via `.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }`.

### 7.12 Empty states
Friendly, never blank: dashed-border glyph tile (30px, `2px dashed` ink @30%) + one short Nunito 700 `--ink-soft` line. Or for full-screen empties: crest-style seal + Fredoka headline + short sub. No sad-face imagery.

### 7.13 Success overlay
Full-screen paper overlay: 120px lime circle seal (3px border, `--shadow`, rotated -4°) with a check/emoji, Fredoka 34px headline, short Nunito sub. See `Welcome Back`.

### 7.14 Chat bubbles
`2.5px` ink border, radius 16px with one squared corner toward the sender; them = card, me = lime, AI = lilac. Nunito 700 13px.

### 7.15 Comparison cards ("old way vs our way")
Two-up grid; old = `oklch(0.95 0.035 25)` fill with coral mono kicker, ours = `oklch(0.95 0.05 190)` fill with blue-ink kicker.

### 7.16 Dark CTA banner (landing only)
The single permitted dark surface: `background: oklch(0.27 0.042 188)` card, radius 36px, ink border + `--shadow`, paper-colored Fredoka headline, light/dark button pair with deep-teal offset shadows.

---

## 8. App screen anatomy (phone shell)

Every app mock is a phone frame on the dotted paper desk. Skeleton:

```html
<body>                      <!-- paper bg + radial-dot texture, centers the stage -->
  <div id="stage">          <!-- 392×844, transform-scaled to fit viewport -->
    <div class="phone" data-screen-label="Screen Name">
      <div class="notch"></div>
      <div class="statusbar"> <!-- Space Mono 700 13px: time left; wifi/signal/battery (ph: fill icons) right --> </div>
      <!-- EITHER: .appbar band (dashboards) OR .scr-head (auth/onboarding) -->
      <div class="screen"> <!-- flex:1, scrollable, hidden scrollbar, padding 18px --> </div>
    </div>
  </div>
</body>
```

- **Phone:** width 360–392px, `border: 3px solid var(--ink)`, `border-radius: 46px`, `box-shadow: 10px 12px 0 var(--ink)` (up to `12px 14px 0`), ink notch pill 104×24.
- **Appbar band** (dashboard screens): `--paper-2` fill, `border-bottom: 2.5px solid var(--ink)`, back button + Fredoka 27px title (with `.mark`) + Space Mono uppercase tag underneath.
- **Auth/onboarding screens:** no band; `.scr-head` row = back button left, step pips or mono tag right; then crest, centered title, sub, form, flexible spacer, full-width button pinned to bottom, mono footnote ("secured" line) underneath.
- Include a JS scale-to-fit on `#stage` so the phone letterboxes into any viewport (copy from `AvaVerse Earnings.html`).
- Tap targets ≥ 44px. Hidden scrollbars (`scrollbar-width: none` + webkit rule).

---

## 9. Voice & copy

- Lowercase-leaning, confident, short. Kickers and labels ALL-CAPS mono ("CREATOR EARNINGS", "STEP 2 / 4").
- Friendly verbs on buttons: "Let's go", "Claim it", "Create a listing" — never "Submit", "OK", "Proceed".
- Subtitles ≤ 30ch, `text-wrap: pretty`.
- Empty states reassure: "All caught up", "No listings yet — check back soon."
- Money/ownership language is direct: "your 80%", "straight to your wallet", "you own it all."
- No exclamation-mark spam; one max per screen.

---

## 10. Build checklist for every new screen

1. ☐ Copied the `:root` tokens, font links, Iconify script, and favicon link verbatim
2. ☐ Paper background + dot texture; phone shell per §8 (if app screen)
3. ☐ Every container: ink border ≥2.5px + hard offset shadow, generous radius
4. ☐ Zero gradients, zero blurred shadows, zero pure black/white surfaces
5. ☐ Fonts: Fredoka headings / Nunito ≥600 body / Space Mono labels — nothing else
6. ☐ One lime primary action max; hierarchy via blue/ghost variants
7. ☐ One `.mark` highlight in the title; ≤1 tape strip; ≤1 dot patch; decorations rotated slightly
8. ☐ Hover = lift up-left, active = press down-right, on every interactive element
9. ☐ Focus/error/disabled/empty/loading states designed (not just default)
10. ☐ Phosphor bold/fill icons only; icon badges rotate accent colors
11. ☐ `prefers-reduced-motion` guard present
12. ☐ `data-screen-label` on the screen root; tap targets ≥44px
13. ☐ Copy follows §9 voice; no filler content, no fake stats
14. ☐ Compare side-by-side with `AvaVerse Earnings.html` — if your screen looks like it's from a different app, fix it

---

## 11. Extending the system (when you need something new)

- New accent color → define in oklch, lightness 0.70–0.92, chroma in line with existing accents (0.08–0.19); pair it with an `-ink` text variant (lightness ~0.52–0.55, higher chroma).
- New component → compose from existing primitives (bordered box + offset shadow + pill + mono label). It should look like it could be cut out and taped down.
- New sub-brand surface (AvaDate, AvaPay…) → same Ava+Word wordmark pattern, pick ONE signature accent for it (e.g. Earnings leans mint), keep everything else identical.
- When unsure, open the four reference files and find the nearest precedent. Precedent beats invention.
