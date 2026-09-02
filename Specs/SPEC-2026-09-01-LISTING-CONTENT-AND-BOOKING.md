# FINAL PLAN — Listings that feel complete, and the four ways to join one

Owner decision 2026-09-01, finalised 2026-09-02. Replaces the 2026-09-01 draft.
Environment: **production feature** — every prod write is confirmed with the
owner first.

**Goal in one sentence:** a creator fills in ONE form; the marketplace card and
the details page both come out looking like the design comps; a buyer clicks
the card and either books a 1:1 slot, buys into a running event, pre-books a
future one, or joins a free one where the creator pays.

This file is the contract. Where it and an agent's judgement disagree, this
file wins and the agent stops and says so. **Companion:**
`Specs/SPEC-2026-09-02-LISTING-TRUST-AND-VIBE.md` — the buyer's trust ladder,
per-type card and page anatomy (live / 1:1 / AI / free / adda), review trust
columns, `creator_stats`, and the copy/vibe dictionary. Its §6 adds steps
4b, 5b, 5c to the sequence in I. Prior art that governs and is not
re-litigated: `Specs/PIVOT-2026-08-27-MARKETPLACE-FIRST-PAID-SESSIONS.md`,
`Specs/SPEC-2026-09-01-PAID-SESSION-PIPELINE-BUILD.md`, `CLAUDE.md`.

---

## A0. Owner constraints added 2026-09-02

- **KYC pipeline is off-limits.** A new one is coming. Read the existing
  `kyc_verified` flag for the ✓; build nothing in verification.
- **First internal test is the free lane:** owner creates free streaming shows,
  a fake token amount is put in the creator wallet (staging, or prod with a
  deliberate `ALLOW_PROD=1` ledger credit the owner confirms), people join, the
  wallet drains per the metering rule. Feedback drives the next round. So step
  7 (free lane) moves up to run right after step 3 (slots) — it is the thing
  being tested.
- **Execution model:** 4–8 Sonnet-class agents do the coding per phase; the
  lead reviews every diff, runs the compile checks, and sends work back until
  it passes. Agents never commit, push, deploy, or run migrations.

## A1. Owner decisions 2026-09-02 (afternoon) — layout and public pages

1. **Marketplace is a public, full-width page for everyone, logged in or not.**
   `/marketplace` renders the bazaar comp (`design/live-streaming/avaTOK
   Marketplace.dc.html`): big hero board, wide card grid, site footer — never
   inside the dashboard shell. **`/dashboard/marketplace` is removed** (301 →
   `/marketplace`). The header's MARKETPLACE link always goes to `/marketplace`;
   a logged-in user returns via the header's DASHBOARD button. No auth redirect
   may bounce a signed-in user from `/marketplace` into the dashboard.
2. **The site footer from the comp (`SiteFooter.dc.html`, pic 5) is site-wide
   on desktop** — every page that uses `Base.astro`, and the landing document.
3. **Every listing details page is public and chrome-free**: no sidebar, not
   inside the dashboard, for live events, 1:1, 1:many, AI voice agents and free.
   The comp (`avaTOK Listing Details.dc.html`) IS the page, wired to real data.
   `/dashboard/l/:id` 301s to `/l/:id`; the creator's edit affordance is a small
   bar on the public page when the viewer owns the listing. An unregistered
   buyer signs in with **email + code** inline in the booking box, pays, and
   gets everything in the verified email — **never pushed to the dashboard**.
4. **The creator form must collect what the comp shows.** Steps per §F; the
   fields already exist server-side (`[LIST-CONTENT-2]`); the web form is the
   thin one and gets parity + the new steps first.

## A. Where we are (plain English)

**Done and live:**

- Share links (`/l/<id>`, `/e/`, `/watch/`, `/live/`, `/c/`) were dead on
  every real listing. Two causes, both fixed: `og.extra.map(… slot="head")`
  crashed Astro, and `getListing()` never unwrapped `{listing, …}`.
  `[LIST-DETAIL-1]`, `[LIST-DETAIL-2]`.
- The details page now shows what was already stored but never rendered: start
  time, duration, capacity, seats left, language, photo gallery, video,
  location, refund and cancellation terms.
- Marketplace page and cards are rebuilt in the bazaar design on real data
  (`[MARKET-BAZAAR-1..3]`, `[CARD-BAZAAR-1]`).
- Buying into a running event and pre-booking a future event already work on
  the paid lane (`commercial_checkout.ts` allows purchase while `live`).

**Still broken / missing (this plan):**

