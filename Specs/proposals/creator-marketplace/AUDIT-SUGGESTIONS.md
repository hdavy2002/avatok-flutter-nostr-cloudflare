# Audit — Developer / User / Creator Perspectives

**Date:** 2026-06-10. Re-audit of `00-UNIVERSAL-PROPOSAL.md` + Phases 1–10 +
PERF-MEMORY-BUDGET.

> **STATUS 2026-06-10: ALL [MUST] and [SHOULD] items below have been FOLDED into
> their phase files** as detailed "Folded from audit" sections (P1: staging, kill
> switches, error states · P2: idempotency, ops console + reconciliation, rate
> limits, receipts · P3: compliance/tax · P5: join-link web fallback, timezones,
> booking policies, reschedule, reminder ladder · P6: search, follows, guest
> browsing, trust, promos, preview/duplicate, channel polish, checkout top-up ·
> P7: live moderation, test clock + DLQ, pre-call check/rejoin, stream health,
> block list · P8: announce-to-followers, statements · P9: GDPR deletion map).
> **Build sessions should read the phase files — this file remains only as the
> [LATER] backlog and audit record.**

Tags: **[MUST]** fold into the named phase before building ·
**[SHOULD]** build in the same phase if time allows · **[LATER]** post-launch.

## TOP 5 — things that break the product if missed

1. **[MUST · P5/P6] Join links need app links + a web fallback page.** Emails say
   "here is the link to join" — but a tapped link only works if Android App Links
   are configured AND there's a fallback (user reads email on a laptop, or app not
   installed). Minimum: a tiny Cloudflare Pages page per booking/event →
   "Open in app / Get the app" + event info. Without this, reminder emails dead-end.
2. **[MUST · P2] Money ops console + reconciliation.** Support WILL need to: look
   up a ledger, force a refund, resolve "I paid but can't join". Build admin-only
   worker routes + a minimal internal screen (flag-gated, admin Clerk role) in
   Phase 2, and a nightly **reconciliation cron**: Σledger per account == cached
   balance; Σescrow == open orders; mismatch → alert email. A money engine without
   reconciliation hides bugs until they're expensive.
3. **[MUST · P6] Marketplace search.** Phases only define category browse. Users
   will expect a search bar (title/creator/category) + filters (price range, date,
   country, language, rating) + sort (soonest/cheapest/popular). D1 FTS5 is enough.
4. **[MUST · P6/P8] Follow system wired to notifications.** `follower_count`
   exists but no follow action. The creator-economy flywheel is: follow → push
   "X is live now / just published" → join → pay. Add `follows` table, Follow
   button (channel + post-event), and a fan-out push on publish/go-live (Queues).
5. **[MUST · P7] Live moderation tools for creators.** A live chat with flying
   messages and no mute/ban = day-one abuse problem. Creator HUD needs: mute user,
   ban-from-room, slow mode, profanity filter hook into the existing moderation
   pipeline. Plus viewer-side "report".

## A. Developer perspective (build & operate)

- **[MUST · P2/P7] Idempotency everywhere money moves:** client sends an
  `Idempotency-Key` on book/donate/withdraw; server dedupes (KV, 24 h TTL).
  Webhooks (Stripe, Wise, LiveKit, Stream) all signature-verified + replay-safe
  (partially specced — make it a checklist item per phase).
- **[MUST · P7] Test clock for the refund engine.** R1–R7 are time-based; build
  `TEST_CLOCK_OFFSET` (staging only) so no-show paths are testable in minutes,
  not by waiting 20 real minutes. Vitest the rules table in isolation.
- **[MUST · P1] Staging environment.** Wrangler envs (`--env staging`) + separate
  D1/R2/queues + Stripe/Wise sandbox keys + a staging APK flavor. Phases all say
  "deploy" — define WHERE first.
- **[MUST · P1] Kill switches.** Server-driven feature flags (KV-backed
  `/api/config`) so wallet/live/donations can be disabled remotely without an APK
  release (APKs ship via CI; rollback is slow).
