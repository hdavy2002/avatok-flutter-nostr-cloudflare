# Phase 5 — AvaCalendar + AvaBooking (One Conflict-Aware Calendar)

**Read first:** `00-UNIVERSAL-PROPOSAL.md` §2, §6. Prereq: Phase 1.

## Objective
ONE availability engine for the whole platform. Every time-consuming thing a
creator does — AvaLive event, AvaConsult session, anything future — lands in the
same calendar. Creating anything that overlaps an existing block is impossible:
the slot is greyed out and marked "occupied by <app>". Google Calendar sync.
AvaBooking shows bookings as blips that expand into detail cards.

## Backend (`routes/calendar.ts`, `routes/booking.ts`, D1 `avatok-meta`)

### Schema
```sql
CREATE TABLE calendar_blocks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,          -- the CREATOR whose time is blocked
  source_app TEXT NOT NULL,       -- avalive|avaconsult|gcal|manual|...
  source_ref TEXT,                -- eventId / bookingId / gcal event id
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,   -- UTC epoch s
  title TEXT, status TEXT NOT NULL DEFAULT 'busy',        -- busy|tentative|cancelled
  created_at INTEGER
);
CREATE INDEX idx_blocks_user_time ON calendar_blocks(user_id, starts_at, ends_at);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL, buyer_id TEXT NOT NULL,
  listing_id TEXT NOT NULL, kind TEXT NOT NULL,   -- live_event|consult_1to1|consult_group
  starts_at INTEGER, ends_at INTEGER,
  price INTEGER, order_id TEXT,                   -- escrow ref (Phase 2/7)
  status TEXT NOT NULL,  -- confirmed|completed|cancelled_user|cancelled_creator|no_show_user|no_show_creator|refunded
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_bookings_creator_time ON bookings(creator_id, starts_at);
CREATE INDEX idx_bookings_buyer_time  ON bookings(buyer_id, starts_at);

CREATE TABLE availability_rules (        -- creator's offered hours for consults
  id TEXT PRIMARY KEY, user_id TEXT, weekday INTEGER,  -- 0-6
  start_min INTEGER, end_min INTEGER, tz TEXT, slot_min INTEGER DEFAULT 60
);
```

### The conflict engine (the heart of this phase)
- `checkAvailability(userId, start, end)` → overlap query on `calendar_blocks`
  (status='busy'). Used by EVERY scheduling write path.
- `claimBlock(...)` — check + insert atomically (D1 batch); race-safe rejection
  `409 {conflictWith: {source_app, title, starts_at}}` → UI shows
  "Already occupied by AvaLive: <event>".
- `GET /api/calendar/slots?creator=&date=&dur=` → free slots = availability_rules
  minus calendar_blocks. **Occupied slots are returned flagged, not omitted**, so
  buyer/creator pickers render them greyed-out.
- Example enforced: live event 21 Jun 2026 10:00–11:00 exists ⇒ creating a consult
  at 10:00 is rejected, and 10:00–11:00 renders greyed in every picker.

### Google Calendar sync (per-account OAuth)
- OAuth (Google Calendar API, incremental consent) from settings; tokens encrypted
  in D1 (or KV), scoped per user.
- **Outbound:** every confirmed block/booking → insert/patch/delete a gcal event.
- **Inbound:** webhook channel (or 15-min cron fallback) imports busy gcal events
  as `source_app='gcal'` blocks ⇒ external meetings also grey out platform slots.
- Loop-guard: skip importing events we exported (extended-property marker).

### Notifications — the platform email matrix (Brevo templates + FCM, built here)
| Trigger | To | Content |
|---|---|---|
| Booking confirmed | buyer + creator | "You have a booking" — what/when/price, ICS attachment, join link |
| **T-60 min reminder** | buyer + creator | "Within 1 hour you have a consultation/event with <name> — here is the link to join" |
| Cancelled (either side) | both | who cancelled, refund applied per rules |
| Refund issued (any rule) | buyer (+creator for no-show wording) | "Your money was refunded" — amount, reason (e.g. "creator no-show" / "you never showed up; creator waited 20 min, 20-min waiting time deducted, rest refunded") |
| Settlement paid | creator | gross, fee, net to wallet |
| Payout sent/failed | creator | Wise status (Phase 3 hooks in) |

- **Reminder cron** on `avatok-consumers`: every minute, scan `bookings` (and
  live-event orders) with `starts_at` in [now+59 m, now+60 m] AND `reminder_sent=0`
  → send email+push with join deep-link → mark sent (idempotent). Add
  `reminder_sent INTEGER DEFAULT 0` to `bookings`/`orders`.
- Template ids in config; all later phases (6/7) reuse these templates — no phase
  invents its own email path.

## Flutter

### AvaCalendar (`app/lib/features/calendar/`)
- Month view with **blips** (colored dot per source_app) + week/agenda views.
- Tap blip → card popup: title, app icon, date/time, counterpart, price, status,
  buttons (open in AvaLive/AvaConsult, cancel per policy).
