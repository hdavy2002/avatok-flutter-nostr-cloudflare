# SPEC — Dashboard 2 (customer dashboard) — [DASH2-*] — 2026-09-25

Owner-approved plan: Claude Doc "Dashboard 2 — Implementation Plan"
(https://claude.ai/code/artifact/b8476dd1-e8d3-46c7-8ca2-7efb5cba5032). This file is the
build contract for the agents. Environment: PRODUCTION feature (`.avatok-target`=prod), but
agents NEVER deploy, push, or trigger workflows — the coordinator does, after owner approval.

## Owner decisions (2026-09-25)
- Saathum is a direct puja/havan service. Dashboard 2 is CUSTOMER-only. Creator tools are archived.
- Login (sign-in, sign-up, SSO, phone-gate finish) ALWAYS lands on `/dashboard` (Book events),
  unless the user was sent to sign in from a specific page (e.g. checkout) — then back there.
- Logout (`/sign-out`) ends the Clerk session and lands on the landing page `/`.
- UI: shadcn/ui components (+ 21st.dev-style polish) skinned with the landing tokens
  (`--grand-*` in web/src/styles/saathum-folk.css). Comfortaa headings, Nunito body.
  Owner rule: do NOT change existing landing designs.
- Payments source: HDFC UPI SMS rail (`hdfc_sms_payment_intents`, `bank_reference` = UTR)
  plus the existing commercial orders that intents point to (`commercial_order_id`).
- Refunds: manual from the bank app; admin enters refund UTR via an admin route. Users can
  REQUEST a refund only when the event starts 24h+ from now.
- VIDEO = YOUTUBE (owner decision 2026-09-25, final). Admin creates an UNLISTED YouTube live
  stream and pastes its link per event in the admin dashboard. The same video id serves live and
  replay. Paid users see it embedded in the event card (My events while live/upcoming-soon,
  Past events after). A transparent overlay covers the iframe so users cannot click the YouTube
  logo/title/links; our own controls (play, pause, stop, fullscreen) drive the YouTube IFrame
  Player API (controls=0, rel=0, modestbranding=1, disablekb=1, playsinline=1, iv_load_policy=3,
  youtube-nocookie.com). Fullscreen = our wrapper element, never YouTube's. The video id is only
  returned by the API to users who paid for that event. No Cloudflare Stream.
- Receipts titled "Payment receipt" (not tax invoice), issuer "Saathum". No GSTIN.
- Flag `dashboard2Enabled` (config.ts DEFAULTS, default false). When false, /dashboard renders
  the archived v1 overview; when true, Dashboard 2. (Server-read in the Astro page.)

## Routes (web)
| Menu | Route |
|---|---|
| Book events | /dashboard |
| My events | /dashboard/my-events |
| Past events | /dashboard/past |
| Billing | /dashboard/billing |
| Profile | /dashboard/profile |
| Logout | /sign-out |
Old v1 files → web/src/pages/archive/dashboard-v1/ (REMOVED flag, not deleted). Old v1 URLs
(/dashboard/bookings etc.) 301/redirect to the nearest new screen (bookings→my-events,
wallet/billing→billing, settings/identity→profile, everything else→/dashboard).
Layout: web/src/layouts/Dashboard2.astro. UI primitives: web/src/components/ui/* (shadcn).
Screens: web/src/islands/dashboard2/*.tsx. Tokens: web/src/styles/saathum-tokens.css
(imported by both landing and dashboard; values copied, landing look unchanged).
Responsive: sidebar ≥1024px, 72px icon rail 640–1023px, bottom tab bar <640px.

## API contract (worker) — all require Clerk auth, return ONLY the caller's rows
Money is INTEGER paise in the wire (`amount_paise`) and rendered as ₹ with 2 decimals only
when non-integer rupees. Times are epoch ms; UI shows IST.

GET  /api/me/catalog?q&cat&from&to&tod(morning|afternoon|evening)&min&max   (min/max in rupees)
  -> { categories:[{id,label,count}], groups:[{category:{id,label}, items:[Listing]}] }
  Listing = { id,title,description,category,category_label,deity?,image_url,starts_at,duration_min,
              price_paise,seats_left?,status,book_url }   (book_url = existing checkout/listing URL)
GET  /api/me/events?scope=upcoming|past
  -> { now, items:[{ order_id,listing:Listing, state:'pending_payment'|'upcoming'|'live'|'ended',
        starts_at, ends_at, join_url?, sankalp?:{name,gotra,wish,family:[]},
        replay:{available:boolean, until?:number}, youtube_video_id?:string /* paid users only */ }] }
  state computed SERVER-side (lib/listing_schedule.ts is the authority).
