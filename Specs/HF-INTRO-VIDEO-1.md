# HF-INTRO-VIDEO-1 — Influencer intro video, human approval, new Reels (MASTER PLAN)

Owner-approved 2026-10-28 ("go"). Rules: `Specs/RULEBOOK-HELLO-FRAANDS.md` §20 (HF-INTRO-1…21).
**Every agent working on this reads this file and §20 first. If code and this file disagree, ask the coordinator — do not guess.**
Design rules: `Specs/HF-DESIGN-SYSTEM.md` (Nunito/Comfortaa only, nothing tiny, not boxy, no green except Online + verified tick).
Brand: never type the brand name or domain — `BRAND.*` / `brandUrl()` / `Brand.*` (CLAUDE.md).

## 0. Goal in one paragraph

No more YouTube/Instagram videos in our Reels. Every influencer records ONE live 10–20 second vertical intro
video inside our onboarding, saying what fans can call them about. A human (an employee) watches every
submission and approves or rejects it; WhatsApp tells the influencer either way. Only approved intro videos
play in the Reels (app + website /explore), with our own overlay: name, green tick, verified social icons,
categories, one line, ₹/min, a smart Call / Queue / Book button, Like / Comment / Share. A Women-to-Women
channel is a category: creator and fan must both be Aadhaar-verified Female.

## 1. Decisions (owner, 2026-10-28) — the source of truth

| # | Decision |
|---|---|
| D1 | Becoming an influencer = onboarding flow below. **Nobody is an influencer until a human approves.** No AI check of videos. |
| D2 | **Categories: choose one or more.** Normal ones first (Astrology, Teacher, Traveller, Cook, Fitness, Music, Beauty, Tech, Comedy, Spirituality, Career, Health & Wellness, Language, Gaming, Other). **Always last, in this order: Listener, Prayer, Virtual friend, Women-to-Women.** LGBTQ+ is NOT offered in onboarding (existing LGBTQ+ channels untouched). |
| D3 | **"Channels" is renamed "Social media verification"** everywhere a person sees it. Optional. YouTube login + Instagram login (exist) + **Facebook login (new; live only after Meta review — flag off until then)**. |
| D4 | **Aadhaar is required** when: no verified social account, OR any of Listener / Prayer / Virtual friend / Women-to-Women is picked. Women-to-Women needs Aadhaar gender **F** (else the category cannot be picked). Reuse the existing Aadhaar check (Sandbox.co.in). |
| D5 | **No separate selfie video.** The live intro video replaces the space-creator selfie (HF-SPACE-2 selfie step dropped for this flow). |
| D6 | **Recording prep screen**: language at top (Hindi, English, Marathi, Bengali, Tamil, Telugu, Gujarati, Punjabi, Kannada, Malayalam), "What is this video about?" = one of their categories or General, then hints (say / avoid) in that language. Always the note: "These are only ideas — say it in your own words." |
| D7 | **Recorder**: live camera + mic only, **min 10 s, max 20 s**, **portrait only** ("Please hold your phone upright" and recording blocked when sideways), **no file upload anywhere**, preview, re-record / use it. One intro video per influencer. |
| D8 | Then the existing profile steps (name, description, photo) and per-minute rate. |
| D9 | **Call option** (onboarding + dashboard switch): **A = Bookings only** (only bookings, ever, online or not). **B = Bookings + live** (Online & free → Call now; Online & on a call → Busy: Join queue or Book; Offline → reel hidden, bookings still open from profile/search). A closed day = she closes calendar slots. |
| D10 | Queue: as HF-CALL-9/10, but the **break between queued calls is 2 minutes** (config). |
| D11 | Last screen: "Sent for approval. A person from our team will check your profile. Once approved you can receive calls." |
| D12 | **Admin**: list of pending submissions (rows); click → full detail: video, categories, language, description, rate, call option, calendar, verified socials, Aadhaar status (+ Female). **Approve** → live, reel appears. **Reject** → ready-made reasons (multi-select) + optional note → send. |
| D13 | **WhatsApp** on approve ("you're live") and on reject (reasons + what to fix). Rejected → can fix, re-record, resubmit. |
| D14 | **Reels show only approved intro videos** (app + web). Overlay: name + **green tick** (= approved by our team), small YouTube/Instagram/Facebook icons for each verified account (tap opens that account inside our app), **pink "Women only" tag** when it applies, categories, one-line description, **₹X/min**, smart main button. Right rail: **Like, Comment, Share** (share link plays the video). |
| D15 | **ⓘ** opens "Verified owner of": each verified account with a link (opened inside our app). |
| D16 | Show rules: option A → reel always shown (button Book a time). Option B → reel shown only when Online (Call now / Busy). Offline B → hidden. |
| D17 | **Women-to-Women**: fan must be Aadhaar-verified **F** to call, book or queue (server already enforces `lane_required`; change: **fan needs Aadhaar only, no selfie**). Reel shows the pink tag; tapping Call/Book/Queue as a non-verified fan opens a pop-up: "This is a women-only channel. Only Aadhaar-verified women can talk to her." [Verify now] [Not now]. Verified but not F → "Sorry, this channel is for women only." |
| D18 | **Existing influencers** must record an intro and be re-approved; hidden from Reels until then (dashboard banner + WhatsApp). |
| D19 | Video storage: Cloudflare **R2** (vertical MP4 + poster), long cache. Not Cloudflare Stream. |
| D20 | Server never rings an Offline / Bookings-only / busy influencer except a booked call (already true — keep and re-test). |
| D21 | Deploy only after the owner reads the final plain-English summary. Everything new ships dark behind flags. |