| # | Problem | Where |
|---|---|---|
| 1 | Card price qualifiers (`from`, `/min`) vanish — `price_semantics` lives on `listing_categories`, never joined into `CARD_SELECT` | `worker/src/routes/listings.ts:275` |
| 2 | Favourite heart stored, typed, never drawn | `web/src/components/ListingTile.tsx` |
| 3 | No `NEW`, no `SOLD OUT` pill; `created_at` and `seats_left` are on the wire | same |
| 4 | Card cannot say `ALWAYS ON` / `DAILY 6 PM` / `FRI 9 PM` — schema has one instant, no mode, no recurrence | schema |
| 5 | Card one-liner is `description` cut mid-sentence | `card.ts:one_liner` |
| 6 | Details page has no how-it-works, house rules, join-lead promise, max-seats — the "set by the host" sections that make it look real | schema + page |
| 7 | The comp details page still serves mock data at `/<handle>/<slug>` — and there is **no `slug` column** | `web/src/pages/[username]/[slug].astro` |
| 8 | Two creator forms disagree. Web form has **no cover upload, no `spoken_lang`, no early-bird, no promo, no commercial policy**. App writes language into `badges`, web into `spoken_lang` | `CreateListing.tsx`, `create_listing_flow.dart` |
| 9 | No slot table — a listing has exactly one `starts_at`. Calendar 1:1 is unwired | schema |
| 10 | No 1:1 consult layout in the comp; no free listing anywhere in the comp | design |
| 11 | Free lane (creator pays) does not exist | new |
| 12 | Language field `spoken_lang` is stored but the "regulars"/follower count is not on the card wire | `CARD_SELECT` |
| 13 | No timezone on a listing | schema |
| 14 | `GET /api/creators/:id` 404s for a real uid | **separate issue, not this plan** |

---

## B. What the end user should see (the acceptance test)

**Buyer, on the marketplace card:**

- Cover photo, category stub, language stub, status pill that is honest
  (`FRI 9 PM` · `LIVE` · `DAILY 6 PM` · `ALWAYS ON` · `AVAILABLE NOW` ·
  `SOLD OUT`), `NEW` for < 48 h.
- Title + price with the right qualifier (`₹49`, `from ₹300`, `₹19 / 10 min`,
  `FREE` in a distinct chip).
- A one-sentence blurb the creator wrote, not a truncated paragraph.
- Two proof chips (regulars, rating · count, seats left, response time, a vibe
  tag) — all derived except the vibe tag and response time.
- Host name + avatar + ✓ only if KYC-verified. Favourite heart that works.
- Duration or billing cadence (`90 MIN` / `PER CHAT`).

**Buyer, on the details page (comp order):**

1. Hero: gallery + video, status pill, countdown to start.
2. Title, blurb, host line, rating, language, duration, capacity/seats left,
   watching-now when live.
3. Sticky booking box — **one of four shapes** (see D).
4. How it works (2–5 steps, creator-written, pre-filled by category).
5. Meet the host (derived stats: shows hosted, come-back rate, past sessions).
6. House rules (intro line + 3–8 rules).
7. Reviews (real, per-listing).
8. Platform promises (refund window, cancel window, join-link lead time —
   from fields the creator already fills in).
9. Browse more.

Any section with no data **hides entirely**. No empty shells.

**Creator, in the form:** 8 steps, defaults pre-filled, a live card preview
beside the blurb, and a final preview that renders the REAL card and REAL page.

---

## C. Data model — what gets added

Rule: scalars that are filtered, sorted or shown on a card become **columns**.
Lists of objects that only the details page shows go into the existing
validated `attrs` JSON (8192-byte cap). No third mechanism.

### C.1 New columns on `listings`

```sql
-- worker/migrations/2026-09-02-listings-content.sql
ALTER TABLE listings ADD COLUMN blurb TEXT;                                   -- card one-liner, 55–110 chars
ALTER TABLE listings ADD COLUMN slug TEXT;                                    -- pretty URL; unique per creator
ALTER TABLE listings ADD COLUMN schedule_mode TEXT NOT NULL DEFAULT 'fixed_date'; -- fixed_date|recurring|on_request|always_on
ALTER TABLE listings ADD COLUMN recurrence_days TEXT;                         -- JSON [0..6], recurring only
ALTER TABLE listings ADD COLUMN recurrence_time TEXT;                         -- 'HH:MM' local, recurring only
ALTER TABLE listings ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'; -- IANA
ALTER TABLE listings ADD COLUMN billing_unit TEXT;                            -- session|minute|10min|chat|night|game
ALTER TABLE listings ADD COLUMN free_entry INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN max_per_booking INTEGER NOT NULL DEFAULT 4;
ALTER TABLE listings ADD COLUMN response_time_min INTEGER;                    -- consult/AI: "10 MIN RESPONSE"
ALTER TABLE listings ADD COLUMN vibe_tags TEXT;                               -- JSON, ≤2 from a curated set
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_creator_slug ON listings(creator_id, slug);
```

- `schedule_mode` is what lets the card say `ALWAYS ON` / `ON REQUEST`;
  `recurrence_days` + `recurrence_time` derive `DAILY 6 PM` / `FRI 9 PM`.