GET  /api/me/payments?q&cat&status&event_from&event_to&paid_from&paid_to&min&max&cursor
  -> { items:[PaymentLine], next_cursor? }   PaymentLine = { id,listing_id,event_title,category,
        event_starts_at,amount_paise,status:'paid'|'pending'|'refund_requested'|'refunded',paid_at }
GET  /api/me/payments/:id -> PaymentLine & { payer_vpa?, utr?, order_id, sankalp_name?,
        refund?:{requested_at,refunded_at?,amount_paise?,refund_vpa?,refund_utr?,status},
        can_request_refund:boolean, receipt_url }
POST /api/me/payments/:id/refund-request {reason?} -> {ok, refund}
GET  /api/me/payments/:id/receipt.pdf -> application/pdf (generated once, cached in R2 DIGITAL)
GET  /api/me/profile -> { name,email,photo_url?,language?,gotra?,family:[],phone:{e164_masked,verified},
        vpas:[{id,vpa,is_default}], address?:{name,line1,line2,city,state,pin,country},
        notify:{push,email,whatsapp} }
PUT  /api/me/profile (partial of the editable fields above except phone/vpas)
POST /api/me/vpas {vpa} · DELETE /api/me/vpas/:id · POST /api/me/vpas/:id/default
POST /api/me/phone/start {phone} -> {ok, expires_in_s}   (OTP to NEW number; 3/10min limit;
        refuse numbers verified on another account)
POST /api/me/phone/confirm {code} -> {ok, phone:{e164_masked,verified:true}}
        Swap is ONE transaction: new number becomes primary, old removed. Never zero phones.
        Deleting the only phone is refused (409 phone_required).
PUT  /api/admin/listings/:id/youtube {url} (admin only; accepts watch?v=, youtu.be/, /live/, /embed/ URLs or a bare 11-char id; url:'' clears) -> {ok, youtube_video_id}
GET  /api/admin/listings/:id/youtube -> {youtube_video_id?, url?}
POST /api/admin/refunds/:payment_id {refund_utr, amount_paise, refund_vpa} (admin only) -> {ok}
Errors: { error:'<code>', message } with proper status; never a silent catch.

## Data (D1, each CREATE in its OWN migration file — d1_apply_alters.py skips CREATEs)
refunds, receipts, user_profile_extras (gotra, family_json, language, notify_json),
user_addresses, user_vpas, push_subscriptions (table only; push later), event_videos
(listing_id PK, youtube_video_id, source_url, updated_at, admin_uid).

## Telemetry (PostHog via web/src/lib/analytics.ts; worker via hooks.trackException)
dash2_view{screen,load_ms} · dash2_search · dash2_filter_apply · dash2_join_click ·
dash2_replay_play/_error · dash2_receipt_download · dash2_refund_request · dash2_phone_change{step,ok} ·
dash2_pwa_install · dash2_login_landed · dash2_logout. Add them to
Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md.

## Hard rules for agents
- Edit/read/`npx tsc --noEmit` in device_bash is fine. NEVER `npm install`/`npm ci` in device_bash
  (Linux VM breaks macOS node_modules). Package installs, `astro build`, git ONLY via
  Desktop Commander on macOS: `cd /Users/davy/Documents/websites/avaTOK-2-Flutter/<dir> && …`.
- Commit ONLY your own files: `python3 scripts/git_safe_commit.py "[DASH2-<AREA>] msg" <paths…>`.
  Other agents have uncommitted work in web/src/pages/index.astro, ideas.astro, saathum-folk.css,
  _redirects, rituals/, ritualGuides.ts etc. — never stage those. If you must edit a file that is
  already dirty from someone else, stop and report instead.
- NO git push, NO deploy, NO `gh workflow run`, NO flags.sh set, NO remote D1 writes.
- No raw hex in components: use the tokens. No negative letter-spacing on NEW dashboard text.
