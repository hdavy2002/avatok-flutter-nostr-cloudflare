# HF-BOOK-APPROVE — BUILD PROGRESS LOG (live)

> ## 📣 MESSAGE TO THE NEXT AI — READ THIS FIRST
> The owner (Davy) asked for: an Online/Offline button in the app footer (default Online), an influencer
> availability calendar (drag-select days, then time slots), "you're open now" alerts, topic choice in
> bookings, an influencer Bookings page with **Auto-accept / Manual approval** (default manual), and a
> **24-hour rule**: a booking not accepted in 24 h is cancelled and the money goes back to the caller's wallet,
> with WhatsApp + email + push messages to both sides.
>
> **The plan you must follow is `Specs/PLAN-2026-10-20-HF-BOOKING-APPROVAL.md`.** This file says what is done.
>
> How to read the board below:
> - ✅ DONE = finished and committed (commit listed). Do not redo it.
> - 🟨 IN PROGRESS = the previous AI **started this phase and ran out of tokens before marking it done.**
>   Go to the worktree/branch named on that row, run `git status` + `git log origin/main..HEAD`, read the
>   "Last step" note, check what is half-done, then finish that phase. Do not start the next phase first.
> - ⬜ NOT STARTED = untouched.
> - ⛔ BLOCKED = waiting on the owner (see "Owner answers").
>
> Rule for you too: **set a row to 🟨 with a "Last step" note BEFORE you start it, update "Last step" after
> every meaningful step, and set ✅ with the commit id when it lands.** If the next AI finds 🟨, it knows
> where you stopped.
>
> Also read: `CLAUDE.md` (production-only, worktree per issue, safe commit/push, no local Flutter build,
> brand.json, PostHog), `Specs/RULEBOOK-HELLO-FRAANDS.md` (§16 HF-REEL-*, HF-SITE-13), `Specs/HF-DESIGN-SYSTEM.md` §11,
> `Specs/HF-REELS-BUILD-PROGRESS.md` (how the app was wired, HF-WIRE-1…14).

## Board

| # | Phase (plan §7) | Status | Worktree / branch | Commit(s) | Last step / notes |
|---|---|---|---|---|---|
| 0 | Plan + tracker written | ✅ | — | (see git log `[HF-BOOK-APPROVE-0]`) | 2026-10-20. Plan + this file. Waiting on owner answers to plan §9 before Phase 4/5 copy is final; Phases 1–3 can start on the defaults. |
| 0b | Owner answers §9 recorded (plan §9a) + API contract fixed (plan §9b) | ✅ | — | `[HF-BOOK-APPROVE-0B]` | 2026-10-20. Rulebook rows HF-BOOK-1…7 are written by the backend agent in Phase 1's commit. |
| 1–3 | Backend: approval state, settings, accept/decline, 24 h expiry refund cron, topics (+3), messages, open-window alerts, money monitor, rulebook HF-BOOK-1..7 | ✅ landed on main | integ branch | `3f9da18f` | 3 migrations: `2026-10-20-hf-booking-approval-alters.sql` (d1_apply_alters.py), `2026-10-20-hf-booking-approval.sql`, `2026-10-20-hf-presence-online.sql` (plain execute). Flag hfBookingApprovalEnabled. |
| 4 | Design mocks | ⏭ SKIPPED | — | — | Owner waived 2026-10-20; visual check on phone in Phase 13. |
| 5+6 | App: footer Online/Offline pill (influencer bar), Me/Settings rows, drag-select availability calendar (`screens/availability_real.dart`) | ✅ landed on main | integ branch | `973e93ac` | Not compiled locally; CI mode=check is the compile. |
| 7+8 | App: data layer (§9b), fan flow with topic + approval copy, My bookings chips, influencer Bookings approval page, booking deep links | ✅ landed on main | integ branch | `dd94af23` | Known gap: app has no push-tap handling (firebase_messaging unused) — links only. Push paths /dashboard/appointments and /host don't map to app routes. |
| 9 | Verify + land | ✅ | integ | `903db13f` | tsc clean, 70 booking tests pass, design/brand/flags guards OK, CI hf-flutter mode=check run 39386214890 = success. |
| 10 | Go-live | ✅ | — | — | 2026-10-20 ~13:00 IST: alters applied (7 cols), CREATE applied, presence-online applied, worker deployed (version 4f92dc8c), consumers deployed (9d7204b9), flag hfBookingApprovalEnabled=true (verified with flags.sh get). Note: prod had 0 hf_hosts before this. |
| 11 | Owner → influencer + QA influencer | ✅ | — | — | Owner uid user_3AuqQadIDHJftJtTkLD0DtKM8MB is live influencer slug `humphrey-davy` (manual approval, topics: channel/friendship/advice, ₹10/min). QA influencer `qa_hfbook_host` slug `qa-test-influencer` (fake verified phone +910000000000, availability 21–27 Oct 10:00–21:00) so the owner can test the FAN side by booking it. SQL: `output/hf-book-approve-qa/qa_setup.sql`; REMOVE after testing with `qa_teardown.sql` (cf.sh worker d1 execute DB_META --remote --file=…, copy the file under worker/ first). |
| 12 | Build APK + sideload | ✅ | — | — | Installed run 39392171792 with --fresh; owner signed back in (same account, wallet intact). Phone set to stay awake on USB (`adb shell svc power stayon usb`). |
| 13 | Visual test both sides | 🟨 IN PROGRESS | — | — | Last step: influencer side partly tested (Me rows, availability drag-select works). Found+fixed (HF-BOOK-APPROVE-QA-1, worker 99da75f4 deployed, APK run 39410959808 (39409817696 failed on one outdated test, fixed)): availability save refused when a booking sat outside saved times; 8 h auto-offline sweep removed (HF-BOOK-8) + everyone set Online again; save row no longer jumps; Me label "Calls booked with me". Phone locked by itself at 16:04 — waiting for owner to unlock. APK 39410959808 is INSTALLED on the phone (signed in). Phone is locked — owner must unlock (and set screen timeout 30 min / Stay awake). NEXT, save availability 21–25 Oct 6–8 pm, footer toggle, influencer Bookings page (2 QA pending cards: Accept one), fan side: Search “QA Test Influencer” → Book → topic → confirm → Waiting for approval → cancel (refund). Then qa_teardown.sql. |
| 14 | Push notification taps open the right screen | ✅ landed + worker deployed | integ | `4e894393` + test fix | FCM was never registered before. Flag hfPushEnabled=true set 2026-10-20 (server-only). Needs CI secret HF_GOOGLE_SERVICES_JSON (present) and consumers FCM_SERVICE_ACCOUNT (present, project avatok-e19ef). Verify on phone: token registered (hf_push_tokens row for owner) and a tap opens the booking. |

