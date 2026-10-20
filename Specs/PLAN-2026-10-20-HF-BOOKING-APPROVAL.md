# PLAN — Hello Fraands: Online/Offline footer, availability calendar, topics, booking approval + 24-hour auto-refund

**Issue umbrella:** `HF-BOOK-APPROVE` (sub-ids `HF-BOOK-APPROVE-1` … `-10`, one per phase below)
**Owner request:** 2026-10-20 (Davy, from two app screenshots of the Me tab)
**Progress tracker (update after every phase):** `Specs/HF-BOOK-APPROVE-PROGRESS.md`
**Status of this file:** PLAN — nothing coded yet. Open questions in §9 need owner answers before Phase 5.

---

## 0. What the owner asked for (in his words, condensed)

1. **Online / Offline button in the bottom footer.** The influencer chooses to show as available for calls or offline. **Default = Online.**
2. **Calendar page in Settings** for the influencer: **drag to select several days** on a month calendar, then set **time slots for each selected day**.
3. **"You're open now" notification** to the influencer, fired **only on the days he selected and within those times**: "You have this time open — expect calls."
4. **Customer side:** if the influencer takes calls by prior booking, the profile shows a **calendar + Book a call** button → pick date → pick time → (topic) → confirm.
5. **Notifications everywhere** — phone push, WhatsApp, email and "the other messaging that comes to the phone" (= **SMS**, to confirm): customer knows the appointment is scheduled; influencer knows "so-and-so will call in 20/30 min".
6. **Bookings page (influencer)** shows all pending and upcoming calls: date, time, the caller's **username**, and the **topic** the caller picked.
7. **Topics:** at onboarding the influencer picks the topics he is comfortable talking about; the customer picks one of those topics in the booking flow. Create a general topic list influencers can use.
8. **Auto-accept vs manual approval** switch at the top of the influencer's Bookings page. **Default = manual approval.**
9. Manual approval → tell the influencer on **WhatsApp + email + push** that a booking is waiting, with details and the line **"Accept within 24 hours or we cancel it and refund the caller."** Tell the caller "Your booking has been sent for approval; if it isn't accepted within 24 hours, your money comes back to your wallet."
10. **Not accepted within 24 h → cancel the booking, refund the money to the caller's wallet, tell both** with their own message.

## 1. What already exists (verified in code 2026-10-20 — do not rebuild)

| Area | Exists today | Where |
|---|---|---|
| Influencer app shell | `/inf/*` shell with Bookings and Availability tabs (HF-REEL-15/17/18), real screens behind `BookingsBridge.real` | `hf-flutter/lib/demo/router.dart`, `screens/bookings_real.dart`, `screens/influencer.dart` |
| Fan bottom bar | Reels · Search · Favourites · Me (no Online/Offline) | `router.dart:112-122` |
| Presence | Online/Offline/busy, Notify me, offline nudges (HF-WIRE-5, HF-HOST-NUDGE-1) | `worker/src/routes/presence.ts`, `hf_wire5_presence`, `data/repos/presence_repo.dart`, `demo/presence_bridge.dart` |
| Availability | `GET/PUT /api/hf/hosts/me/availability` — `{ 'YYYY-MM-DD': {open, slots[]} }` in IST, 21-day horizon, hourly chips, stored as dated exceptions | `worker/src/routes/hf_bookings_app.ts:131-230`, `lib/hf_booking_availability.ts` |
| Fan slots | `GET /api/hf/hosts/:slug/slots` (free slots only) | same file |
| Bookings | quote → confirm, money held from wallet; statuses `confirming → confirmed → starting → active → settling → completed / cancelled / failed`. **No approval step: a confirmed booking is immediately confirmed.** | `worker/src/routes/hf_bookings.ts`, `lib/hf_booking_store.ts` |
| Booking note | Optional fan note on a booking | migration `2026-10-19-hf-booking-notes.sql` |
| Reminders | WhatsApp (+push) to both people **1 h and 10 min** before start; user switch "Appointment reminders"; kill switch `hfBookingRemindersEnabled` (HF-SITE-13) | `worker/src/lib/hf_booking_reminders.ts` |
| Auto-start | Booked call auto-dials at start time (cron `runHfBookingAutoStart`) | HF-WIRE-8 |
| Topics | 1–6 topics per host from a fixed catalogue `TOPICS` (groups: Naye dost, Mann ki baat, Tension, Zindagi ki baatein, Creator life, Interests & hobbies) | `worker/src/lib/hf_options.ts`, `hf_hosts.ts:132` |
| Cancel rules | Fan cancels free until 1 h before; influencer cancel always refunds; all refunds to wallet (HF-REEL-28, HF-REEL-35) | rulebook §16 |
| Channels | WhatsApp outbox (WasenderAPI, paced), push (FCM, `hf_push.ts`), email (Cloudflare Email / Brevo fallback) | `notifications.ts`, `hf_push.ts` |