## 2. Phases

| Phase | What | Lane(s) |
|---|---|---|
| **0** | Save this plan + rulebook §20; land docs. | coordinator |
| **1** | **Backend**: tables + migration, upload of recorded video to R2, submission API, admin review API + WhatsApp, reels feed from intro videos, call option A/B + reel visibility, queue break 2 min, women-only fan = Aadhaar F only, categories list, "verification" naming in API messages, Facebook login (code, flag off). | W1 (intro + admin + feed), W2 (call option + women + queue), W3 (Facebook login) |
| **2** | **Website UIs**: onboarding screens (category, social verification rename, Aadhaar step, prep, recorder, call option, submitted), admin approval page, /explore reel overlay + women-only pop-up + ⓘ sheet + share. | B1 (onboarding), B2 (admin), B3 (explore reels) |
| **3** | **App UIs (Flutter, hf-flutter)**: same onboarding screens, reels overlay, pop-up, ⓘ sheet, share, call option switch. | A1 (onboarding), A2 (reels) |
| **4** | Copy: help / FAQ / terms ("verification", call options, women-only, intro video), rulebook rows marked built. | C |
| **5** | Verify: tsc, worker tests, ship gate, brand + design guard, visual check of web pages in the external browser on a build; owner summary. | coordinator |
| **6** | Deploy (only after owner OK): migrations, worker, web, flags on in order, app build on request. | coordinator |

## 3. Flags (all default false; declare in config.ts DEFAULTS)

- `hfIntroOnboardingEnabled` — new onboarding flow + submission + admin review.
- `hfIntroReelsEnabled` — Reels play intro videos only (old embed feed off).
- `hfCallOptionEnabled` — option A/B semantics + D16 visibility (on top of existing hfCallModesEnabled).
- `hfFacebookLoginEnabled` — Facebook login button + routes.
- numeric `hfQueueBreakSeconds` = 120 (needs numericKeys entry).

## 4. Data (sketch — W1 owns the final shape)

- `hf_intro_videos(id, uid, r2_key, poster_key, duration_ms, width, height, lang, topic, created_at, status[draft|submitted|approved|rejected|replaced])`
- `hf_influencer_applications(id, uid, status[submitted|approved|rejected], categories_json, lang, intro_video_id, call_option[A|B], submitted_at, reviewed_at, reviewer_uid, reject_reasons_json, reject_note)`
- `hf_hosts`: `categories_json`, `call_option`, `intro_video_id`, `intro_approved_at` (hidden from reels until set).
- Reject reason codes: `face_unclear`, `video_dark`, `audio_unclear`, `contact_shared`, `unsuitable`, `wrong_category`, `description_fix`, `rate_fix`, `aadhaar_mismatch`, `other`.

## 5. Telemetry (PostHog, every surface; include email + clerk_uid)

`hf_onb_step_view{step}`, `hf_onb_categories{n, has_sensitive}`, `hf_intro_record{duration_ms, retake_n}`,
`hf_intro_upload{bytes, ms, ok}`, `hf_onb_submitted`, `hf_admin_review{decision, reasons}`,
`hf_review_whatsapp{decision, ok}`, `hf_reel_start{source:'intro'}`, `hf_women_gate{result}`,
`hf_reel_share`, `hf_social_link_open{platform}`.

## 6. Coordination

- Every lane works in its own worktree (`git worktree add -b issue/<id> ../wt-<id> origin/main`), commits with
  `scripts/git_safe_commit.py` and explicit paths, never `npm install` (symlink node_modules).
- Another agent owns `[HF-CALL-TOPUP-FIVE-1]` (call billing pause). Lane W2 must rebase on it and must not touch
  billing/pause code.
- No deploys, no flag writes, no builds by lanes. Coordinator only, after the owner's OK.
