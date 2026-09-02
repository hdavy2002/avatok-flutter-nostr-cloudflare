# SPEC 2026-09-01 — Listings that feel complete, and the three ways to book one

Owner decision, 2026-09-01. Goal in one sentence: **a creator fills in one form,
and the marketplace card and the details page both come out looking like the
design comps instead of half-empty.** Then a buyer books one of three ways, and
a fourth, free lane exists where the creator pays instead of the buyer.

This spec is the contract. Where it and an agent's judgement disagree, this file
wins and the agent stops and says so.

Prior art that governs and is not re-litigated:
`Specs/PIVOT-2026-08-27-MARKETPLACE-FIRST-PAID-SESSIONS.md`,
`Specs/SPEC-2026-09-01-PAID-SESSION-PIPELINE-BUILD.md`, and `CLAUDE.md` in full.

---

## 0. What we learned first — read this before designing anything

Two content inventories were taken against the design comps
(`design/live-streaming/avaTOK Listing Details.dc.html` and
`… Marketplace.dc.html`, both byte-identical to the copies staged into
`web/src/generated/`). Three findings shape everything below.

**1. Most of the "missing" content was never missing.** Start time, duration,
capacity, seats left, watching count, language, the photo gallery, the video,
location, and the refund and cancellation terms the creator already fills in
were all stored, all returned by `GET /api/listings/:id`, and simply not
rendered. `[LIST-DETAIL-1]` fixed that. Do not add a form field for anything in
that list.

**2. About half the comp is derived, not typed.** Ratings, review histograms,
seats-left, watching-now, shows-hosted, come-back rate, past sessions, the QR
code, the embed snippet, the price breakdown, the countdown. These need wiring,
never a form field. Adding a "rating" input would be a bug, not a feature.

**3. The comp is a group ticketed show throughout.** Calendar, weekly slots,
seat quantity, per-seat price. **There is no 1:1 consultation layout in it, and
no free listing anywhere** — the cheapest mock card is ₹9. Both are undesigned
and this spec has to invent them rather than copy them.

A fourth finding, from the card audit: the mock crams all social proof into two
free-text chips (`♡ 300 REGULARS`, `★ 4.9 · 620`). The real `chipsFor()` already
reverse-engineers which field to show. Keep that; do not add chip text fields.

---

## 1. The bugs found on the way, and their state

| Bug | State |
|---|---|
| Every public share link 500-ed on real data — `og.extra.map(m => <meta slot="head"/>)` crashes Astro's slot bucketing (`slots[name] is not a function`). Hit `/l/`, `/e/`, `/watch/`, `/live/`, `/c/`, and only when the listing resolved, which is why fake-id tests looked clean | **FIXED** `[LIST-DETAIL-2]`, live |
| `apiClient.getListing()` typed `Promise<Listing>` but the worker returns `{listing, creator_stats, reviews, viewer}` — every caller read `undefined` | **FIXED** at source `[LIST-DETAIL-2]` |
| `creator.id` / `creator.avatar` read where the worker sends `uid` / `avatar_url` — produced a literal `/c/undefined` link and killed every creator avatar | **FIXED** `[LIST-DETAIL-2]` |
| Details page ignored `starts_at`, `duration_min`, `capacity`, `seats_left`, `spoken_lang`, gallery, video, location, commercial terms | **FIXED** `[LIST-DETAIL-1]`, live |
| Review count showed the creator's channel-wide total on every one of their listings | **FIXED** `[LIST-DETAIL-1]` |
| `price_semantics` is on the detail response but **not in `CARD_SELECT`/`shapeCard`**, so `from` / `/min` / `/hr` qualifiers silently vanish on every browse card | **OPEN** — §5 |
| `favorited` is stored and typed but `ListingTile.tsx` renders no heart | **OPEN** — §5 |
| `GET /api/creators/:id` 404s for a real creator uid | **OPEN, separate** — not this spec |
| Language is written to `badges` by the app and to `spoken_lang` by the web form — two forms, two places, one concept | **OPEN** — §3 |

---

## 2. The data model

### 2.1 Where each new field lives, and why

