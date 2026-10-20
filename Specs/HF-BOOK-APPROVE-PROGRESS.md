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
| 0b | Owner answers §9 + rulebook rows HF-BOOK-1…7 | ⛔ | — | — | Waiting for owner. |
| 1 | Backend: `pending_approval`, booking-settings, accept/decline, 24 h expiry + wallet refund cron, flag `hfBookingApprovalEnabled`, migration, tests | ⬜ | `../wt-hf-book-approve-1` / `issue/hf-book-approve-1` | — | — |
| 2 | Backend: topic on booking, host topics endpoint, topic catalogue additions | ⬜ | `../wt-hf-book-approve-2` | — | — |
| 3 | Backend: message matrix, open-window alert cron, 30-min reminder, money-monitor checks | ⬜ | `../wt-hf-book-approve-3` | — | — |
| 4 | Design mocks (footer toggle, calendar drag-select, influencer Bookings, fan flow) → owner approval | ⬜ | — | — | HF-DS-8: no Dart before approval. |
| 5 | App: footer Online/Offline (default Online) + Settings rows | ⬜ | `../wt-hf-book-approve-5` | — | — |
| 6 | App: availability calendar drag-select | ⬜ | `../wt-hf-book-approve-6` | — | — |
| 7 | App: fan booking flow (topic, approval copy, pending states) + My bookings | ⬜ | `../wt-hf-book-approve-7` | — | — |
| 8 | App: influencer Bookings page (mode switch, pending, upcoming, calendar) + deep links | ⬜ | `../wt-hf-book-approve-8` | — | — |
| 9 | Verify: vitest, tsc, ship gate, design + brand guard, CI `hf-flutter.yml mode=check` | ⬜ | — | — | — |
| 10 | Go-live (owner says): migrations, worker deploy, flag on, build on request, two-phone test | ⬜ | — | — | Production writes need owner confirmation. |

## Owner answers (plan §9)
_None yet. Defaults in the plan apply until answered._

## Log (newest first)
- 2026-10-20 — Phase 0: read existing code. Found: availability API, bookings (no approval step), reminders 1 h/10 min, topics catalogue, presence + nudges, influencer `/inf/*` shell already exist. Wrote plan + this tracker.