So the **new** work is: footer toggle + default-online, drag-select calendar UI (backend mostly exists), the "you're open now" alert, topic choice on the booking, the **pending-approval state + auto-accept setting + 24 h expiry/refund**, the message matrix, and the influencer's pending/upcoming overview.

## 2. Rules to add to `Specs/RULEBOOK-HELLO-FRAANDS.md` (same commit as the code — proposed ids)

| Id | Rule (draft) |
|---|---|
| HF-BOOK-1 | Online/Offline switch sits in the influencer's bottom bar (centre). A **new** influencer starts **Online**. Offline keeps bookings open (HF-REEL-16 unchanged). |
| HF-BOOK-2 | Availability is set on a month calendar: drag across days to select, then give each selected day its time slots (one tap = "same slots for all selected days"). |
| HF-BOOK-3 | "You're open" alert: at the start of each open window, on open days only, the influencer gets one push (+ WhatsApp if switched on): "You're open for calls 6–9 pm today. Expect calls." Switch: Me › Notifications › Open-time alerts (default on). Never between 23:00 and 08:00 IST unless the window itself starts then. |
| HF-BOOK-4 | A booking carries one topic chosen by the fan from that influencer's topics (+ optional note). Influencer sees caller's **@handle**, never a phone number. |
| HF-BOOK-5 | **Approval mode** per influencer: *Manual approval* (default) or *Auto-accept*. Manual: the booking is `pending_approval`, money is held, slot is blocked. |
| HF-BOOK-6 | **24-hour rule**: a pending booking not accepted within 24 h of the request — or by the approval deadline if the call starts sooner (see §9 Q3) — is cancelled automatically, the full hold goes back to the caller's **wallet**, and both are told. Declined = same refund. Every request message to both sides states this rule. |
| HF-BOOK-7 | Message matrix §5 (push + WhatsApp + email; SMS only if owner confirms Q4). |

## 3. Data / backend changes (worker)

1. **Migration `2026-10-2x-hf-booking-approval.sql`** (CREATE in its own file; ALTERs in another — `d1_apply_alters.py` trap):
   - `ALTER TABLE hf_hosts ADD COLUMN booking_approval TEXT NOT NULL DEFAULT 'manual'` (`manual|auto`)
   - `ALTER TABLE hf_bookings ADD COLUMN topic_slug TEXT`, `approval_deadline INTEGER`, `approved_at INTEGER`, `decided_by TEXT`, `cancel_reason TEXT`
   - `CREATE TABLE hf_host_open_alerts (host_uid, date, start_min, sent_at, PRIMARY KEY(host_uid,date,start_min))` — dedupe for HF-BOOK-3
   - presence default: new hosts inserted Online (check `2026-10-09-hf-presence.sql` default + registration path)
   - add new tables to `purgeHfUser` / `hfPurgeTables`.