Scalars that are **filtered, sorted or shown on a card** become real columns.
Lists of objects that are **only ever displayed on the details page** go into the
existing `attrs` JSON, which is already length-capped (8192 bytes), already
validated per category, and already returned to clients. Two new mechanisms
would be one too many.

### 2.2 New columns on `listings`

```sql
-- migration: worker/migrations/2026-09-02-listings-content.sql
ALTER TABLE listings ADD COLUMN blurb TEXT;            -- the card one-liner
ALTER TABLE listings ADD COLUMN schedule_mode TEXT NOT NULL DEFAULT 'fixed_date';
ALTER TABLE listings ADD COLUMN billing_unit TEXT;     -- 'session'|'minute'|'chat'|'night'
ALTER TABLE listings ADD COLUMN free_entry INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN max_per_booking INTEGER;
```

- **`blurb`** — today the card's one-liner is derived by truncating
  `description`, which cuts mid-sentence. The comp's blurbs are deliberate,
  55–110 characters, one sentence. Give the creator the field. Falls back to the
  derived `one_liner` when empty, so nothing breaks for existing rows.
- **`schedule_mode`** — `fixed_date` | `recurring` | `on_request` | `always_on`.
  This is the field that makes the other three booking flows expressible. The
  comp's AI cards say `ALWAYS ON` and its consult cards say `AVAILABLE NOW`;
  today `statusLabel()` can produce neither, because nothing in the schema says
  a listing has no fixed time.
- **`billing_unit`** — the comp overloads the duration slot on AI cards to mean
  price cadence (`PER 10 MIN`, `PER CHAT`, `PER NIGHT`). That is a second
  concept wearing the first one's clothes. Separate them.
- **`free_entry`** — see §6. A price of 0 is not sufficient, because free
  listings invert who pays.
- **`max_per_booking`** — the comp's booking box hardcodes a cap of 4 seats per
  order in its own JS. Make it a field, default 4.

### 2.3 New `attrs` keys

Validated by a new `contentAttrsError()` beside the existing
`commercialPolicyError()` in `worker/src/routes/listings.ts`. Same shape, same
place, same 422 on violation.

| key | type | limits |
|---|---|---|
| `content_how_it_works` | list of `{label, body}` | 2–5 items; label ≤ 24 chars, body ≤ 240 |
| `content_house_rules` | list of `{heading, body}` | 3–8 items; heading ≤ 32, body ≤ 200 |
| `content_house_rules_intro` | string | ≤ 280 |
| `content_join_lead_minutes` | integer | 0–60, default 15 |

`content_how_it_works` and `content_house_rules` are the two sections the comp
labels "set by the host, shown before every booking". They are the difference
between a page that looks trustworthy and one that looks like a stub.

### 2.4 `listing_slots` — the real slots table

Owner decision: build it properly rather than fake it with a second time field.

```sql
-- migration: worker/migrations/2026-09-02-listing-slots.sql
CREATE TABLE IF NOT EXISTS listing_slots (
  id           TEXT PRIMARY KEY,
  listing_id   TEXT NOT NULL,
  starts_at    INTEGER NOT NULL,      -- epoch ms, UTC
  ends_at      INTEGER NOT NULL,
  label        TEXT,                  -- 'Main show', 'Newbie warm-up'
  capacity     INTEGER NOT NULL,      -- 1 for a 1:1 slot
  booked_count INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'open',  -- open|full|cancelled|done
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listing_slots_listing ON listing_slots(listing_id, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_slots_unique ON listing_slots(listing_id, starts_at, label);
```

Rules that are not negotiable:

- **`listings.starts_at` stays** and mirrors the earliest open slot. Every
  shipped client, every card, every email and every sort order reads it. Do not
  remove it and do not stop maintaining it.
- **Seat counting is atomic.** Claiming a seat is a conditional UPDATE
  (`UPDATE … SET booked_count = booked_count + ?N WHERE id = ?1 AND booked_count + ?N <= capacity`)
  and a zero-row result IS the "slot full" signal. This is the same pattern
  `worker/src/cal/engine.ts:claimBlock` already proves works under D1.
- **A slot is the booking grain for `consult`**, and an optional refinement for
  `live_event`. A live event with no slots keeps behaving exactly as it does
  today off `starts_at` + `duration_min`.
