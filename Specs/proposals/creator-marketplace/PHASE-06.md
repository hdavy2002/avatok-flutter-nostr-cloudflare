# Phase 6 — Listings Pipeline + AvaExplore Marketplace + Creator Channels

**Read first:** `00-UNIVERSAL-PROPOSAL.md` §1, §4, §5. Prereqs: Phases 2 (wallet
hold), 3 (KYC gate), 5 (slots). AvaExplore UI exists as dummy — wire it live.

## Objective
Creators create listings (live events + consult offerings) through a guided
pipeline; published listings appear in AvaExplore under categories; full details
page, creator channel page, reviews, message-the-creator, "live now" rail with
join+pay popup.

## Backend (`routes/listings.ts`, D1 `avatok-meta`)

### Schema
```sql
CREATE TABLE listings (
  id TEXT PRIMARY KEY, creator_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- live_event|consult
  title TEXT NOT NULL, description TEXT,
  category TEXT NOT NULL,         -- teachers|astrologers|professors|fitness|music|... (config table)
  price INTEGER NOT NULL,         -- coins
  currency_display TEXT DEFAULT 'USD',
  country TEXT, adults_only INTEGER DEFAULT 0,
  badges TEXT,                    -- JSON: extra icon flags (language, recorded, etc.)
  cover_media TEXT,               -- JSON: [{type: image|video, r2_key}]
  starts_at INTEGER, duration_min INTEGER,   -- live events
  capacity INTEGER,               -- consult group size: 1|10|20 (1 = 1:1); live = NULL/unlimited
  status TEXT NOT NULL DEFAULT 'draft',      -- draft|published|live|completed|cancelled
  joined_count INTEGER DEFAULT 0,            -- denormalized for cards ("400 joined")
  rating_avg REAL, rating_count INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_listings_browse ON listings(status, kind, category, starts_at);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY, listing_id TEXT, creator_id TEXT, author_id TEXT,
  rating INTEGER NOT NULL, body TEXT, created_at INTEGER,
  UNIQUE(listing_id, author_id)            -- only attendees may review (checked vs bookings)
);
CREATE TABLE creator_profiles (
  user_id TEXT PRIMARY KEY, display_name TEXT, bio TEXT, avatar TEXT,
  public_fields TEXT,            -- JSON of what creator made public
  rating_avg REAL, rating_count INTEGER, follower_count INTEGER DEFAULT 0
);
```

### Creation pipeline (API + rules)
- `POST /api/listings` (draft) → step updates → `POST /api/listings/:id/publish`.
- **Publish guards:** `requireKyc` (both live events AND consult listings);
  live events must `claimBlock` their slot (Phase 5) — conflict ⇒ 409 greyed UX;
  consult listings attach to `availability_rules`.
- Cover media via `/upload/public` → registers in files_index (Phase 4) → AVIF.

### Browse/read APIs
- `GET /api/explore?kind=&category=&country=&cursor=` → card payload: photo,
  title, price, date, country, one-liner, joined_count, rating.
- `GET /api/explore/live-now` → listings with status='live' (+ joinable flag).
- `GET /api/listings/:id` → full details + creator card + reviews page 1.
- `GET /api/creators/:id` → channel: profile card, public fields, all their
  published listings, all reviews for this creator.
- `POST /api/listings/:id/reviews` — only after a completed booking/attendance.

### Purchase glue (full lifecycle in Phase 7)
- `POST /api/listings/:id/book` {slot?} → create `orders` row + booking (Phase 5)
  + wallet `hold` (Phase 2) + bump `joined_count` → Brevo confirmation email with
  date/time + how to join. This endpoint is shared by "Book" and the live "Join &
  pay" popup.

## Flutter

### Creator pipeline (`app/lib/features/listings/`)
Stepper: 1) type (live/consult) 2) title+description+category 3) price (+capacity
for consult; date/time+duration for live — slot picker shows greyed conflicts)
4) cover photos/video 5) icons: country, 18+, language, custom badges 6) preview →
Publish (KYC gate intercepts here if unverified).

### AvaExplore (replace dummy in `app/lib/features/explore/`)
- Category rails (Teachers, Astrologers, Professors, …) + Live-events sections;
  **Live now** rail at top: red dot, joined count, Join button → popup card →
  confirm pays from wallet → deep-link into the stream (Phase 7).
- Card: photo, title, $price, date, country flag, one-line description, "🔥 400
  joined" small-font social proof.
- Details page: media carousel (video or photos), title, description, icon row
  (country, 18+, …), Book/Join CTA, reviews list, creator mini-card → channel.
- Channel page: profile card, public details, listings grid, all reviews,
  **Message** button → opens/creates a DM thread (lands in creator's AvaInbox,
  Phase 8; uses existing messenger infra now).