- Settings: connect Google Calendar (status, disconnect), availability rules
  editor (weekday ranges, slot length, timezone).

### AvaBooking (`app/lib/features/booking/`)
- Creator-facing list+calendar of all bookings (upcoming/past tabs) over the same
  data; same blip→card interaction; per-booking earnings shown after settlement.
- Buyer's own bookings appear in their AvaCalendar too.

Local-first drift cache (per-account scoped); offline-friendly month render.

## Acceptance criteria
- [ ] Overlapping consult on a live-event slot is rejected by API + greyed in UI
      with "occupied by AvaLive" labeling (the 21 Jun 10:00 scenario).
- [ ] Two parallel claim attempts on one slot ⇒ exactly one wins.
- [ ] Gcal: platform booking appears in Google; external gcal busy event greys
      platform slots within sync interval; no echo loops.
- [ ] Booking emails (with ICS) + push delivered on confirm/cancel.
- [ ] Blip→card popup matches spec; per-account scoping verified.

## Folded from audit (build in this phase)

### A1. Join-link web fallback + app links [MUST]
- Android App Links: `assetlinks.json` on `avatok.ai` + intent filters for
  `https://avatok.ai/j/<token>`; app routes the token → booking/event screen.
- Cloudflare Pages route `avatok.ai/j/<token>`: tiny page (no framework) showing
  event/consult title, time in viewer's local tz, creator name + buttons
  "Open in AvaTOK app" (intent URL) / "Get the app" (Play Store). Token =
  signed short-lived JWT mapping to bookingId; page calls a public worker
  endpoint `GET /api/join-info/:token` for display data only (no PII beyond
  title/time/names; joining still requires the app + auth).
- ALL emails use `https://avatok.ai/j/<token>` as the join link.
- Acceptance: link opens app directly when installed; same link on a desktop
  browser shows the fallback page.

### A2. Timezone discipline [MUST]
- All storage UTC epoch (already specced). Additions:
  - `availability_rules.tz` is an IANA zone; slot expansion uses zone rules
    (DST-safe) — never a fixed offset. Unit-test a DST-transition week.
  - Cross-tz bookings render BOTH times: "10:00 (your time) · 19:30 (creator)".
  - `GET /api/time` returns server epoch; client computes `clockSkew` at app
    start and uses it for every countdown (reminders, waiting-room, time
    remaining) — device clocks lie.

### A3. Booking policies + vacation mode [MUST]
```sql
CREATE TABLE booking_policies (
  user_id TEXT PRIMARY KEY,
  buffer_min INTEGER DEFAULT 10,        -- gap enforced between sessions
  min_notice_min INTEGER DEFAULT 120,   -- no bookings closer than this
  max_per_day INTEGER DEFAULT 8,
  vacation_until INTEGER                -- epoch; NULL = active
);
```
- `GET /api/calendar/slots` applies all four: slots within buffer of an existing
  block, closer than min-notice, beyond max_per_day, or during vacation are
  returned flagged-unavailable (greyed with reason tooltip).
- `claimBlock` re-validates policies server-side (UI greying is not enforcement).
- Creator UI: policies editor inside AvaCalendar settings; vacation toggle with
  end date ("Pause bookings until…"); existing bookings unaffected + warning.
- Acceptance: with buffer 15 min, a 10:00–11:00 booking makes 11:00 slot
  unavailable but 11:15 available; vacation hides all slots; API rejects a
  forged claim violating any policy.

### A4. Reschedule flow [MUST]
```sql
CREATE TABLE reschedule_requests (
  id TEXT PRIMARY KEY, booking_id TEXT, proposed_by TEXT,
  new_start INTEGER, new_end INTEGER,
  status TEXT DEFAULT 'pending',   -- pending|accepted|declined|expired
  created_at INTEGER
);
```
- Either side proposes (`POST /api/booking/:id/reschedule` — new slot must pass
  availability+policies); other side gets email+push with Accept/Decline; accept
  swaps `calendar_blocks` + `bookings` times atomically and re-sends ICS;
  decline keeps original; pending expires at original start time.
  Money is untouched (same order). Max 2 reschedules per booking, then
  cancel-per-rules only.
- UI: "Propose new time" on the booking card → slot picker (greyed conflicts);
  banner on the booking while a proposal is pending.
- Acceptance: full propose→accept cycle moves the gcal event too; a conflicting
  proposal is rejected at propose time.

### A5. Reminder ladder [SHOULD]
- Extend the reminder cron: **T-24 h email** ("Tomorrow: …") and **T-10 min
  push** ("Starting soon — tap to join") in addition to the T-60 email+push.
  Columns `reminder24_sent`, `reminder10_sent` alongside `reminder_sent`.
  All three idempotent and clock-skew safe (cron uses server time only).

## Definition of done
Deploy (staging then prod), Google OAuth creds in secrets, assetlinks deployed,
Graphiti episode, STATUS_REPORT.md, push.
