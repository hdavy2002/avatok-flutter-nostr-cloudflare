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
| 10 | Go-live (owner said "continue" 2026-10-20): apply migrations, deploy worker, flip `hfBookingApprovalEnabled`, one-time "all influencers Online" | live | 9 |
| 11 | Make the owner's account (`hdavy2005@gmail.com`) an influencer (live host with slug, topics, availability) + a second test fan account for the other side | prod data | 10 |
| 12 | Build APK (`gh workflow run hf-flutter.yml --ref main -f mode=apk -f demo=false`) and sideload on the owner's phone (`scripts/hf_sideload.sh <run-id>`, USB, adb) | app on phone | 10 |
| 13 | Visual test BOTH sides on the phone (adb screencap + taps): influencer footer toggle, Settings rows, calendar drag-select + save, Bookings page mode switch, pending card Accept/Decline; fan profile Book → date → time → topic → confirm copy → "Waiting for approval" → decline/expiry refund in wallet. Fix what looks wrong, re-build, re-check. Screenshots saved to `output/hf-book-approve-shots/` | report | 11, 12 |

**Owner waived the mock-approval gate (Phase 4) on 2026-10-20** ("continue to code it … check visually on my phone"). Phase 4 = skipped; the design check happens in Phase 13 on the real phone, still following `Specs/HF-DESIGN-SYSTEM.md` §11 and HF-DS-8 tokens/sizes.

## 8. Safety rules for whoever builds this
- Production only, no staging. Confirm before any prod write (deploy, migration, flag). Never build unless owner asks.
- Never edit in the main folder; worktree per phase; `scripts/git_safe_commit.py` with explicit paths; `npx tsc --noEmit` before any worker deploy; commit before deploy.
- Money moves only through the existing hold/release path, idempotent op ids. Refunds go to the **wallet only**.
- No brand literals; no green in UI; Nunito ≥14 sp; Phosphor/approved icons per app rules.
- Update the rulebook and the progress file in the same commit as each phase.

## 9a. OWNER ANSWERS (2026-10-20) — these override §9 and the text above
- Q1 no answer → **influencer footer only** (default).
- **Q2: Online by default for ALL influencers, existing and new** → one-time `UPDATE hf_hosts SET presence='online' WHERE status='live' AND presence='offline'` at go-live, and every new live host starts `online`.
- Q3 no answer → default (deadline = earlier of 24 h or 1 h before start; manual mode needs ≥2 h notice).
- Q4 no answer → push + WhatsApp + email, no SMS.
- **Q5: reminders stay 1 h and 10 min** — do NOT add a 30-minute reminder. (Plan §3.8 / §5 "30 min?" row = dropped.)
- **Q6: add these topics** to `TOPICS` in `worker/src/lib/hf_options.ts` (new group "Fan calls" or the nearest existing group): `talk-about-my-channel` "Talk about my channel", `just-friendship` "Just friendship", `general-advice` "General advice". Keep max 6 per influencer. (The six suggested in §9 Q6 are NOT added.)
- Q7, Q8 → defaults (yes / yes).
- **Owner: "continue to code it, use your own worktrees and multiple agents; then install the app on my phone, make my user an influencer, and test both sides."** → Phases 10–13 below are approved.

## 9b. API CONTRACT (fixed 2026-10-20 — app and worker agents build to this; additive, everything new is dark behind `hfBookingApprovalEnabled`; with the flag off every response is exactly as today)

App-shaped booking (`GET /api/hf/bookings?role=fan|host…`, POST response, accept/decline responses) gains:
```
status: "pending_approval" | "confirmed" | "cancelled" | … (existing values)
approvalDeadline: ISO string | null      // only while pending_approval
topic: { slug, label } | null
cancelReason: "declined" | "not_accepted_24h" | "fan" | "host" | null
statusText: string                       // plain English, e.g. "Waiting for Priya to accept — auto-cancels in 17 h"
// host role only:
canAccept: bool, canDecline: bool
// fan role: canCancel is TRUE while pending_approval (free, full refund)
```
- `POST /api/hf/bookings {hostSlug,startAt,note?,topic?}` — `topic` = one of that host's topic slugs (400 `bad_topic` otherwise). Response adds `needsApproval: bool` and `approvalText` ("Sent to {name} for approval. If not accepted within 24 hours, ₹X returns to your wallet.").
- `POST /api/hf/bookings/:id/accept` → `{ ok:true, booking }` (409 `not_pending` / `expired`).
- `POST /api/hf/bookings/:id/decline {reason?}` → `{ ok:true, refunded:true, refundPaise, booking }`.
- `GET/PUT /api/hf/hosts/me/booking-settings` → `{ approval: "manual"|"auto", openAlerts: bool }`.
- `GET /api/hf/hosts/:slug/slots` response adds `topics: [{slug,label}]` (that host's) and `approvalMode: "manual"|"auto"`.
- `GET /api/hf/bookings?role=host&shape=app&status=pending|upcoming|past` optional filter (no filter = all, pending first).
- Presence is unchanged (`presence_repo.dart` / existing presence route); the footer button only calls it.
- Config: `hfBookingApprovalEnabled` (bool, default false) is exposed in `/api/hf/config` so the app shows approval UI only when true.

## 9. Open questions for the owner (defaults in **bold** will be used if no answer)
1. **Footer toggle placement:** influencer bar only (**default**), or also on the fan bar shown in the screenshot when the user is an influencer?
2. **Default Online:** apply to **new influencers only** (default), or also flip every existing influencer to Online once?
3. **Booking that starts in under 24 h:** deadline = **the earlier of 24 h or 1 h before the call** (default); booking requires ≥2 h notice in manual mode. Alternatives: block bookings <24 h ahead in manual mode.
4. "Other messaging" = **SMS?** India SMS needs DLT template registration and costs per message. Default: **push + WhatsApp + email now, SMS later**.
5. Reminders: keep 1 h + 10 min and **add 30 min** (default), or replace 10 min with 30 min?
6. Topic list: keep the current catalogue and **add 6 creator-friendly topics** (default): "Career advice", "Relationship advice", "Study & exams", "Just chat / fan call", "Behind the scenes", "Birthday / special wish". Max topics per influencer stays 6?
7. Should an influencer in Auto-accept mode still be able to decline later (= influencer cancel, full refund)? **Yes** (default).
8. Should the fan be able to cancel a **pending** booking any time for a full refund? **Yes** (default).