2. **Booking status** add `pending_approval` (between `confirming` and `confirmed`). Every place that lists active statuses (`BOOKING_ACTIVE`, occupancy checks, exit-gate checks, money audit, reminders, auto-start, calendars) must treat it as **blocking the slot but not startable and not reminded**. grep `'confirmed'` across `worker/src` — every hit reviewed.
3. **Confirm route:** after the hold succeeds → if host `auto` → `confirmed` (today's behaviour); else → `pending_approval` with `approval_deadline`. Idempotent.
4. **New routes** (behind new flag `hfBookingApprovalEnabled`, default false, declared in `config.ts` DEFAULTS + PlatformConfig — fake-flag rule):
   - `POST /api/hf/bookings/:id/accept` / `POST /api/hf/bookings/:id/decline {reason?}` (host only, atomic `WHERE status='pending_approval'`)
   - `GET/PUT /api/hf/hosts/me/booking-settings {approval:'manual'|'auto'}`
   - `GET /api/hf/hosts/me/bookings?status=pending|upcoming|past` incl. caller handle, topic, note, countdown
   - `GET /api/hf/hosts/:slug/topics` (or include in profile payload) for the fan's topic picker
5. **Cron `runHfBookingApprovalExpiry`** (every 5 min): `pending_approval` past deadline → `cancelled` (`cancel_reason='not_accepted_24h'`) → release hold to wallet (existing release path, op id `hfbook-expire:<id>`, exactly once) → messages. Same release path for decline.
6. **Cron `runHfOpenWindowAlerts`** (every 5 min): for windows starting in the last 5 min on open dates, not yet in `hf_host_open_alerts`, host not closing/blocked → push (+WA if opted in).
7. **Money monitor** (HF-REEL-35 §8): add checks — no `pending_approval` past deadline + 15 min; every expired/declined booking has exactly one release op.
8. **Reminders:** owner said "in the next 20 or 30 min" — add a **30-min** reminder or replace 10 min (§9 Q5). Reminders fire only for `confirmed`.
9. Tests (vitest, on the Mac shell): approve/decline races, expiry exactly-once refund, auto mode, flag off = old behaviour, purge.

## 4. App changes (Flutter, `hf-flutter/`)

> **Design gate (HF-DS-8):** new screens are mocked in a phone frame and **approved by the owner before any Dart is written** (theme per flow, tokens from `hf_tokens.dart`, Nunito ≥14 sp, 48 dp targets, no green). Phase 4 below is that gate.

| Screen | Change |
|---|---|
| Influencer bottom bar | Centre **Online/Offline** pill (big, labelled, not colour-only). If an influencer is viewing the fan shell, also show it in the fan bar (§9 Q1). |
| Settings / Me (influencer) | New rows **Availability calendar** and **Bookings** (shown only to influencers). |
| Availability calendar | Month grid; long-press-drag (and tap) to multi-select days; bottom sheet "Time slots for 3 days" with hourly chips (reuse `slotChoices`); per-day edit; Save → existing `PUT /availability`. 21-day horizon shown greyed beyond. |
| Influencer Bookings | Top: **Auto-accept / Manual approval** switch with one-line explanation. Sections: **Waiting for you** (Accept / Decline, "Auto-cancels in 17 h"), **Upcoming** (date, time, @handle, topic, note, "starts in 25 min"), month calendar dots, **Past**. |
| Fan profile | **Book a call** button + open-dates calendar (even when Offline). |
| Fan booking flow | date → time → **topic (influencer's list) + optional note** → confirm screen states: rate, hold, "Needs [name]'s approval. If not accepted within 24 h, the full amount returns to your wallet." → "Request sent" screen. |
| Fan My bookings | Status chip **Waiting for approval** + countdown; Approved; Cancelled — refunded to wallet. |
| Push deep links | Every message opens the right booking (`deep_links.dart`). |

## 5. Message matrix (copy in plain English, brand from `brand.json`, IST times, no phone numbers)

| Event | Caller gets | Influencer gets | Channels |
|---|---|---|---|
| Request (manual) | "Booking sent to {name} for {date, time}. They have 24 h to accept; if they don't, ₹{amount} goes back to your wallet." | "{@handle} wants a {10}-min call on {date, time} about {topic}. Accept within 24 h or it is cancelled and refunded." + Accept link | push, WA, email |
| Request (auto) / Accepted | "Confirmed: your call with {name} on {date, time}." | "Confirmed: {@handle} calls you {date, time}, topic {topic}." | push, WA, email |
| Reminder 1 h / 30 min? / 10 min | "Your call with {name} starts in {n} min." | "{@handle} will call you in {n} min — topic {topic}." | push, WA (existing HF-SITE-13) |
| Declined | "{name} couldn't take this booking. ₹{amount} is back in your wallet." | (none — or confirmation in app) | push, WA, email |
| Expired 24 h | "{name} didn't accept within 24 h, so we cancelled the booking. ₹{amount} is back in your wallet." | "The booking from {@handle} for {date} was cancelled because it wasn't accepted within 24 h. The caller was refunded." | push, WA, email |
| Open-window alert | — | "You're open for calls {6–9 pm} today. Expect calls." | push (+WA opt-in) |
| Reminder to influencer before expiry (suggested) | — | "Still waiting: {@handle}'s booking cancels in 4 h." at T-4 h | push, WA |

Rules that still apply: block = "not available" wording (HF-WELL-3); no verified WhatsApp = no WA; user notification switches respected; WA through the paced outbox only.

## 6. Telemetry (PostHog — mandatory)
`hf_booking_requested{mode}`, `hf_booking_accepted{latency_min}`, `hf_booking_declined`, `hf_booking_expired_refunded{amount_paise}`, `hf_booking_mode_changed`, `hf_presence_toggled{from,to,surface:'footer'}`, `hf_availability_saved{days,slots}`, `hf_open_alert_sent{channel}`, `hf_booking_msg_sent{event,channel,result}`. Both parties' uid/email on two-sided events. Add to `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` first; `tool/ship_manifest.json` entry per issue id with success values (e.g. expired booking ⇒ `hf_booking_expired_refunded` present AND wallet release op exists).

## 7. Phases (each = own worktree + `issue/hf-book-approve-N` branch, landed same day)

| # | Phase | Output | Depends |
|---|---|---|---|
| 0 | Plan + tracker + owner answers to §9 | this file, progress file, rulebook rows HF-BOOK-1…7 | — |
| 1 | Backend: approval state, settings, accept/decline, expiry+refund cron, flag, migration, tests | worker code + migration (not deployed) | 0 |
| 2 | Backend: topic on booking + host topics endpoint + topic catalogue additions | worker | 1 |
| 3 | Backend: message matrix (WA/push/email templates + outbox wiring), open-window alert cron, 30-min reminder, money-monitor checks | worker | 1 |
| 4 | **Design mocks** (phone frames) for footer toggle, calendar drag-select, influencer Bookings, fan booking flow; owner approves | mock HTML/PNG | 0 |
| 5 | App: footer Online/Offline (default online) + Settings rows | Dart | 4 |
| 6 | App: availability calendar drag-select | Dart | 4 |
| 7 | App: fan booking flow (topic, approval copy, pending states) + My bookings | Dart | 1,2,4 |
| 8 | App: influencer Bookings page (mode switch, pending, upcoming, calendar) + deep links | Dart | 1,3,4 |
| 9 | Verify: vitest, `tsc --noEmit`, ship gate, design guard, brand guard, CI `hf-flutter.yml mode=check` | green checks | 1–8 |
| 10 | Go-live (owner says): apply migrations, deploy worker, flip `hfBookingApprovalEnabled`, build on request, two-phone test (request → expiry → refund; request → accept → reminders → call) | live | 9 |

## 8. Safety rules for whoever builds this
- Production only, no staging. Confirm before any prod write (deploy, migration, flag). Never build unless owner asks.
- Never edit in the main folder; worktree per phase; `scripts/git_safe_commit.py` with explicit paths; `npx tsc --noEmit` before any worker deploy; commit before deploy.
- Money moves only through the existing hold/release path, idempotent op ids. Refunds go to the **wallet only**.
- No brand literals; no green in UI; Nunito ≥14 sp; Phosphor/approved icons per app rules.
- Update the rulebook and the progress file in the same commit as each phase.

## 9. Open questions for the owner (defaults in **bold** will be used if no answer)
1. **Footer toggle placement:** influencer bar only (**default**), or also on the fan bar shown in the screenshot when the user is an influencer?
2. **Default Online:** apply to **new influencers only** (default), or also flip every existing influencer to Online once?
3. **Booking that starts in under 24 h:** deadline = **the earlier of 24 h or 1 h before the call** (default); booking requires ≥2 h notice in manual mode. Alternatives: block bookings <24 h ahead in manual mode.
4. "Other messaging" = **SMS?** India SMS needs DLT template registration and costs per message. Default: **push + WhatsApp + email now, SMS later**.
5. Reminders: keep 1 h + 10 min and **add 30 min** (default), or replace 10 min with 30 min?
6. Topic list: keep the current catalogue and **add 6 creator-friendly topics** (default): "Career advice", "Relationship advice", "Study & exams", "Just chat / fan call", "Behind the scenes", "Birthday / special wish". Max topics per influencer stays 6?
7. Should an influencer in Auto-accept mode still be able to decline later (= influencer cancel, full refund)? **Yes** (default).
8. Should the fan be able to cancel a **pending** booking any time for a full refund? **Yes** (default).