- `vibe_tags` is a **curated picklist** (`safe_space`, `cam_optional`,
  `listener_first`, `savage`, `beginner_ok`, `queer_friendly`, `18_plus`),
  never free text — the mock's `100% MASALA` chips are copy, not data.
- `price_semantics` is **not** a new column: join `listing_categories` into
  `CARD_SELECT` and emit it from `shapeCard`. `billing_unit` is the
  per-listing override when the category default is wrong.
- `slug` is generated from the title on create, editable once, unique per
  creator. Without it, item 7 in table A cannot ship.

### C.2 New `attrs` keys (details page only)

Validated by a new `contentAttrsError()` beside `commercialPolicyError()` in
`worker/src/routes/listings.ts`; 422 on violation.

| key | type | limits |
|---|---|---|
| `content_how_it_works` | `[{label, body}]` | 2–5 items; label ≤ 24, body ≤ 240 |
| `content_house_rules` | `[{heading, body}]` | 3–8 items; heading ≤ 32, body ≤ 200 |
| `content_house_rules_intro` | string | ≤ 280 |
| `content_join_lead_minutes` | int | 0–60, default 15 |
| `content_free_cap_tokens` | int | required when `free_entry=1` |

### C.3 `listing_slots` — the real slots table

```sql
-- worker/migrations/2026-09-02-listing-slots.sql
CREATE TABLE IF NOT EXISTS listing_slots (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,   -- epoch ms UTC
  label TEXT, capacity INTEGER NOT NULL,                  -- capacity 1 = a 1:1 slot
  booked_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',                    -- open|full|cancelled|done
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listing_slots_listing ON listing_slots(listing_id, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_slots_unique ON listing_slots(listing_id, starts_at, label);
```

Non-negotiable:

- `listings.starts_at` **stays** and mirrors the earliest open slot. Every
  shipped client, card, email and sort reads it.
- Seat claim is atomic: `UPDATE … SET booked_count = booked_count + ?N WHERE id
  = ?1 AND booked_count + ?N <= capacity`; zero rows = full. Same pattern as
  `worker/src/cal/engine.ts:claimBlock`.
- Slot is the booking grain for `consult`; optional refinement for
  `live_event`. A live event with no slots behaves exactly as today.
- `commercial_checkout.ts` accepts `slot_id`; the old `{start_at, end_at}` keeps
  working one release and is resolved to a slot server-side.
- `calendar_slots` (old AvaCalendar) is **not** this table. Leave it.

### C.4 Derived-only — NEVER a form field

Status pill text, LIVE, SOLD OUT, NEW, seats taken/left, watching-now, booked
count, rating + review count, regulars (`creator_profiles.follower_count` —
add to `CARD_SELECT`), come-back %, shows hosted, past sessions, countdown,
QR, embed code, price breakdown, initials, palette, favourited.

---

## D. The four join flows

| Flow | Listing shape | Booking box shows | State |
|---|---|---|---|
| **Calendar 1:1** | `kind=consult`, slots with `capacity=1` | Slot picker (day → time), prep instructions, booking notice, `Book ₹X` | Needs C.3 |
| **Buy into a running event** | `status=live` | `LIVE · N watching`, seat qty ≤ `max_per_booking`, `Join now ₹X` | **Works** — verify only |
| **Pre-book a future event** | `status=published`, future `starts_at` | Countdown, seats left, qty, `Book ₹X`, "join link arrives 15 min before" | **Works** — add countdown + lead-time line |
| **Free join** | `free_entry=1`, `price=0` | `FREE · N spots left`, `Reserve my spot` | New — see E |

The consult booking box is **not in the comp** and is designed in this plan:
no seat quantity, no recurring-dot calendar; a slot picker, and prep
instructions shown prominently.

---

## E. The free lane — creator pays

A free listing costs the **creator**, from escrow, like everything else. Buyer
pays ₹0 and gets a normal entitlement.

1. Creator sets `free_entry=1`, `price=0`, and `content_free_cap_tokens`.
2. **At go-live**, before the provider session exists, the server `hold()`s the
   cap from the creator's wallet (`worker/src/ledger.ts:hold`). Insufficient
   balance = hard refusal to start. Never a negative balance.
3. Attendance is metered off `commercial_participant_intervals`, the same
   records the paid settlement uses.
4. At session end, settlement debits actual usage to `platform:fees` and
   **returns the remainder to the creator**.
5. The cap is the attendee ceiling: when the next join would exceed it, refuse
   with "this free session is full".

Rate flag: `freeSessionTokensPerAttendeeMinute`, declared in **both**
`PlatformConfig` and `DEFAULTS` (`worker/src/routes/config.ts`), default `0`.
Prove it is not a fake flag: `ALLOW_PROD=1 scripts/flags.sh set …` must not 400.

