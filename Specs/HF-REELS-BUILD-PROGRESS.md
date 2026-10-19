# Hello Fraands Reels app — BUILD PROGRESS LOG (live)

> **Any AI taking over: read this file first, then continue from the first stage not marked DONE.**
> This file is updated after every stage or sub-stage. If it says IN PROGRESS, check the branch/worktree named on that line before redoing work.

## 0. Files you must use (in this order)
1. **This file** — `Specs/HF-REELS-BUILD-PROGRESS.md` (what is done, what is left, where the code is).
2. **The build plan** — `Specs/HF-REELS-APP-HANDOVER.md` (every screen, every button, backend tables/routes, build order §9, open questions §10).
3. **Rules** — `Specs/RULEBOOK-HELLO-FRAANDS.md` §16 (HF-REEL-1…22) and HF-CALL-1…6. Record every owner rule change there in the same commit.
4. **Design** — `Specs/HF-DESIGN-SYSTEM.md` §11 (Rang Bazaar theme) and `hf-flutter/lib/demo/theme.dart`.
5. **Brand** — `Specs/brand.json` (never type the brand name as a literal; run `scripts/gen_brand.py`).
6. **Existing backend contracts** — `Specs/HF-CALLS-CONTRACT.md`, `Specs/HF-WALLET-TOPUP.md`, `Specs/HF-APP-DEEPLINK.md`, `Specs/HF-NATIVE-AUTH.md`.
7. **claude.ai Project "SaatHum" docs** — `claude/hello-fraands-reels-app-handover.md`, `claude/hello-fraands-reels-app-plan.md`, `claude/hello-fraands-native-app-spec.md`, `claude/hello-fraands-rulebook.md`, `claude/hello-fraands-app-ALL-image-prompts.md`.

## 1. Working rules (short — full list in handover §2)
- No local Flutter/Android builds. CI only: `.github/workflows/hf-flutter.yml` (`mode=check` any branch; `mode=internal` main only and **only when the owner asks**).
- Same Play app `com.hellofraands.app`, same tester link: https://play.google.com/apps/internaltest/4701578137538251705
- One issue per worktree: `git worktree add ../wt-<id> -b issue/<id> origin/main` → `python3 scripts/git_safe_commit.py "[ID] msg" <paths>` → `git rebase origin/main && ALLOW_PUSH=1 git push origin HEAD:main` → remove worktree.
- Git/wrangler/vitest/gh run on the real Mac shell (Desktop Commander), not the Linux VM.
- New backend behaviour behind a flag in `worker/src/routes/config.ts`. New tables = own CREATE migration + `purgeHfUser`.
- Plain English, nothing under 14 sp, no green, gateway name never shown.

## 2. Stage board
Legend: ⬜ not started · 🟨 in progress · ✅ done · ⛔ blocked (needs owner)

| # | Stage (handover §9) | Status | Commit(s) | Notes |
|---|---|---|---|---|
| 0 | Progress log created | ✅ | (this commit) | 2026-10-19 |
| 1 | HF-WIRE-1 Foundations (ApiClient, Clerk, /api/hf/me, config/update prompt, states, deep links, telemetry) | ⬜ | | |
| 2 | HF-WIRE-2 Fan sign-up (WhatsApp OTP → account → resume action) | ⬜ | | Q2 answered: OTP |
| 3 | HF-WIRE-3 Channels + treg (10-follower rule, approval) | ⬜ | | Q1=10, Q7=IG+YT; treg research first |
| 4 | HF-WIRE-4 Reels import + jev face check, real feed, demo seed `is_demo` | ⬜ | | Open Q9; jev research first |
| 5 | HF-WIRE-5 Presence (Online/Offline, busy, Notify me) | ⬜ | | |
| 6 | HF-WIRE-6 Wallet + Cashfree top-up (GST ÷1.18, webhook, receipts) | ⬜ | | Q10=Cashfree |
| 7 | HF-WIRE-7 Instant calls (Vobiz live, call screen, reviews, records) | ⬜ | | |
| 8 | HF-WIRE-8 Bookings (availability, holds, reminders, auto-start, calendars) | ⬜ | | Open Q6 |
| 9 | HF-WIRE-9 Favourites, Search, Invite votes | ⬜ | | Open Q8 |
| 10 | HF-WIRE-10 Payouts (request, admin UTR queue, WhatsApp) | ⬜ | | Open Q3, Q5 |
| 11 | HF-WIRE-11 Settings (prefs, delete account, legal) | ⬜ | | |
| 12 | HF-WIRE-12 Hardening (strip dummy data, analytics, crash, a11y, closed test) | ⬜ | | |

## 3. Owner answers to the open questions (handover §10)
- Q1 Min followers: **10** (confirmed, not 10,000) — HF-REEL-23.
- Q2 Fan WhatsApp: **verify by OTP** — HF-REEL-24.
- Q7 Platforms at launch: **Instagram + YouTube**; Facebook "coming soon" — HF-REEL-25.
- Q10 Top-up payment: **Cashfree** (not Play Billing) — HF-REEL-25.
- Still open: Q3 fan withdrawals, Q4 revenue-split text, Q5 KYC at payout, Q6 booking cancellation cut-off, Q8 search source, Q9 demo influencer content. Ask before building those stages.

## 4. Log (newest last)
- 2026-10-19 — Stage 0: progress log created on main. Next: Stage 1 (HF-WIRE-1).
- 2026-10-19 — Owner answered Q1, Q2, Q7, Q10 (rules HF-REEL-23…25). Starting Stage 1 with parallel agents: A = Flutter foundations, B = worker audit + /api/hf/me + flags, C = treg/jev research.