## Owner answers (plan §9)
See plan §9a (2026-10-20): all influencers default Online (existing + new); reminders stay 1 h + 10 min; add topics "Talk about my channel", "Just friendship", "General advice"; footer influencer-only; no SMS; mock gate waived; build + sideload + both-sides test approved.

## Log (newest first)
- 2026-10-20 16:10 — Phone test round 1: see row 13. Other notes for owner: WhatsApp OTP sender shows the old profile name "Saa Thum" (WasenderAPI number profile — change in WhatsApp); feed says "0 online now" was the 8 h sweep (fixed).
- 2026-10-20 — Synthetic QA pending bookings (₹0, ids qa0000a…/qa0000b…) inserted INTO the owner so the influencer Waiting-for-you card can be tested (Accept only). Removed by output/hf-book-approve-qa/qa_teardown.sql — RUN IT before 27 Oct 19:00 IST or the auto-start cron may dial the fake QA number.
- 2026-10-20 — Push-tap agent: row 14 code complete (push.dart, deep_links openPush, worker open-window path, telemetry hf_app_push_opened); tsc + push/booking vitest green; Dart not compiled.
- 2026-10-20 — APK built (run 39386798479). Phone dropped off USB before install; waiting for owner to reconnect.
- 2026-10-20 — Coordinator: go-live done (migrations, worker+consumers deploy, flag on); owner made influencer; QA influencer created; APK build running.
- 2026-10-20 — Coordinator: merged be + app-a + app-b into issue/hf-book-approve-integ; tsc + booking tests green; landing to main.
- 2026-10-20 — Backend agent: DONE, committed `0c3f4a8c` (not pushed). tsc green; new tests pass; full-suite failures identical to origin/main baseline (pre-existing).
- 2026-10-20 — Backend agent: code complete, tsc green, existing HF tests green (hf_calls_end/corrections failures are pre-existing on origin/main: no such column presence_call_id in the test shim). Writing tests + docs next.
- 2026-10-20 — Phase 1-3 backend agent started in ../wt-hf-book-approve-be.
- 2026-10-20 — Phase 0: read existing code. Found: availability API, bookings (no approval step), reminders 1 h/10 min, topics catalogue, presence + nudges, influencer `/inf/*` shell already exist. Wrote plan + this tracker.