- **[MUST · P5] Timezones discipline.** Store UTC epoch everywhere (specced);
  add: availability_rules are tz-aware (DST!), all UIs render in device-local
  time with explicit tz label on cross-tz bookings ("10:00 your time / 19:30
  creator time"). Countdown timers sync to server time (one `/api/time` ping) —
  device clocks lie.
- **[MUST · P7] Dead-letter + alerting.** Refund/settlement cron failures go to a
  DLQ + email alert to davy. A silently stuck settlement = angry creators.
- **[SHOULD · P2] Rate limits / abuse caps:** donations (max/min amount,
  velocity), bookings per user/hour, review post rate, flying messages (specced).
  One shared limiter helper in the worker.
- **[SHOULD · P6] `joined_count` updated atomically** (`UPDATE ... SET joined_count
  = joined_count + 1`) — never read-modify-write.
- **[SHOULD · P1] Error/empty/offline states are part of every screen spec:**
  empty wallet, no bookings, no search results, offline banner with cached data.
  Cheap now, expensive to retrofit.
- **[SHOULD · P3] Compliance runway:** payouts to humans = tax reporting
  (1099-K/DAC7 depending on country) + Wise KYB requirements on OUR platform
  account + terms-of-service acceptance logging at listing creation. Start the
  paperwork in parallel with Phase 3 — it has long lead times.
- **[SHOULD · P9] GDPR surface:** account delete must cascade: vectors, ledger
  (retain per finance law, anonymize), files, bookings. Write the deletion map
  once, in Phase 9 alongside "delete my AvaBrain data".
- **[LATER] API versioning header for old APKs; contract tests between app and
  worker; load test LiveRoomDO fan-out at 1k viewers.**

## B. User (buyer) perspective

- **[MUST · P5] Reschedule, not just cancel.** Life happens; forcing
  cancel+rebook eats refund-rule goodwill. Buyer proposes new slot → creator
  accepts → blocks swap atomically. (Also a creator want — see C.)
- **[MUST · P6] Guest browsing.** Let people browse AvaExplore before signup;
  gate only booking/paying. The marketplace is the ad for the platform.
- **[MUST · P7] Pre-call connection check + rejoin.** Mic/cam/network test on
  the pre-join screen; if a consult drops, both sides can rejoin within the slot
  (entitlement persists). Specced lightly — make it an acceptance criterion.
- **[SHOULD · P6] Saved/favorites + "notify me".** Heart a listing; push when it
  starts soon or price drops. Pairs with the follow system.
- **[SHOULD · P2] Receipts.** Email receipt per purchase (Brevo template, line
  items + fee). Many buyers expense consultations.
- **[SHOULD · P5] Second reminder.** T-24 h email + T-10 min push (the T-60 email
  is specced). Three touches = far fewer no-shows = fewer refund fights.
- **[SHOULD · P6] Trust signals:** "ID verified" badge on KYC'd creators,
  attendee-only reviews (specced), report listing/creator, block creator.
- **[SHOULD · P7] Insufficient-funds UX everywhere money is spent:** inline
  top-up sheet specced for donations — same for booking checkout.
- **[LATER] Replays of paid events (ties to AvaTube), waitlists for full
  consult days, gift bookings, multi-currency display, auto top-up.**

## C. Creator perspective

- **[MUST · P5] Booking policies:** buffer minutes between sessions, minimum
  notice (e.g. no bookings <2 h out), max sessions/day, vacation mode (pause all
  availability). Without buffers, back-to-back consults collide with the
  20-min-wait rule. Schema: extend `availability_rules` + a `booking_policies`
  row per creator.
- **[MUST · P6] Listing preview-as-buyer + duplicate listing.** Creators iterate;
  recreating a weekly event from scratch kills them. "Duplicate" + edit date is
  80% of repeat usage.
- **[MUST · P8] Announce to followers.** One button: "Notify followers" on
  publish/go-live (capped frequency to prevent spam). This is the creator's
  marketing engine — pairs with Top-5 #4.
- **[SHOULD · P6] Promo levers:** early-bird price until date X, promo codes
  (% off, max uses), free-event option (price 0 → skips escrow). Data model:
  `listing_promotions` table; wallet flow already handles amount=0.
- **[SHOULD · P8] Earnings clarity:** statement export (CSV/PDF per month),
  fee breakdown per order, pending-vs-available split, payout history in one
  view. Creators do taxes.
- **[SHOULD · P7] Stream health on the HUD:** bitrate/connection indicator +
  "viewers may be lagging" warning; auto-reconnect on publisher drop (grace
  window so R7 doesn't auto-refund a 10-second blip — define: infra-failure
  refund only after 5 contiguous minutes of downtime).
- **[SHOULD · P6] Channel polish:** banner image, external links, intro video,
  pinned listing. Channel page IS the creator's storefront.
- **[SHOULD · P7] Block list:** creator can block a buyer (no future bookings/
  joins); abusive-buyer protection mirrors buyer-side reporting.
- **[LATER] Co-host/moderator roles in live, tiered tickets (VIP), recurring
  session packages (buy 5 get 1), subscriber memberships, strike appeal flow.**

## Folding plan

MUST items belong in their named phase files before that phase starts (small
edits, mostly additive). SHOULD items: decide per phase at session start.
This file rides along at handover with `00-UNIVERSAL-PROPOSAL.md` +
`PERF-MEMORY-BUDGET.md` until folded.
