# Listing demo-data seed

`scripts/seed_listings.py` generates ONE `.sql` file of fully-populated demo
listings so the marketplace card and details page can be judged against real
data instead of the design-preview mock. It never touches a database itself —
it only writes a file. Plain `python3`, no pip deps.

Written against (read directly, not guessed):
`worker/migrations/listings.sql`, `2026-07-18-listings-taxonomy-columns.sql`,
`2026-08-31-listings-section.sql`, `2026-09-02-listings-content.sql`,
`2026-09-02-listing-slots.sql`, `2026-09-02-reviews-trust.sql`,
`2026-09-02-creator-stats.sql`, `phase8_verse.sql`, `cfnative.sql`, and
`worker/src/routes/listings.ts` (createListing's INSERT, `normFields`,
`encodeAttrs`, `commercialPolicyError`, `contentAttrsError`, `CARD_SELECT`).

## What it seeds

Five listings, all owned by `--creator-uid`, Hinglish copy in the trust/vibe
spec's voice (slang as garnish, regional pride never punchline, no real people):

| id | kind | shape |
|---|---|---|
| `seed-live-1` | `live_event` | fixed date (3 days out, 21:00 IST), ₹49, full content (how-it-works, house rules, what-you-get, who-for/not-for, FAQ, join requirements), early-bird promo, highlight clip |
| `seed-live-recurring-1` | `live_event` | recurring Mon/Wed/Fri 18:00 IST, ₹19 |
| `seed-consult-1` | `consult` | 1:1, `CA · 8 yrs` credential, 6 bookable `listing_slots` over the next 7 days, sample Q&A, prep instructions |
| `seed-ai-1` | `ai_agent` | always-on astro agent, billed per `10min`, can-do/can't-do, sample chat, sample-voice highlight |
| `seed-free-1` | `live_event` | `free_entry=1`, `content_free_cap_tokens=500`, full content |

Plus 8 reviews each on the three PAID listings (`seed-live-1`, `seed-consult-1`,
`seed-ai-1` — not the recurring or free ones), authored by 8 seeded `users`
rows (`seed-user-1..8`), mixing `verified_attendee` 1/0, 2 with a
`creator_reply` (dual-written to the legacy `reply`/`reply_at` columns the
reviews-list route still reads), varied `helpful_count`, and per-listing
ratings that land the listing's `rating_avg` near what a genuine ~4.6–4.9
average looks like (not all 5s). A `creator_stats` row and a
`creator_profiles` bio/follower_count are also written for `--creator-uid`.

**Read this before assuming `seed-ai-1` is something a real creator could
publish today:** `worker/src/routes/listings.ts:69` only accepts
`kind ∈ {live_event, consult, sell, buy, social}` — there is no `ai_agent`
(or `agent*`) value the live API will let a caller POST; it 400s first. The
`agent_instructions`/`agent_lang`/`agent_voice_persona` columns and the
`sectionFor()` rule that maps `kind='ai_agent'` → `section='ai_voice_agents'`
both exist and are read-ready, but nothing shipped can write that kind. This
script writes `kind='ai_agent'` via raw SQL (which is exactly what a seed
script is for), so the row will render correctly, but it is a preview of a
kind the product can't create yet — flag that to whoever is judging it.

## Usage

```bash
# Generate the insert file for a given creator.
python3 scripts/seed_listings.py --creator-uid <clerk_uid> --out /tmp/seed.sql

# Custom id prefix / creator handle (both optional).
python3 scripts/seed_listings.py --creator-uid <clerk_uid> --out /tmp/seed.sql \
  --prefix seed- --handle mycreator

# Dry read: statement count + tables touched, writes nothing.
python3 scripts/seed_listings.py --creator-uid <clerk_uid> --check

# Wipe only — emits just the DELETE statements for this prefix.
python3 scripts/seed_listings.py --wipe --out /tmp/wipe.sql [--prefix seed-]
```

### Applying it

This script only ever produces a `.sql` file on your machine. Nothing in this
repo's automation applies it — that is a deliberate, separate, human step, and
it must go through `scripts/cf.sh`, never bare `wrangler` (see the root
`CLAUDE.md` staging/production section: bare `wrangler d1 execute` resolves
the **production** binding with no warning).

```bash
# Staging (default target unless AVATOK_TARGET/branch says otherwise):
AVATOK_TARGET=staging scripts/cf.sh worker d1 execute DB_META --remote --file=/tmp/seed.sql

# Production — deliberate, explicit, and asked for by the owner:
ALLOW_PROD=1 scripts/cf.sh worker d1 execute DB_META --remote --file=/tmp/seed.sql

# Remove the seeded rows again:
python3 scripts/seed_listings.py --wipe --out /tmp/wipe.sql
AVATOK_TARGET=staging scripts/cf.sh worker d1 execute DB_META --remote --file=/tmp/wipe.sql
```

## Idempotency

Every id is deterministic (`seed-live-1`, `seed-consult-1`, `seed-user-1`, …).
The generated file always opens with `DELETE ... WHERE id LIKE '<prefix>%'`
(or the matching FK-style column) against every table it writes to, followed
by `INSERT OR REPLACE` statements — so re-running the script and re-applying
the file replaces rows instead of duplicating them. Verified by round-tripping
the generated SQL twice through an in-memory SQLite database built from the
actual migration files: row counts are identical after the second apply.

`creator_profiles` is the one exception, by design: it's `INSERT OR IGNORE`
followed by an `UPDATE ... WHERE bio IS NULL`, so a real creator's existing
bio is never overwritten. `creator_stats` is `INSERT OR REPLACE` keyed on the
real `creator_id` (not a seed-prefixed id) since it's fully derived/cached
data — safe to overwrite, but for the same reason it is **never deleted** by
`--wipe`, so wiping the seed listings does not erase a real creator's stats
row.

## Columns worth double-checking before trusting this blindly

- **`kind='ai_agent'` is not API-reachable** — see above. Confirmed by reading
  `KINDS` in `listings.ts`, not inferred.
- **`reviews.reply`/`reply_at` vs `creator_reply`/`creator_reply_at`** — two
  column pairs exist (the old one from `phase8_verse.sql`, the new one from
  `2026-09-02-reviews-trust.sql`). `worker/src/routes/reviews.ts` dual-writes
  both on a host reply, and the listing-reviews SELECT in `listings.ts` still
  reads the OLD `reply`/`reply_at` pair. This script writes both pairs to the
  same value for any seeded review with a reply, matching the dual-write.
- **`cover_media` shape is `{type, url}`** (https-only, enforced by
  `normFields`), not `{type, r2_key}` as the original `listings.sql` table
  comment says — the comment is stale; `normFields`'s actual filter was
  followed instead.
- **`listing_categories` ids used** (`music`, `business`, `astrologers`) are
  the base rows seeded directly in `worker/migrations/listings.sql`, so they
  exist on every environment without depending on the later taxonomy-seed
  migration having run.
- **`listings.capacity`** is used for `seats_left` math regardless of `kind`
  (per `shapeCard`); the `CAPACITIES ∈ {1,10,20}` enum is only enforced for
  `consult` at publish time, so the live-event capacities here (60/20/40) are
  fine even though they're outside that set.
