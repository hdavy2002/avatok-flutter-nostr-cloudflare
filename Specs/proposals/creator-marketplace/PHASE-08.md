# Phase 8 — AvaVerse Dashboard + AvaInbox Universal Inbox

**Read first:** `00-UNIVERSAL-PROPOSAL.md` §1, §4. Prereqs: Phases 6, 7
(data sources). AvaVerse currently = "Your dashboard" placeholder.

## ⚠️ ALREADY BUILT — verified 2026-06-10. Reuse, don't duplicate.
- **System-notice feed EXISTS:** `worker/src/notify.ts` + `migrations/
  notifications.sql` + `routes/notifications.ts` — typed notices (wallet|system|
  moderation|social|brain|payment) persisted to D1, realtime via inbox DO,
  push via Q_PUSH. **AvaInbox "System" rows = this feed** — render it, don't
  re-plumb it.
- **InboxDO + messaging routes exist** (DM/conversation core) — AvaInbox is a
  filtered VIEW as specced; the `context` tag is the only backend addition.
- **Server-side PostHog capture EXISTS:** `worker/src/hooks.ts` (`track`,
  `metric`, `brainFact`) — Verse/worker events use these helpers, per
  ANALYTICS-OBSERVABILITY.md.
- `agent_inbox` table (agent.sql) holds AI-agent messages — surface as another
  AvaInbox source chip ("Agent"), don't merge stores.
- Verse aggregation/snapshots: genuinely NEW — build as specced.

## Objective
AvaVerse = the creator's bird's-eye view: money earned, projections ("400 joined ×
$10 ⇒ you may earn ~$3,200 after fees"), audience analytics, top events, reviews
to reply to. AvaInbox = every message from anywhere (event pages, channel pages,
future apps) in one place.

## Part A — AvaVerse

### Backend (`routes/verse.ts` — aggregation only, no new stores)
- `GET /api/verse/summary` →
  - **Earnings card:** settled total (period selector: today/7d/30d/all), pending
    escrow, next payout-able amount.
  - **Projections card:** per upcoming event: joined_count × price × 0.8;
    per fully-booked consult day: slots × price × 0.8 ("your day is booked —
    ≈$X by tonight").
  - **Momentum:** joins in last 24 h per event ("last night 500 people joined —
    1,000 now waiting").
  - **Top events:** by revenue / joins / views.
  - **Audience:** event views vs opens vs joins (funnel), subscribers/followers,
    top countries — sourced from PostHog query API (events already instrumented:
    `listing_viewed`, `listing_opened`, `booking_created`) + D1 counts.
  - **Reviews to reply:** latest unanswered reviews/comments.
- Cache summary per user (KV, 60 s TTL); heavy PostHog queries via consumers cron
  into a `verse_snapshots` row (daily) so the screen opens instantly.

### Flutter (`app/lib/features/verse/`)
- Card grid: Earnings, Projected, Live momentum, Top events (mini bar chart),
  Audience funnel, Reviews-to-reply (tap → reply composer → posts public reply).
- Period selector; pull-to-refresh; every card deep-links into its app.
- "Morning feel": delta badges vs yesterday (+500 joins, +$120).
- Optional (flag): daily digest push/email "while you slept: N joins, ≈$X".

## Part B — AvaInbox

### Design
Rides the existing **InboxDO** (per-user DO-local SQLite — already the message
core). No new message store. AvaInbox is a UNIFIED VIEW over conversations with a
`context` tag.
- Extend conversation meta: `context` = {dm, event:<listingId>, channel,
  consult:<bookingId>, system} set when the thread is created (Phase 6 "Message"
  button sets `event`/`channel`).
- `GET` via existing sync; new filter views server-side if needed.

### Flutter (`app/lib/features/inbox/`)
- One list, newest first, each row: source chip (Event inquiry / Channel /
  Consult / System), counterpart, snippet, unread dot.
- Filter chips by source; tap → existing thread UI (reuse messenger screens).
- Buyer-side messages from "Message creator" land here for creators; replies flow
  back through the same thread. System rows: refunds, settlements, booking
  changes (deep-link to wallet/booking).
- Unread badge on the sidebar AvaInbox entry; per-account scoped local cache.

## Acceptance criteria
- [ ] AvaVerse numbers reconcile with wallet ledger + listings tables (spot-check
      script comparing summary vs raw queries).
- [ ] Projection card matches: joined×price×0.8 for a seeded event.
- [ ] Message sent from an event details page appears in creator's AvaInbox tagged
      "Event inquiry" with the event name; reply reaches the buyer.
- [ ] Review reply posts publicly under the review (Phase 6 data).
- [ ] Dashboard opens <1 s from snapshot cache.

## Folded from audit (build in this phase)

### A1. Announce to followers [MUST]
- AvaVerse card "Reach": follower count + button **"Notify followers"** on any
  upcoming listing → composer (prefilled "X invites you: <title>, <date>") →
  fan-out via Phase 6 A2 `Q_FANOUT` (push + optional email).
- Caps (shared with auto-fan-out): max 2 announcements per creator per day,
  enforced server-side (`fanout_log` table); button shows remaining quota.
- Auto-suggest: when an event is <24 h away and joins are below the creator's
  average, AvaVerse nudges "Remind your followers?".
- Acceptance: announcement reaches followers with notify=1 only; third attempt
  in a day is refused with a clear message.

### A2. Earnings statements [SHOULD]
- `GET /api/verse/statement?month=YYYY-MM&format=csv` — rows: date, type
  (ticket/consult/donation), listing, gross, platform fee, net, order id;
  footer totals reconciled against the ledger. Generated server-side from
  `wallet_ledger` (creator credit rows).
- UI: AvaVerse → Earnings card → "Statements" → month list → share sheet
  (CSV; PDF via the same data LATER). Email-me-statement option (Brevo
  attachment).
- Pending-vs-available split shown on the Earnings card (held escrow vs settled
  balance vs already-paid-out), so creators always understand "where's my money".
- Acceptance: statement totals == AvaVerse summary == ledger query for the month.

## Definition of done
Deploy (staging then prod), Graphiti episode, STATUS_REPORT.md, push.