- **`commercial_checkout.ts` takes a `slot_id`** where it currently takes
  `{start_at, end_at}`. The existing shape keeps working for one release; the
  server resolves it to a slot when one matches.
- The existing `calendar_slots` table is **not** this table. It belongs to the
  older, unwired AvaCalendar feature. Do not merge them in this pass; note the
  duplication and leave it.

### 2.5 Timezone — no longer optional

A listing has one wall-clock time and nothing saying which clock. Add
`timezone TEXT` (IANA, e.g. `Asia/Kolkata`), captured from the creator's device,
defaulted to `Asia/Kolkata`. Render every public time in the viewer's zone with
the creator's zone shown beside it. Cheap now; expensive after the first
mis-timed event.

---

## 3. The creator form

All new content fields are **required for `live_event`, optional for `consult`**
— owner decision. A show page with no house rules is the exact problem this
spec exists to fix; a consult is a conversation, not a room with rules.

One form, two surfaces, and they must not disagree — today the app writes
language into `badges` while the web writes it into `spoken_lang`. **Consolidate
on `spoken_lang`** and have the app stop writing a language badge.

Step order (both `app/lib/features/listings/create_listing_flow.dart` and
`web/src/islands/dashboard/CreateListing.tsx`):

1. **Type** — kind, and for `consult`/AI, `schedule_mode`.
2. **The pitch** — title, `blurb` (with a live character count and the card
   preview beside it), description, category.
3. **Money** — price, `billing_unit`, `free_entry`, early-bird and promo.
4. **Time** — `timezone`, then either a fixed date, a recurrence, or a slot
   editor (add/remove named slots with time, duration, capacity), or nothing at
   all for `on_request` / `always_on`.
5. **How it works** — 2–5 steps. Pre-filled with sensible defaults for the
   category so the creator edits rather than faces a blank box.
6. **House rules** — intro line plus 3–8 rules, same pre-fill approach.
7. **Photos** — unchanged, 1–5.
8. **Preview** — show the real card and the real details page, not an
   approximation. This is the step that makes creators fill the rest in.

Pre-filled defaults are the single highest-leverage decision here. A required
field with a blank box gets abandoned; a required field with a good default gets
edited.

---

## 4. The details page

The mock becomes the real page. `web/src/pages/[username]/[slug].astro`
currently serves `listing-details.dc.html` verbatim with hardcoded mock data —
its own header says "backend wiring comes later". This is later.

- The pretty URL `/<handle>/<slug>` becomes the canonical public listing URL,
  rendering real data through the same component as `/l/<id>`.
- `/l/<id>` keeps working forever and 301s to the pretty URL when the creator
  has a handle. Every link already shared points at it.
- Sections, in comp order: hero and player, title and meta, sticky booking box,
  how it works, meet the host, house rules, reviews, platform promises, browse
  more. Everything derived stays derived.
- Anything with no data **hides its whole section**. No empty shells — that is
  the failure mode we are fixing.
- The 1:1 consult layout is **not in the comp** and must be designed: no seat
  quantity, no calendar of recurring dots, a slot picker instead, and the
  prep-instructions and booking-notice fields shown prominently.

---

## 5. The marketplace card

From the card audit, in priority order:

1. **Add `price_semantics` to `CARD_SELECT` and `shapeCard`.** It exists, the
   card code already asks for it, and it arrives `undefined` — so `from` and
   `/min` qualifiers vanish on every browse card today. One-line server fix.
2. **Render `blurb`** in place of the truncated `one_liner`.
3. **Status pill** learns `ALWAYS ON` and `ON REQUEST` from `schedule_mode`.
4. **Free treatment** — `priceLabel()` already returns `Free` for price 0 and
   has never been exercised. Give it a visibly distinct chip.
5. **Render the favourite heart.** `favorited` is stored, typed, and drawn
   nowhere.
6. **A `NEW` chip** for listings under 48 hours old — `created_at` is already
   selected specifically to allow this, per the comment in `listings.ts`.

The mock's `PORTRAIT` watermark, serif/Anton title rotation and unconditional ✓
are mock artefacts. The real card is right to gate the tick on actual KYC —
keep that.

