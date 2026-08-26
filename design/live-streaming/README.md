# avaTOK — Bazaar UI package (integration guide)

Frontend design package for the avaTOK live-experiences marketplace. Written for an AI/engineering
agent wiring these screens to a real backend. Everything currently runs on mock data held inside
each page's logic class — every mock is listed below with the backend contract it expects.

## Files

| File | What it is |
|---|---|
| `avaTOK Marketplace.dc.html` | Marketplace / search / category browse page |
| `avaTOK Listing Details.dc.html` | Listing details + availability calendar + booking + live-show states (main deliverable) |
| `avaTOK Auth.dc.html` | Auth screens |
| `avaTOK Design System.dc.html` | Palette, type, component reference |
| `SiteHeader.dc.html`, `SiteFooter.dc.html` | Shared chrome, imported by every page via `<dc-import>` |
| `TruckBorder.dc.html` | Decorative truck-art border strips (`kind`: jhalar/tassels/chai/lotus/eyes/auto) |
| `support.js` | Design Component runtime. Do not edit. Pages open directly in a browser. |
| `assets/` | Stickers and art (transparent PNGs) |

## How a page is structured

Each `.dc.html` file has two halves:

1. **Template** — HTML between `<x-dc>…</x-dc>`. `{{ name }}` holes are filled from the logic class.
   All styling is inline (no stylesheets to hunt through).
2. **Logic** — `class Component` inside `<script data-dc-script>`. `state` holds UI state,
   `renderVals()` returns everything the template reads. **All mock data lives here.**

To integrate: replace the mock producers in `renderVals()` / helper methods with API data, keep the
returned value shapes identical.

## Element wiring map (`data-wire` attributes)

Every interactive element in the Listing Details page carries a `data-wire` attribute naming its
backend responsibility. Grep for `data-wire="…"` to locate the element; the handler it calls is in
the adjacent `onClick`.

### Booking flow
| data-wire | Element | Backend contract |
|---|---|---|
| `availability.month.prev/next` | calendar month arrows | `GET /listings/:id/availability?month=YYYY-MM` → `{ days: [int] }` (replaces `availDays()`) |
| `availability.date.select` | calendar day cell | client-side select; fetch slots for the date |
| `availability.slot.select` | slot row buttons | `GET /listings/:id/slots?date=YYYY-MM-DD` → `[{ id, time, label, total, taken }]` (replaces `slotDefs()`). **Seat counts must be real inventory — no synthetic scarcity.** |
| `booking.qty.increment/decrement` | seat stepper | client-side; clamp to `slot.left`, max 4 |
| `booking.create` | BOOK button | `POST /bookings { listingId, date, slotId, qty }` → `{ bookingId, total }`. Show returned total; UI already displays the full quote (ticket + flat fee + GST) **before** this call — keep that order. Quote math lives in `renderVals()` (`base/fee/gst/total`); replace with `POST /bookings/quote` if fees are dynamic. |
| `booking.cancel` | CHANGE/CANCEL link in confirmation | `DELETE /bookings/:id`. Free-cancel window: 24h before showtime (copy in UI). |
| `booking.count` | "✓ N BOOKED" pill on player | live count for the selected show date; poll or push |

### Live show
| data-wire | Element | Backend contract |
|---|---|---|
| `stream.status` | ticker bar under breadcrumb | `GET /listings/:id/live` or websocket → `{ state: 'live'|'countdown', viewers, endsAt, nextShowAt }`. Currently driven by the `liveState` prop. |
| `stream.viewers` | "◉ N WATCHING" pill | live viewer count (websocket topic suggested) |
| `stream.countdown` | DD/HH/MM/SS chips on player | client ticks locally from `nextShowAt` (see `nextShow()`), 1s interval already implemented |
| `stream.join` | JOIN NOW buttons (ticker, player overlay, booking card) | `POST /bookings/:id/join` → `{ streamUrl }` then redirect. UI already gates: non-ticket-holders get "book a seat first" (`joinTry()`/`joined` state). |

### Social & sharing
| data-wire | Element | Backend contract |
|---|---|---|
| `favorites.toggle` | ♡ button on player | `PUT /me/favorites/:listingId` (optimistic toggle already in `state.fav`) |
| `share.whatsapp/facebook/youtube` | share pills | client-side `window.open`; replace `SHOW_URL` constant (top of logic class) with the real canonical URL |
| `share.link.copy`, `share.embed.toggle/copy` | copy link, embed dropdown | embed iframe src is `SHOW_URL + '/embed'` — backend must serve an embeddable player there |
| QR code `<img>` in share card | hardcoded api.qrserver.com URL | regenerate server-side or keep; encodes `SHOW_URL` |
| `share.open` | ⇗ button on player | opens embed panel; may be repointed to native share sheet |

