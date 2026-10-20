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
| 1–3 | Backend (agent "backend"): approval state, settings, accept/decline, 24 h expiry refund cron, topics (+3 new), messages, open-window alert cron, money monitor, rulebook rows | ⬜ | `../wt-hf-book-approve-be` / `issue/hf-book-approve-be` | — | — |
| 4 | Design mocks | ⏭ SKIPPED | — | — | Owner waived 2026-10-20; visual check on phone in Phase 13. |
| 5+6 | App (agent "app-inf-a"): footer Online/Offline + Settings rows + availability calendar drag-select (moved to `screens/availability_real.dart`) | ⬜ | `../wt-hf-book-approve-app-a` | — | — |
| 7+8 | App (agent "app-b"): data layer (models/repo for §9b), fan booking flow with topic + approval copy + pending states, fan My bookings, influencer Bookings page (mode switch, pending Accept/Decline, upcoming) + deep links | ⬜ | `../wt-hf-book-approve-app-b` | — | — |
| 9 | Verify + land: coordinator reviews each agent, vitest, tsc, ship gate, design + brand guard, CI `hf-flutter.yml mode=check` on main | ⬜ | — | — | — |
| 10 | Go-live: migrations, worker deploy, `hfBookingApprovalEnabled=true`, all live influencers → Online | ⬜ | — | — | Owner approved 2026-10-20. |
| 11 | Owner account → influencer; second test fan account | ⬜ | — | — | — |
| 12 | Build APK (`hf-flutter.yml mode=apk demo=false`) + sideload via `scripts/hf_sideload.sh` | ⬜ | — | — | Phone on USB, USB debugging on. |
| 13 | Visual test both sides on phone, fix, re-check; screenshots in `output/hf-book-approve-shots/` | ⬜ | — | — | Checklist in plan §7 row 13. |

## Owner answers (plan §9)
See plan §9a (2026-10-20): all influencers default Online (existing + new); reminders stay 1 h + 10 min; add topics "Talk about my channel", "Just friendship", "General advice"; footer influencer-only; no SMS; mock gate waived; build + sideload + both-sides test approved.

## Log (newest first)
- 2026-10-20 — Phase 0: read existing code. Found: availability API, bookings (no approval step), reminders 1 h/10 min, topics catalogue, presence + nudges, influencer `/inf/*` shell already exist. Wrote plan + this tracker.