---

## 6. The free lane — creator pays

New product case, undesigned in the comp, and the only one that inverts the
money flow. Get this wrong and it drains a creator's wallet silently.

**The rule: a free listing costs the creator, and it is paid from escrow like
everything else.** Buyers pay ₹0 and get a normal entitlement.

1. Creator sets `free_entry = 1`, `price = 0`, and a **spend cap** for the
   session (`content_free_cap_tokens` in `attrs`, required).
2. **At go-live**, before the provider session is created, the server takes a
   `hold()` from the creator's wallet for the cap. Insufficient balance is a
   hard refusal to start — not a warning, and never a negative balance. Reuse
   `worker/src/ledger.ts:hold` exactly as the paid lane does.
3. **Attendance is metered** off the participant intervals the settlement engine
   already records (`commercial_participant_intervals`).
4. **At session end**, `releaseSnapshot()`-style settlement debits actual usage
   to `platform:fees` and **returns the unspent remainder to the creator**.
5. The cap is also the attendee ceiling: when metered spend would exceed it, new
   joins are refused with a clear "this free session is full" — not a crash and
   not an overdraft.

Rate for metered usage is a new flag, `freeSessionTokensPerAttendeeMinute`,
declared in **both** `PlatformConfig` and `DEFAULTS` in
`worker/src/routes/config.ts` — a key missing from `DEFAULTS` can never be
flipped and is a fake flag. Default it to `0` so the lane is free to the
platform until someone deliberately prices it.

Abuse notes worth writing down now: a free listing is the cheapest way to farm
followers, so free sessions do not count toward creator ranking until a paid
session exists; and the cap must be per session, not per day, or one runaway
room empties a wallet.

---

## 7. The three booking flows

| Flow | Trigger | State today | Work needed |
|---|---|---|---|
| **Calendar 1:1** | Buyer picks a slot on a consult listing | Buyer picks a `{start,end}` against an unwired calendar | Slot picker reads `listing_slots`; checkout takes `slot_id`; atomic claim |
| **Buy into a running event** | Listing `status = 'live'` | **Already works** — `commercial_checkout.ts:350` explicitly allows buying while live, and the browser viewer sends a ticketless viewer into checkout | Verify end to end; no new code expected |
| **Pre-book a future event** | Listing `status = 'published'`, future `starts_at` | **Already works** | Show the countdown and the join-lead-time promise |
| **Free join** | `free_entry = 1` | Does not exist | §6 |

---

## 8. Sequence

Each step is testable on its own and none of them blocks a user-visible bug fix.

1. **Server fields** — the two migrations, `contentAttrsError()`, `blurb`,
   `schedule_mode`, `billing_unit`, `free_entry`, `max_per_booking`, `timezone`,
   plus `price_semantics` into `CARD_SELECT`. Ships dark; nothing reads them yet.
2. **Slots** — table, CRUD on the listing, atomic claim, `slot_id` in checkout.
3. **Creator form** — both surfaces, with pre-filled defaults and a real preview.
4. **Details page** — mock becomes real, pretty URL canonical, consult layout
   designed.
5. **Cards** — the six items in §5.
6. **Free lane** — §6, behind `free_entry` and its own flag, off by default.
7. **A seeded dummy listing** — a script that creates one fully-populated
   listing of each kind so the page and the card can be judged with real data
   instead of by reading code. This is step 7 only because it needs step 1;
   everything after it gets easier once it exists.

## 9. Rules every agent follows

Unchanged from `Specs/SPEC-2026-09-01-PAID-SESSION-PIPELINE-BUILD.md` §6, and
they are not optional: compile before you claim (`npx tsc --noEmit` in `worker/`
and `web/`, `flutter analyze` in `app/`); commit through
`scripts/git_safe_commit.py` with explicit paths; never push or deploy without
being asked; never touch another workstream's files; new behaviour ships dark;
and write down the success value before you finish.

One addition, learned the hard way today: **a page that renders for a fake id is
not proof it renders for a real one.** The share-link outage survived every
smoke test because the failure only occurred when the API returned data. Test
with a real, published row.
