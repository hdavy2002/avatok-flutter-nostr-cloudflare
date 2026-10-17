# Hello Fraands design system — "desi" (owner decision 2026-10-17)

**This is the design philosophy for every Hello Fraands page — new pages and every page we touch.**
The reference implementation is the homepage: source `web/design/desi-home.source.html`, built by
`web/scripts/build-desi-home.py` into `web/src/components/home/desi-home-body.html` +
`web/src/styles/desi-home.css`. When this file and the homepage disagree, the homepage wins and this
file is updated in the same change. Rule ids live in `Specs/RULEBOOK-HELLO-FRAANDS.md` (HF-SITE-20/21/22, HF-DS-1).

## 1. Ethos

- **Desi, loud, warm, handmade.** Indian street and folk art — truck art, marigold torans, Warli,
  block print, Madhubani, rangoli, Bollywood posters, chai tapri — on a warm cream page. Never a
  generic SaaS look.
- **Hinglish voice.** Eyebrows and stickers speak Hinglish ("Ek call toh banta hai", "Kya scene hai",
  "Bas karo scroll. Baat karo."); headlines are short, punchy English with a Hinglish twist
  ("From Reel se Real tak."). Body copy is plain, friendly English.
- **Full width, never boxy.** Bands run edge to edge; content sits in `.wrap`
  (`width: calc(100% - 64px); max-width: 1760px`, 32px gutters ≤900px). No narrow centred column.
- **Every section is distinguishable.** Alternate band colours or add a block-print strip between
  sections, with generous padding (desktop 72–96px top/bottom, phones 56–72px). Two sections on the
  same background must never touch without a separator.
- **Owner's standing rules:** never green as a UI colour (green only inside artwork); no tiny fonts;
  only two fonts; one standard type scale (the homepage's); don't redesign his approved designs —
  copy changes go inside existing elements; mock first for any redesign.

## 2. Colour tokens

| Token | Hex | Use |
|---|---|---|
| ink | `#30245f` | All text, 3px borders, hard shadows, dark buttons, dark band (marquee) |
| magenta | `#be246e` | Accent headline words, eyebrows, magenta band, dark-button shadow |
| orange | `#ff793c` | Accent headline words, orange band (How it works), badges |
| yellow | `#fbd447` | Highlight behind headline words, yellow band (app), eyebrow on magenta |
| cream (page) | `#fff2cf` | Page background |
| paper | `#fffdf7` | Light buttons, cards, download band, creators band |
| pink | `#efabd0` | Card / chip fill |
| lavender | `#bfc2ee` | Card / chip fill |
| peach | `#ffa179` | Card / chip fill |
| light yellow | `#ffdf89` | Card fill |

Text on magenta / ink bands is cream `#fff2cf`; eyebrow on magenta is yellow.

## 3. Type

- **Two fonts only: Nunito for headlines, Comfortaa for everything else** (owner rule). Loaded from
  Google Fonts (Comfortaa 500/700, Nunito 400–800/900).
- Display headline (`.disp`): weight 700–900, tight line-height (~0.98–1.06), sizes
  `clamp(44px, 6.4vw, 96px)` for section titles, `clamp(50px, 7vw, 120px)` for the hero.
- Eyebrow (`.eyebrow`): `clamp(13px, .8vw, 16px)`, weight 800, letter-spacing .22em, UPPERCASE,
  usually magenta.
- Body: `clamp(17px, 1.15–1.35vw, 25px)`, weight 600, line-height 1.5.
- **Yellow highlight** on a headline phrase: `<span class="hl">` — `display:inline-block`,
  `background:#fbd447`, `border-radius:10–12px`, `padding:0 10–12px`, `margin-top:.12em` so it never
  covers the line above.
- Footer column headers: Nunito 900, 1.25rem, ink — they must read as headers, not links.
- Never negative letter-spacing on bold/display type; never synthesised bold.

## 4. Shapes and components

- **Borders & shadows:** 3px solid ink borders; hard offset shadows (no blur):
  `6px 6px 0 #30245f` (light), `6px 6px 0 #be246e` (dark button), `8px 8px 0 #30245f` (cards).
  Radius 14px (buttons), 18–24px (cards).
- **Buttons:** `.btn.btn-dark` (ink fill, cream text, magenta shadow) and `.btn.btn-light`
  (paper fill, ink text, ink shadow); Nunito 800, min-height 48px.
- **Store buttons:** always the truck-art artwork `btn-google-play.webp` / `btn-app-store.webp`
  (`.store-btn`), never text buttons. App Store is a non-link "Coming soon" until listed.
- **Chips:** pill, 2px ink border, palette fills (yellow, pink, lavender, peach).
- **Cards:** `.reason` (paper/palette fill, 3px border, dashed yellow inner outline) and creator
  cards (palette fill, dashed inner outline, ink hard shadow, round badge top-right).
- **Stickers:** truck-art badges with Hinglish text, rotated −3° to −8°, `clamp(240px, 20–24vw, 470px)`.
  Every sticker's text is checked for spelling. Placed beside a title or between copy and art,
  never on top of the main artwork. On phones they are centred and may be hidden if they cover art.
- **Ornament strips:** `.toran` (marigold garland; hangs flush from the header bottom and from the
  last band above the footer), `.bp-border` (block-print strip between sections), `.warli-strip`
  (Warli dancers at a band's foot), `.bp-bg` (block-print tile wash at low opacity).
- **Bands:** cream, paper, ink (marquee "HORN OK PLEASE"), magenta, orange, yellow — each with
  3px ink top/bottom border.

## 5. Artwork library (`web/public/assets/hf-desi/`, `web/public/hf/stickers/`)

Hero rickshaw woman, jhoola women, train of creators, dhol-wala (mirrored on desktop, hidden on
phones), rangoli mandala, Madhubani fish pair, elephant with padlock (privacy), Bollywood poster,
chai tapri, Warli friends, toran marigold, border strip, block-print tile; stickers: Arre waah, Bas
karo scroll, Kya scene hai, Ek call toh banta hai, Reels se real tak, Chai pe charcha; store
buttons. All art goes through `publicImage()` (Cloudflare AVIF pipeline) — never a raw `<img src>`
to a large file. New art matches the same flat, bold-outlined Indian folk/truck-art style.

## 6. Responsive rules (≤900px phones and tablets)

- Every section's eyebrow, title, text, stickers and buttons are **centred**.
- Two-column grids collapse to one; art sits above or below copy, centred.
- Titles keep the owner's line breaks (e.g. "You see them on reels. / Now talk for real.") —
  shrink the size to fit rather than wrap differently.
- Stickers that sit on top of art on desktop are hidden on phones.
- No horizontal scroll at 390px; tap targets ≥44px.

## 7. Checklist for a new or changed page

1. Uses the shared header/footer (`components/callvaal/Header.astro`, `Footer.astro`).
2. Cream page, full-width bands, `.wrap` content, sections separated by colour or a strip.
3. Nunito headlines / Comfortaa body only; the homepage type scale; no tiny text.
4. Colours from section 2 only; no green UI.
5. At least one piece of desi artwork or a sticker per screenful where it fits the content.
6. Hard-shadow buttons/cards, 3px ink borders.
7. Phone check at 390px and tablet at 820px: centred, no overflow.
8. Brand name from `Specs/brand.json` (never typed); PostHog events per the telemetry catalog.