Abuse rules: free sessions do not count toward ranking until one paid session
exists; cap is per session, never per day.

---

## F. The creator form — one form, two surfaces, same fields

**Web form gets full parity with the app form first** (payments are web; it
is the thinner one today). Then both add the new fields. Language consolidates
on `spoken_lang`; the app stops writing a language badge.

Required for `live_event`, optional for `consult`/AI: blurb, how-it-works,
house rules.

| Step | Fields |
|---|---|
| 1 Type | kind, `schedule_mode`, category |
| 2 Pitch | title, `blurb` (char count + live card preview), description, `vibe_tags` (≤2), `spoken_lang` |
| 3 Money | price, `billing_unit`, `free_entry` + cap, early-bird, promo |
| 4 Time | `timezone`; then fixed date+duration, OR recurrence (days + time), OR slot editor (named slots: time, duration, capacity), OR nothing for `on_request`/`always_on`; `response_time_min` for consult/AI |
| 5 How it works | 2–5 steps, **pre-filled per category** |
| 6 House rules | intro + 3–8 rules, **pre-filled per category** |
| 7 Photos & policy | cover 1–5 (**add to web**), video, location, refund/cancel/reschedule/notice/prep |
| 8 Preview | the REAL card + REAL details page |

Pre-filled defaults are the highest-leverage decision: a blank required box
gets abandoned; a good default gets edited.

---

## G. The details page

`web/src/pages/[username]/[slug].astro` stops serving the mock and renders real
data through the **same component** as `/l/<id>`. `/l/<id>` keeps working
forever and 301s to `/<handle>/<slug>` once both exist. Dashboard twin
`/dashboard/l/<id>` uses the same component with an "edit" bar.

---

## H. The card — six items, in order

1. Join `price_semantics` + `follower_count` into `CARD_SELECT`/`shapeCard`.
2. Render `blurb`, fall back to `one_liner`.
3. Status pill learns `ALWAYS ON`, `ON REQUEST`, recurring labels, `SOLD OUT`.
4. `FREE` chip, visibly distinct.
5. Favourite heart wired to `favorited`.
6. `NEW` chip < 48 h; `response_time_min` and `vibe_tags` chips.

Mock artefacts to ignore: `PORTRAIT` watermark, serif rotation, unconditional ✓.

---

## I. Sequence (each step testable alone, nothing blocks a bug fix)

| Step | Issue id | What ships | Success value |
|---|---|---|---|
| 1 | `[LIST-CONTENT-2]` | Migrations C.1 + C.2 validator + `price_semantics`/`follower_count` in CARD_SELECT. **Dark.** | `GET /api/listings?…` card JSON carries `price_semantics`; `/api/config` unchanged |
| 2 | `[LIST-SEED-1]` | `scripts/seed_listings.ts`: one fully-populated listing per shape (live event, recurring, consult with slots, AI always-on, free) under a test creator, on **staging first**, then prod on owner's word | Five rows exist; every card and page field non-empty |
| 3 | `[LIST-SLOTS-1]` | C.3 table, slot CRUD on listing, atomic claim, `slot_id` in checkout | Two concurrent claims on a capacity-1 slot: exactly one succeeds |
| 4 | `[LIST-CARD-2]` | H.1–6 | Seeded cards render every element in B on `/marketplace` |
| 5 | `[LIST-PAGE-2]` | G + consult layout + free layout; hide-when-empty | Seeded pages render every section in B; a bare listing renders no empty section |
| 6 | `[LIST-FORM-2]` | F, web first, then app | Create via form → card and page match preview byte-for-byte |
| 7 | `[LIST-FREE-1]` | E, behind `free_entry` + flag | Go-live with insufficient balance refuses; end-of-session ledger shows hold, usage, refund |
| 8 | `[LIST-VERIFY-1]` | Two real people: one books a slot, one buys into a live seed event, one joins a free one | PostHog: `commercial_checkout_result=ok` on ≥2 distinct persons on the newest build |

Step 2 is deliberately early: judging the page against a real full row beats
reading code, and every later step gets a fixture for free.

---

## J. Rules every agent follows

- Compile before you claim: `npx tsc --noEmit` in `worker/` and `web/`,
  `flutter analyze` in `app/`.
- Commit through `scripts/git_safe_commit.py` with explicit paths; one issue
  per commit; never push without asking; never trigger a build.
- Production: every migration and deploy is confirmed with the owner first;
  `ALLOW_PROD=1` is typed deliberately and said out loud.
- **A page that renders for a fake id is not proof it renders for a real one.**
  Test with a real published row — the share-link outage survived every
  fake-id smoke test.
- New behaviour ships dark. Write the success value down before you finish.
- Rename nothing in the `*_coins` wire contract; the unit is the token, ₹.