## Acceptance criteria
- [ ] Unverified creator cannot publish (UI gate AND API 403).
- [ ] Live-event publish on an occupied slot fails w/ greyed slot UX.
- [ ] Published listing appears in correct AvaExplore category within seconds.
- [ ] Booking deducts wallet, holds escrow, sends email, bumps joined count.
- [ ] Reviews only possible for attendees; averages update on card + channel.
- [ ] Message-the-creator creates a thread reachable from the creator side.

## Folded from audit (build in this phase)

### A1. Marketplace search [MUST]
- D1 FTS5: `CREATE VIRTUAL TABLE listings_fts USING fts5(title, description,
  creator_name, category, content=listings)` kept in sync by triggers (or
  rebuild-on-publish — listings are low-write).
- `GET /api/explore/search?q=&kind=&category=&country=&minPrice=&maxPrice=&
  from=&to=&minRating=&sort=` ; `sort ∈ soonest|cheapest|popular|rating`
  (popular = joined_count desc). Same card payload as browse; keyset pagination.
- UI: search bar pinned at top of AvaExplore → results screen with filter sheet
  (price range slider, date range, country, rating ≥) + sort chips; recent
  searches stored locally (per-account scoped).
- Acceptance: search by partial title and by creator name both hit; each filter
  + sort verified against a seeded set.

### A2. Follow system [MUST]
```sql
CREATE TABLE follows (
  follower_id TEXT, creator_id TEXT, created_at INTEGER, notify INTEGER DEFAULT 1,
  PRIMARY KEY (follower_id, creator_id)
);
```
- `POST/DELETE /api/creators/:id/follow`; `follower_count` maintained atomically
  (`UPDATE … +1/−1`). Follow button on channel page + post-event rating sheet
  ("Follow <creator> for the next one").
- **Fan-out notify** (consumers, Queue `Q_FANOUT`): on listing publish and on
  go-live, enqueue one job → batch-read followers with `notify=1` → FCM push
  ("X just scheduled… / X is LIVE now") + optional email (user pref). Capped:
  max 2 fan-outs per creator per day (anti-spam).
- Per-creator mute: long-press notification / channel toggle sets `notify=0`.
- Acceptance: follower gets a push within seconds of publish; unfollowed/muted
  users get nothing; cap enforced.

### A3. Guest browsing [MUST]
- AvaExplore, listing details, channel pages, and search are reachable WITHOUT
  login (worker: these GET routes drop the auth requirement; no per-user data
  returned). First gated action (book, follow, message, donate) → Clerk sign-in
  sheet, then resumes the intended action (store a pending-intent).
- Acceptance: cold install → browse → tap Book → sign in → lands back on the
  same listing's checkout with slot preserved.

### A4. Trust & safety surface [SHOULD]
- "ID verified ✓" badge on cards/channels where `account_status.kyc='verified'`.
- `POST /api/report` {targetType: listing|creator|review, targetId, reason} →
  existing `user_reports` pipeline; report option in listing/channel overflow.
- Buyer-side block creator: hides their listings from feeds/search for that user
  (`blocks` table reused), prevents messages both ways.

### A5. Promotions [SHOULD]
```sql
CREATE TABLE listing_promotions (
  id TEXT PRIMARY KEY, listing_id TEXT,
  kind TEXT,                 -- early_bird|promo_code
  pct_off INTEGER, code TEXT, max_uses INTEGER, used INTEGER DEFAULT 0,
  ends_at INTEGER
);
```
- Pipeline step 3 gains "Pricing extras": early-bird (% off until date) and promo
  codes (% off, max uses). Checkout applies best single promotion; card shows
  struck-through price. `price=0` listings allowed (free events): skip wallet
  hold entirely, still create order/booking for attendance + reviews.
- Acceptance: early-bird expires on time; promo code stops at max_uses; free
  event books with zero ledger rows.

### A6. Creator listing tools [MUST]
- **Preview as buyer:** pipeline step 6 renders the REAL details-page widget
  with draft data (one codepath — no drift between preview and live).
- **Duplicate listing:** overflow menu on any own listing → copies everything,
  clears date/slot, status=draft. One tap for weekly events.

### A7. Channel polish [SHOULD]
- `creator_profiles` add: `banner_r2_key, links TEXT/*JSON [{label,url}]*/,
  intro_video_ref, pinned_listing_id`. Channel page renders banner, link chips
  (https only, domain shown), autoplay-muted intro video, pinned listing on top.
  Editor screen under Profile → "My channel".

### A8. Checkout insufficient-funds UX [SHOULD]
- Booking checkout shows wallet balance; if short, inline top-up sheet (Phase 2)
  pre-filled with the shortfall; on success checkout resumes without losing the
  selected slot (slot soft-held for 5 min via a tentative calendar_block).

## Definition of done
Deploy (staging then prod), seed demo categories, Graphiti episode,
STATUS_REPORT.md, push.
