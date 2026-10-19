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
| 1 | HF-WIRE-1 Foundations (ApiClient, Clerk, /api/hf/me, config/update prompt, states, deep links, telemetry) | ✅ (code) | HF-WIRE-1A, 1B, 1C | CI mode=check green (run 39235025525). Worker change NOT deployed yet. Screens still on dummy data. |
| 2 | HF-WIRE-2 Fan sign-up (WhatsApp OTP → account → resume action) | ✅ (code) | HF-WIRE-2 | Flag hfFanSignupEnabled + hfPhoneOnlySignupEnabled; 2 migrations to apply. |
| 3 | HF-WIRE-3 Channels + treg (10-follower rule, approval) | ✅ (code) | HF-WIRE-3 | Flag hfChannelsEnabled; migration hf-channels; secret TREG_API_KEY (YOUTUBE_API_KEY exists). treg params unverified on live data. |
| 4 | HF-WIRE-4 Reels import + jev face check, real feed, demo seed `is_demo` | ✅ (code) | HF-WIRE-4 | Flag hfReelsEnabled; migrations hf-reels + hf-demo-hosts. GAP: approved influencers get no slug → feed skips them (fix in next batch). |
| 5 | HF-WIRE-5 Presence (Online/Offline, busy, Notify me) | ✅ (code) | HF-WIRE-5 | Gated by hfCallsEnabled OR hfReelsEnabled. |
| 6 | HF-WIRE-6 Wallet + Cashfree top-up (GST ÷1.18, webhook, receipts) | ✅ (code) | HF-WIRE-6 | Reuses POST /api/hf/wallet/topup + webhook; new GET /api/hf/app/wallet. Secrets CASHFREE_APP_ID/SECRET_KEY; flags hfTopupEnabled, hfTopupGateway=cashfree, hfTokensEnabled. Checkout on avatok.ai (Cashfree whitelist). |
| 7 | HF-WIRE-7 Instant calls (Vobiz live, call screen, reviews, records) | ✅ (code) | HF-WIRE-7 | Needs hfCallsEnabled, HF_CALL_DID, VOBIZ_* secrets; two-phone test pending. |
| 8 | HF-WIRE-8 Bookings (availability, holds, reminders, auto-start, calendars) | ✅ (code) | HF-WIRE-8 | Adapter over existing bookings router; migration hf-booking-notes; auto-start cron runHfBookingAutoStart; flag hfBookingsEnabled. |
| 9 | HF-WIRE-9 Favourites, Search, Invite votes | ✅ (code) | HF-WIRE-9 | /api/hf/search, invite votes (migration hf-invite-votes), favourites store, share sheet (share_plus). Flags hfReelsEnabled, hfInvitesEnabled, hfFavouritesEnabled. |
| 10 | HF-WIRE-10 Payouts (request, admin UTR queue, WhatsApp) | ✅ (code) | HF-WIRE-10 | /api/hf/payouts/* adapter (UPI, KYC only at first payout → website KYC page), split text per HF-REEL-30, slug assigned on Channels approval. Flag hfPayoutsEnabled. |
| 11 | HF-WIRE-11 Settings (prefs, delete account, legal) | ✅ (code) | HF-WIRE-11 | Real prefs/name/version/legal links, delete account via /api/hf/account/exit. Email/WhatsApp change = write to support (no OTP-change route). Play data-safety draft: Specs/HF-PLAY-DATA-SAFETY.md. |
| 12 | HF-WIRE-12 Hardening (strip dummy data, analytics, crash, a11y, closed test) | ✅ (code) | HF-WIRE-12 | CI input `demo` (default true); PostHog via HF_POSTHOG_KEY secret (not set yet); app_crash to PostHog; a11y + 14 sp floor; R8 rules; test plan Specs/HF-CLOSED-TEST-PLAN.md. Live mode compiles but is untested on a device. |

## 3. Owner answers to the open questions (handover §10)
- Q1 Min followers: **10** (confirmed, not 10,000) — HF-REEL-23.
- Q2 Fan WhatsApp: **verify by OTP** — HF-REEL-24.
- Q7 Platforms at launch: **Instagram + YouTube**; Facebook "coming soon" — HF-REEL-25.
- Q10 Top-up payment: **Cashfree** (not Play Billing) — HF-REEL-25.
- Channel data (after research): YouTube official API + treg for Instagram, bio-code ownership — HF-REEL-26.
- Face check: none at launch; influencer picks her feed reels — HF-REEL-27.
- Q6 Booking cancel: free until 1 h before; influencer cancel always refunds — HF-REEL-28.
- Q8 Search: our network + exact handle lookup — HF-REEL-29.
- Q4 Split text: follow server rule (₹2 + 40% above ₹2) — HF-REEL-30.
- Q3/Q5 Payouts: KYC + UPI at first payout; fans refund only — HF-REEL-31.
- Q9 Demo influencers: admin pastes YouTube links — HF-REEL-34.
- NEW 2026-10-19: embeds only (HF-REEL-32); YouTube sign-in (HF-REEL-33); call money rules + monitor (HF-REEL-35); anyone can withdraw (HF-REEL-36).

## 2b. Round 2 (owner 2026-10-19 evening) — rework after review
| # | Stage | Status | Notes |
|---|---|---|---|
| R2-A | HF-WIRE-13 Money rules engine + monitor (HF-REEL-35/36): ₹20 minimum, ₹1 first-minute drop, wallet-only refunds, fan payouts, reconciliation cron | ⬜ | |
| R2-B | HF-WIRE-14 Embeds only + YouTube sign-in + admin demo links (HF-REEL-32/33/34) | ⬜ | Needs Android OAuth client for com.hellofraands.app with youtube.readonly |
| R2-C | HF-WIRE-15 Rewrite policies, web pages, help centre, FAQs, app help to match HF-REEL-35/36 | ⬜ | |
| R2-D | Go live: migrations, deploy worker, flags, Clerk toggle, build demo=false | ⬜ | |

Secrets found 2026-10-19: worker already has CASHFREE_APP_ID, CASHFREE_SECRET_KEY, HF_CALL_DID, VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, VOBIZ_WEBHOOK_SECRET, YOUTUBE_API_KEY, WASENDER_API_KEY. Local copies in gitignored `secrets/` (cashfree.env, secret-values.env incl. POSTHOG_API_KEY). **TREG_API_KEY is not saved anywhere — ask the owner.**

## 5. Go-live checklist (owner / last agent)
1. Apply D1 migrations (worker/migrations/2026-10-19-*.sql) with `scripts/cf.sh worker d1 execute DB_META --remote --file=...` (ALTER files via d1_apply_alters.py).
2. Secrets: TREG_API_KEY, CASHFREE_APP_ID, CASHFREE_SECRET_KEY, HF_CALL_DID, VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, VOBIZ_WEBHOOK_SECRET (YOUTUBE_API_KEY exists).
3. Deploy the worker.
4. Flags: hfFanSignupEnabled, hfPhoneOnlySignupEnabled, hfChannelsEnabled, hfReelsEnabled, hfCallsEnabled, hfTopupEnabled, hfTopupGateway=cashfree, hfTokensEnabled (check), hfBookingsEnabled, hfFavouritesEnabled, hfInvitesEnabled, hfPayoutsEnabled.
5. Clerk dashboard: "Require email address" OFF (Specs/HF-NATIVE-AUTH.md §4).
6. Add GitHub secret HF_POSTHOG_KEY. Go live on the phone with `gh workflow run hf-flutter.yml --ref main -f mode=internal -f demo=false` — only when the owner asks. Then run Specs/HF-CLOSED-TEST-PLAN.md.

## 4. Log (newest last)
- 2026-10-19 — Stage 0: progress log created on main. Next: Stage 1 (HF-WIRE-1).
- 2026-10-19 — Owner answered Q1, Q2, Q7, Q10 (rules HF-REEL-23…25). Starting Stage 1 with parallel agents: A = Flutter foundations, B = worker audit + /api/hf/me + flags, C = treg/jev research.
- 2026-10-19 — Stage 1 DONE (code on main):
  - 1A Flutter (`hf-flutter/lib/data/*`, `lib/ui/async_view.dart`, `lib/ui/update_prompt.dart`, `lib/core/deep_links.dart`; splash boots session + /me + config; intro-seen persisted; `DemoMode` dart-define HF_DEMO=true keeps dummy screens). Tests in `test/data`, `test/ui`. CI green.
  - 1B Worker: `/api/hf/me` extended (name, email, whatsapp, role, hostStatus, presence, walletPaise, prefs); flags hfReelsEnabled, hfChannelsEnabled, hfInvitesEnabled (off), hfDemoInfluencersVisible (on), hfInfluencerMinFollowers=10. Full route gap list: `Specs/HF-REELS-BACKEND-AUDIT.md` — READ IT before stages 2–10 (real route paths differ from the handover, e.g. calls start = POST /api/hf/calls, estimate = /api/hf/wallet/estimate, presence = PUT /api/hosts/me/presence, top-up = POST /api/hf/wallet/topup {amount rupees}). Note: 24 pre-existing HF vitest failures on main (10 files, listed in the 1B report) — not caused by this work.
  - 1C Research: `Specs/HF-TREG-JEV-RESEARCH.md`. treg is a pay-per-call scraper gateway (~$0.0019/call); jev is text-only and cannot detect faces. Recommendation: YouTube Data API v3 + ScrapeCreators/treg for Instagram, Instagram Login OAuth or bio-code for ownership, Google Cloud Vision (or Workers AI) on thumbnails for the face check.
  - Next: Stage 2 (HF-WIRE-2 fan sign-up with WhatsApp OTP). Stages 3–4 blocked on owner decision about data source / face check.
- 2026-10-19 — Owner decided HF-REEL-26/27. Launching in parallel: Stage 2 (fan sign-up), Stage 3 (Channels), Stage 5 (presence).
- 2026-10-19 — Stages 2, 3, 5 merged (sign-up, Channels, presence). /api/hf/me role=host for approved too.
- 2026-10-19 — Stages 4, 6, 7 merged (reels import + real feed, wallet + Cashfree top-up, instant calls). Integration CI green (run 39240200960). Owner answered Q3–Q6, Q8 (HF-REEL-28…31).
  - IMPORTANT for anyone continuing: NOTHING is deployed. The app still runs dummy screens unless built with `--dart-define=HF_DEMO=false`. Go-live checklist is §5 below.
  - Next batch: Stage 8 bookings, Stage 9 favourites/search/invites, Stage 10 payouts, Stage 11 settings, plus fix: assign a slug when Channels approves an influencer; replace the "60% minus ₹2" text.
- 2026-10-19 — Stages 8, 9, 10, 11 merged. Integration CI green (runs 39258253758, 39258596466).
  - To check with owner: Help FAQ says refunds go to the original payment "within 180 days" (agent wording, not an owner rule).
  - Next: Stage 12 hardening (default HF_DEMO=false for release builds, remove dummy data from release, PostHog + crash reporting, TalkBack labels, closed test) and the go-live checklist in §5. Still open: Q9 demo influencer content.
- 2026-10-19 — Stage 12 merged. ALL 12 CODE STAGES DONE. Nothing deployed; the owner's phone still runs the demo.
  - What is left (in order): owner sets secrets + applies migrations + deploys worker + flips flags (§5); build with demo=false; run the closed test plan (two-phone call, Cashfree sandbox, booking auto-start, real IG/YT channel); fix what the tests find; Play closed test 12 testers × 14 days.
  - Known gaps: no influencer "today" summary route (tiles hidden); email/WhatsApp change goes through support; treg Instagram parameters unverified on live data; Crashlytics not added (PostHog only); Q9 demo influencer content still open; FAQ "within 180 days" refund wording needs owner OK.
- 2026-10-19 — Owner round 2: new rules HF-REEL-32…36 recorded. Launching R2-A, R2-B, R2-C in parallel.
