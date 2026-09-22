# Saathum Bright Folk — Rajasthani design system v2

Owner-approved direction, 22 September 2026. This is the visual source of truth for the Saathum spiritual marketplace homepage and future pages that opt into the folk shell.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| `--folk-paper` | `#fff8e8` | Ivory page and paper panels |
| `--folk-ink` | `#55221d` | Deep brown copy and outlines |
| `--folk-red` | `#db3b2f` | Vermilion CTAs and accents |
| `--folk-saffron` | `#f59c24` | Kesar, marigold and highlights |
| `--folk-pink` | `#ee8fa6` | Gulabi accents and seals |
| `--folk-teal` | `#299e98` | Peacock and textile details, small category fields |
| `--folk-gold` | `#d2992e` | Antique-gold rules and ornaments |
| `--folk-muted` | `#765349` | Secondary copy |

The page is bright and saturated on a warm cream ground: saffron, vermilion, pink, teal and antique gold. Teal is welcome as a visible cultural accent and in small card fields. Keep large fields warm and readable; avoid cold blue or indigo backgrounds.

## Artwork

The art direction is respectful Indian Hindu folk art with Rajasthani Pichwai, Phad, palace-arch and painted-window references. The hero is a cohesive transparent sticker collage containing a Rajasthani palace arch, a woman performing aarti, a decorated elephant and a peacock. Supporting transparent stickers show Ganesh, a sacred decorated cow, devotional music, a female spiritual teacher with women participants, a lotus mark and a repeating floral border.

Every raster illustration is an original RGBA PNG with a thick crisp white die-cut contour and a distinct soft cast shadow. Keep the art separate from HTML copy: no text, prices, menus or fake UI inside a sticker. Preserve alpha transparency between subjects. Actual production dimensions are explicit in `FolkArtwork.astro`: hero/satsang `1536×1024`, Ganesh/cow/music/lotus `1254×1254`, and border `2172×724`.

Assets live in `web/public/assets/saathum-bright/`:

`hero.png`, `ganesh.png`, `cow.png`, `music.png`, `satsang.png`, `culture.png`, `lotus.png`, `border.png`.

Prompts and generation provenance are recorded in [`SAATHUM-BRIGHT-ART-PROMPTS.md`](SAATHUM-BRIGHT-ART-PROMPTS.md).

The build pipeline may emit immutable responsive copies. Pages reference the public asset path through `publicImage` and `publicImageSrcSet`; generation paths never appear in HTML.

The border is used as an optimized repeating background in the top ribbon and footer base. Size it around 100px high so the floral motif's central band remains visible inside the 44px strip.

## Typography and layout

Headings use Comfortaa with a friendly, rounded weight. Body, navigation, labels and buttons use Nunito. Readable HTML has generous paper space and a maximum content width of 1240px. Gutters are 36px on phones, 56px on tablets and 88px on desktop. Category cards use arched Indian-window silhouettes, white sticker rims and alternating gentle rotations. Content cards use white borders, warm interiors and soft brown shadows.

Buttons are vermilion with white text, a 3px white border, modest corner radius and a small warm shadow. Links remain visibly interactive. Focus rings are teal and must remain visible. Respect `prefers-reduced-motion`.

## Header and footer contract

`SiteHeader` and `SiteFooter` are rendered with `folk={true}` and `indiaLandingLanguage={false}`. The lotus sticker is the folk shell mark. `HOME_HEADER_LINKS` remains the single source for the complete Marketplace, Wiki, Pricing, Ideas, Experiences and For organisers menu. Authenticated users see Dashboard and Sign out; logged-out users see Log in and Sign up. The mobile drawer remains one modal with Escape handling and focus restoration.

`HOME_FOOTER_COLUMNS` remains the source for Bazaar, Creators and Company. All legal and safety links stay visible in the shared footer. The footer must retain historical marketplace, organiser, help, company and policy destinations, plus the exact line **Made in India with love ❤️ and cutting chai**.

## Homepage content and checks

The homepage keeps the existing `main-content`, `home-events`, `experiences`, `benefits`, `joining` and `organise-invite` hooks consumed by home telemetry. Sample cards are explicitly labelled `Sample event` and link to real marketplace search routes; no invented tickets, ratings or availability appear. The organiser CTA and payment/refund explanation remain visible.

CI homepage checks verify the bright asset set, alpha transparency, hero/cultural copy, preserved navigation and footer destinations, labelled samples, responsive overflow, artwork loading and mobile drawer behavior. Visual checks run in the explicitly dispatched web workflow; no local build or deployment is part of this design work.