### Content
| data-wire | Element | Backend contract |
|---|---|---|
| `reviews.page.prev/next` | review pagination | `GET /listings/:id/reviews?page=n&per=3` → replaces `RV` array. Distribution bars = `bars` array. **Policy: reviews are never deleted/filtered ("WE DELETE NOTHING").** |
| `chat.host.open` | MESSAGE SUNNY button | `POST /chats { hostId }` → open chat UI. Messages stay on-platform (copy promises no phone numbers). |
| `host.listing.open` | host's other listing cards | navigate to that listing's details page |
| `catalog.page.prev/next/select` | Browse-more pagination | `GET /catalog?related_to=:id&page=n&per=10` → replaces `EV` array in `browseVals()` |
| `catalog.item.open` | Browse-more cards | navigate to `/show/:id` (currently self-links) |

## Mock data locations (logic class of Listing Details)

- `SHOW_URL` — canonical listing URL constant
- `availDays(y,m)` — synthesizes "every Friday"; replace with availability API
- `slotDefs(d, soldOut)` — synthesizes slots + seat counts
- `nextShow()` — next Friday 21:00 local; replace with `nextShowAt` from API
- `renderVals()`: `bars`, `RV` (reviews), `hostSessions`, `hostListings`, `rules` (creator-defined
  house rules — editable by host), pricing math, `CATS` (per-category theming), `watching`/`bookedCount`
- `browseVals()`: `EV` (related events)
- Listing copy (title, blurb, chips, stats) is inline in the template — server-render or hole-ify as needed.

## Props (design tweaks, not backend state)

`category` (stream/friends/adda/astro/ai/consult/glow — per-category accent/border theming),
`liveState` (live/countdown, default live), `soldOut`, `newHost` (renders the honest no-history
empty state + first-show promise), `masala` (desi decorations on/off), `ctaColor`.
In production, `category`/`liveState`/`soldOut`/`newHost` become server-driven data, not props.

## Ethics contract (must survive integration)

These are deliberate product commitments visible in the UI — do not "optimize" them away:
1. Full price (ticket + fee + GST) shown **before** the book action; no new charges at checkout.
2. Seat/viewer counters bind to real inventory only; no fake urgency.
3. Human vs AI listings are always labelled (`✓ 100% REAL HUMAN · NO AI` badge).
4. Free cancel ≤24h before showtime; automatic refund on host cancellation.
5. Recording is opt-in ("recap reel only includes people who said yes").
6. Reviews are unfiltered, verified-booking only.
7. New hosts show a truthful empty state (`newHost` prop), never fabricated history.

## Responsiveness

All layout is flex/grid with wrapping — no fixed page widths. Verified breakpoints (driven by
`state.w`, updated on window resize in `componentDidMount`):

- **Desktop (≥1020px)** — booking card is a sticky right rail; two-column hero (player + title).
- **iPad (760–1020px)** — hero columns wrap; booking card leaves the rail and moves ABOVE the
  content sections (flex `order`, see `asideOrder`/`asidePos`/`asideMax` in `renderVals()`), full width.
- **Mobile (<760px)** — everything single-column. "Browse more events" paginates **4 cards per
  page** (`PER = S.w < 760 ? 4 : 10` in `browseVals()`); the marketplace page likewise shows 4
  cards per section on mobile. At <560px the nazar-battu strip compacts (smaller stickers + text,
  `nazarH1/nazarH2/nazarFs`).
- Grids use `repeat(auto-fit/auto-fill, minmax(...))` so cards, rule tiles, promise tiles, stats and
  thumbnails reflow at any width; all pill rows and meta rows are `flex-wrap: wrap`.
- Hit targets: all buttons ≥44px in at least one dimension on touch layouts.

## Design tokens

Fonts: Anton (display), Instrument Sans (body), Nunito 800 (labels/small caps), Playfair Display
italic (accent titles), Kalam (handwritten asides), Baloo 2 (hindi flavor).
Palette: bg `#f6e4cd`, card `#fdf1d3`, ink `#161614`, red `#d93825` (CTA), teal `#2d7180`,
brick `#b8382a`, butter `#f4d8a0`, oat `#d9c3a0`. Borders 2–3px ink, hard offset shadows
(`box-shadow: 6px 7px 0 #161614`), pill radius 100px, card radius 18–26px.
