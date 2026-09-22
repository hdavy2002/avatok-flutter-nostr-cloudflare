# Saathum Booking Folk — design system v3

Owner-approved direction, 22 September 2026. This document is the source of truth for the Saathum spiritual marketplace homepage.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| `--folk-paper` | `#fff8e8` | Cream page and footer |
| `--folk-ink` | `#163f3c` | Teal ink and copy |
| `--folk-red` | `#c94637` | Headings, rules and CTAs |
| `--folk-saffron` | `#f2a42b` | Ribbon and highlights |
| `--folk-pink` | `#e98ca1` | Hero seal |
| `--folk-teal` | `#247e78` | Accent and focus |
| `--folk-gold` | `#c69238` | Decorative rules |
| `--folk-muted` | `#5a6e69` | Secondary copy |

The page is bright and warm on a cream ground. Use teal ink, vermilion red, saffron, pink and antique gold. Keep large fields readable and avoid cold blue or indigo backgrounds.

## Artwork

The hero and supporting illustrations remain original RGBA PNG stickers with a white die-cut contour and soft shadow: hero, Ganesh, cow, devotional music, satsang teacher, culture craft and lotus. They use `FolkArtwork.astro` and the immutable `publicImage` pipeline.

The booking revision adds nine opaque scene images in `web/public/assets/saathum-booking/`:

- `category-puja.png`, `category-aarti.png`, `category-bhajan.png`, `category-satsang.png`, `category-festival.png`, `category-yoga.png` are 1254×1254 square devotional scenes with a large ornate Indian arch.
- `listing-aarti.png`, `listing-puja.png`, `listing-bhajan.png` are landscape photographs for sample listing cards.

`BookingArtwork.astro` references these through `publicImage` and `publicImageSrcSet`. The organiser strip also uses the transparent 1536×1024 `elephant.png` twice, mirrored with CSS. The source artwork paths never appear as mutable generation URLs in HTML.

## Typography and layout

Headings use Comfortaa and body, navigation, labels and buttons use Nunito. The homepage has a maximum content width of 1240px with 88px desktop gutters, 56px tablet gutters and 18px phone gutters.

Category tiles are compact rectangular white cards. Their square art fills the upper area; a short label, descriptor and small arrow sit below. The arch belongs inside the image and never forms the outer card silhouette.

Listing cards have straight white borders, a wide opaque photograph, a compact category/title/description block and a clear Explore link. They do not use rotated cards, stamps, stickers or fabricated tickets, ratings or availability.

Buttons are vermilion with white text and a modest shadow. Focus rings are teal and remain visible. Respect `prefers-reduced-motion`.

## Header, footer and content contract

`SiteHeader` and `SiteFooter` render with `folk={true}`; the homepage root uses `data-design="saathum-booking-v3"` so legacy folk chrome cannot bleed into other routes. Authenticated users retain Dashboard and Sign out; logged-out users retain Log in and Sign up. The responsive drawer remains a modal with Escape and focus restoration.

`HOME_FOOTER_COLUMNS` remains the source for every Bazaar, Creators and Company menu link. Legal and safety links stay visible. The folk footer is cream with centered wrapping menus, no boxed columns, and ends with the exact line **Made in India with Love ❤️ and cutting chai.**

The hero states that Saathum helps people explore, book and join Hindu religious experiences. Sections retain `main-content`, `home-events`, `experiences`, `benefits`, `joining` and `organise-invite` for telemetry. Sample cards say `Sample event` and link to truthful marketplace search routes. The organiser strip keeps a concise community CTA, and the payment/refund explanation remains visible.

CI checks validate the new asset set, immutable image URLs, alpha sticker assets, artwork loading, copy, complete navigation/footer parity, responsive overflow and mobile drawer behavior. Builds and visual checks run only in the dispatched GitHub Actions workflow.