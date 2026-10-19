# Hello Fraands Reels app — backend audit (HF-WIRE-1B)

**Written:** 2026-10-19 · **Scope:** every backend route that `Specs/HF-REELS-APP-HANDOVER.md` §4 and §5.2 need, checked against `worker/` on `origin/main` (`53f8e891`).
Line numbers are for that tree; `config.ts` numbers are approximate (the file is ~3,500 lines and changes often).
Router mount points are in `worker/src/index.ts:1141-1171` (every `/api/hf/*`, `/api/hosts/*`, `/api/admin/hf/*` path). Sign-in is `requireUser` (Clerk Bearer JWT) everywhere unless stated.

"Stage" is the HF-WIRE-n build step from handover §9. "Flag" is the remote-config flag that must be on; **off = 404 `not_enabled`** unless noted.

## 1. Route table

### 1.1 Account, config, sign-up (HF-WIRE-1 / 2)

| Route | Exists? | Flag | Response shape (short) | Gap / what to add | Stage |
|---|---|---|---|---|---|
| `GET /api/hf/me` | YES `routes/hf_me.ts` (`getMe`) | none | `{uid, displayName, username, registrationComplete/Required, phoneMasked, whatsappVerified, ackVersion, age18ConfirmedAt, isHost, host:{status,slug}\|null, lanes, closing, tokensMode}` **plus (this stage)** `{name, email, whatsapp, role:'fan'\|'host', hostStatus, presence, walletPaise, prefs}` | Done in HF-WIRE-1B. `hostStatus` is the raw `hf_hosts.status` (`draft…live`); `pending_check`/`approved` do not exist until Channels (WIRE-3). `role` is `host` only when status is `live`. | 1B (done) |
| `PATCH /api/hf/me {displayName}` | YES `hf_me.ts` | none | `{ok, displayName}` | None. | 1 |
| `POST /api/hf/me/ack` | YES `hf_me.ts` | none | `{ok, ackVersion, age18ConfirmedAt}` | None. | 1 |
| Public app config `GET /api/config` | YES `routes/config.ts` `getConfig` (~3070) | none | Whole merged flag blob; `hfAppLatestBuild`, `hfAppMinBuild`, `hfAckVersion`, `hfTopup{}`, `hfStdPlan{}` etc. Server-only keys are deleted before sending (~3100-3115) | New flags (below) are public automatically. Edge-cached 60 s. | 1 |
| `GET /api/hf/options` | YES `routes/hf_hosts_list.ts:27` | `hostsPublicEnabled` | topics, moodGroups, languages, styles, priceMin/Max; public, 1 h cache | Handover wants it as the single topic source for Search chips. Works once `hostsPublicEnabled` is on. | 9 |
| WhatsApp OTP `POST /api/auth/whatsapp/send` / `/verify` | YES `routes/whatsapp_auth.ts:91, :170` (mounted `index.ts:1658-1659`) | `hfPhoneOnlySignupEnabled` (phone-only signup, server-only) | verify returns a Clerk sign-in ticket | Fan sign-up with name+email+WhatsApp: email is optional on this path. App must collect email separately (no route stores a fan-entered email). | 2 |
| `POST /api/hf/account/age-confirm` | YES `whatsapp_auth.ts:448` | none | `{ok,…}` | None. | 2 |
| `POST /api/account/phone/claim` | YES `whatsapp_auth.ts:469` | none | claims a verified phone for a signed-in account | None. | 2 |
| `GET/PUT /api/hf/me/registration`, `/me/username` | YES `routes/hf_registration.ts` | none | immutable username + legal acceptance | None. | 2 |
| `GET/PUT /api/hf/me/prefs` | YES `routes/hf_dash_v3.ts` (`prefs`, ~170) | none | `{ok, notifyWhatsapp, apptReminders}` | Handover wants `PATCH /api/hf/me/prefs` and a third switch "New reels from favourites". Add `PATCH` alias + `reelAlerts` column. `/me` now also returns the two existing switches. | 11 |
| `GET/PUT /api/hf/me/profile` | YES `hf_dash_v3.ts` | none | `{firstName,lastName,username,displayName,city,languages,talkAbout,joinedAt}` | Fine for Settings → Account. Email/WhatsApp change via OTP: no route. | 11 |
| `POST/DELETE /api/hf/push/register` | YES `routes/hf_push.ts` | `hfPushEnabled` (send only) | `{ok}` | None. | 1 |
| Delete account `POST /api/hf/account/exit` | YES `routes/hf_exit.ts` | `hfExitGateEnabled` (default on) | pay-out-first closure then purge | Handover says `/account/close`; real path is `/api/hf/account/exit`. App uses that. | 11 |

### 1.2 Reels, channels, search, invites, favourites (HF-WIRE-3 / 4 / 9)

| Route | Exists? | Flag | Response shape | Gap / what to add | Stage |
|---|---|---|---|---|---|
| `GET /api/hf/reels?cursor=` | **NO** (nothing named reel/channel exists in `worker/src`) | new `hfReelsEnabled` (declared 1B) | spec: online hosts only, `face_check=pass`, `visible`; `{items:[{id,hostSlug,name,handle,followers,rate,embedUrl,thumbUrl,caption,likes}], nextCursor}` | New route + `hf_reels` table + online count endpoint (`/api/hf/reels/online-count` or a field on the feed). Demo seed via `is_demo`. | 4 |
| `PATCH /api/hf/reels/:id {visible}` | NO | `hfReelsEnabled` | `{ok}` | New. Host-owned rows only. | 4 |
| `GET/POST/DELETE /api/hf/channels`, `POST /api/hf/channels/:id/resync` | **NO** | new `hfChannelsEnabled` (declared 1B) | spec §5.2 | New `hf_channels` table; treg client + `TREG_API_KEY` secret (not in repo); `hfInfluencerMinFollowers` check (declared 1B); approval sets host state. | 3 |
| Public profile `GET /api/hosts/public/:slug` | YES `routes/hf_hosts_public.ts:70` | `hostsPublicEnabled` | live host card (no uid/phone/KYC) | Extend with `reels[]`, `followers`, `presence`. | 4 |
| Host list `GET /api/hf/hosts?online=1&sort=…` | YES `hf_hosts_list.ts:26` | `hostsPublicEnabled` | `{items:[card], nextOffset, total}` | Usable for "Online now" row and Search results (offline). No text query param (`q`). | 9 |
| `GET /api/hf/search?q=` | **NO** | none yet | spec: groups Online / Offline / Not on HF | New. Name/handle/topic search over live hosts plus exact-handle lookup (treg) for "not on HF". Owner question 8 still open. | 9 |
| `GET /api/hf/favourites`, `GET/PUT/DELETE /api/hf/favourites/:slug` | YES `routes/hf_favourites.ts:34-37` (flag check :40) | `hfFavouritesEnabled` | `{ok, items:[{slug,displayName,photoUrl,presence,savedAt,…}], count}` | Keyed by host slug (handover also mentions per-reel hearts: not supported). Heart on a reel = favourite its host. Needs flag flipped. | 9 |
| `POST /api/hf/invites/:handle/vote`, admin ranking | **NO** | new `hfInvitesEnabled` (declared 1B) | spec: one vote per (handle, uid) | New table `hf_invite_votes`, route, admin list. | 9 |

### 1.3 Presence and calls (HF-WIRE-5 / 7)

| Route | Exists? | Flag | Response shape | Gap / what to add | Stage |
|---|---|---|---|---|---|
| `GET/PUT /api/hosts/me/presence {online}` | YES `routes/hf_calls.ts:953` (`presenceRoute` ~594) | `hfCallsEnabled` | `{ok, presence:'online'\|'busy'\|'offline'[, nudgesPaused]}` | Handover names `PUT /api/hf/presence`; real path is `/api/hosts/me/presence` (use it). `busy` already exists (`presence_call_id`). Presence must also drive the feed (WIRE-4 query). Beat: `POST …/presence/beat` (:954). | 5 |
| Notify me (busy/offline host) | YES `lib/hf_reviews.ts` router → `hfNotifyRoute` (`lib/hf_notify`) , table `hf_notify` | `hfCallsEnabled` | not re-verified in this audit | Confirm route path/shape in WIRE-5 before wiring the button. | 5 |
| `GET /api/hf/wallet/estimate?host=` | YES `hf_calls.ts:952` (`walletEstimate` ~546) | `hfCallsEnabled` | cost for this caller in tokens or rupees; 404 not_found | Handover says `/api/hf/calls/estimate`; real path is `/api/hf/wallet/estimate`. | 7 |
| `POST /api/hf/calls {hostSlug, lane?}` (start) | YES `hf_calls.ts:943` | `hfCallsEnabled` + Vobiz secrets + `HF_CALL_DID` (503 `calls_not_ready` if missing) | `{ok, callId, status:'ringing_host', rate, maxMinutes}` | Handover says `POST /api/hf/calls/start`; real is `POST /api/hf/calls`. Errors `low_balance` 402 carry `needed`,`balance`. | 7 |
| `GET /api/hf/calls/:id` (status) | YES `hf_calls.ts:946` | `hfCallsEnabled` | `{id,status,hostSlug,hostName,rate,connectedAt,endedAt,billedMinutes,chargedRupees,endReason,canReview}` | Poll only (no SSE). Live cost while on call is derived client-side from `connectedAt` + rate. | 7 |
| `POST /api/hf/calls/:id/cancel` | YES `hf_calls.ts:948` | `hfCallsEnabled` | only before connect | `POST …/:id/end` (:950) exists for hangup after connect. | 7 |
| Reviews `POST /api/hf/calls/:id/review` | YES `lib/hf_reviews.ts:141-145` | `hfCallsEnabled` | `{ok}`; body `{stars 1-5, text?, topic?}`; starts `pending` | Within 7 days of a completed call. | 7 |
| Call history `GET /api/hf/calls?role=caller\|host&status=&cursor=&limit=` | YES `hf_calls.ts:944` | `hfCallsEnabled` | `{ok, items:[{id,status,otherHandle,hostSlug,at,seconds,amountPaise,endReason}], nextCursor}` | Rating per row not in list shape. | 7 |
| Host calls `GET /api/hosts/me/calls` | YES `hf_calls.ts:956` | `hfCallsEnabled` | `{ok, calls[], today:{calls,minutes,earningRupees}}` | Covers influencer Home "Today" tiles; handover's `/api/hf/hosts/me/summary` does not exist. | 5/7 |
| Block `POST /api/hf/calls/:id/block`, `GET/DELETE /api/hf/blocks` | YES `hf_dash_v3.ts` | none | `{ok}` | None. | 7 |

### 1.4 Bookings and availability (HF-WIRE-8) — whole router gated by `hfBookingsEnabled` (404 when off, `index.ts:1142-1145`) and booking money also needs `hfCallsEnabled` + Vobiz config (`hf_bookings.ts:261, :397, :641`)

| Route | Exists? | Flag | Response shape | Gap / what to add | Stage |
|---|---|---|---|---|---|
| `GET /api/hf/hosts/:slug/availability` (public slots) | YES `hf_bookings.ts:726` (`publicAvailability`) | `hfBookingsEnabled` | slot list from the host's schedule | Handover's `/hosts/:slug/slots?from=&to=` is this route (check its query params in WIRE-8). | 8 |
| `GET/PUT /api/hosts/me/availability` | YES `hf_bookings.ts:722` (`scheduleRoute`) | `hfBookingsEnabled` | schedule: timezone, durations, slot interval, buffer, notice, horizon, weekly `rules_json`, `exceptions_json` (table `hf_availability_schedules`) | Model is rule + exception based, not the demo's day→slots map. Mapping layer needed ("copy to every weekday", close a date = an exception). | 8 |
| Rate `PUT /api/hosts/me/rate` | **NO dedicated route**. Rate lives in `PUT /api/hosts/me {pricePerMin}` (`routes/hf_hosts.ts:146-149`, host profile put at :384) | `hostOnboardingEnabled` | validated against PRICE_MIN/MAX (creator categories use another range); **ignored when `hfStdPlanEnabled`** (one rate card for everyone) | Decide with the owner: if Standard plan is on, hosts cannot set a rate and the Availability "YOUR RATE" control must go. Otherwise add a thin `PUT /api/hosts/me/rate`. | 8 |
| `POST /api/hf/bookings/quote` | YES `hf_bookings.ts:731` | `hfBookingsEnabled` | quote with expiry (`hf_booking_quotes`) | Handover's single `POST /api/hf/bookings {hostSlug,startAt}` is a two-step here: quote, then confirm. | 8 |
| `POST /api/hf/bookings` (confirm) / `GET /api/hf/bookings?role=host\|customer&from=&to=&cursor=` | YES `hf_bookings.ts:735` | `hfBookingsEnabled` | booking public shape; list requires `role` = `host` or `customer` (400 `invalid_role` otherwise; handover says `fan`) | Use `customer`. | 8 |
| `GET /api/hf/bookings/:id`, `POST …/:id/cancel`, `POST …/:id/start` | YES `hf_bookings.ts:746` | `hfBookingsEnabled` | detail / cancel / start | Handover says `DELETE /api/hf/bookings/:id`; real is `POST …/cancel`. Cancellation cut-off rule is an open owner question (6). | 8 |
| `GET /api/hf/bookings/summary`, `GET /api/hosts/me/bookings/summary` | YES `hf_bookings.ts:742` | `hfBookingsEnabled` | next booking + `expectedHostNetPaise` | Good for influencer Home. | 8 |
| Reminders / auto-start cron | YES `lib/hf_booking_reminders.ts`, `lib/hf_booking_store.ts` (`runHfBookingsCron`), `index.ts:514-516, :620` | `hfBookingRemindersEnabled` (default on), `hfBookingsEnabled` | WhatsApp 1 h / 10 min | None. | 8 |

### 1.5 Wallet, top-up, payouts (HF-WIRE-6 / 10)

| Route | Exists? | Flag | Response shape | Gap / what to add | Stage |
|---|---|---|---|---|---|
| `GET /api/hf/wallet` (balance + ledger) | YES `hf_calls.ts:951` (`walletGet` ~344; token/standard variants `walletGetTokens` ~406, `walletGetStandard` ~460) | `hfCallsEnabled` | old mode `{paidBalance, testBalance, spendable, host?, history[≤50]}` rupees; token modes use tokens/paise breakdown | **Three response shapes by mode** (rupee WalletDO, token lots, Standard plan). App must read `tokensMode` from `/api/hf/me`/config. History is capped at 50 with no cursor. `/me.walletPaise` is the cheap one-number version. | 6 |
| Top-up create `POST /api/hf/wallet/topup {amount}` | YES `routes/hf_topup.ts:158` | `hfTopupEnabled` + `hfTopupGateway` (=`cashfree`) | `{ok, topupId, gateway, client_payload, testMode, amountRupees}`; 503 `topup_unavailable` when off | Handover says `/api/hf/topup/create {amountPaise}`; real body is `amount` in whole rupees. Checkout opens only on the whitelisted domain (avatok.ai) — see CLAUDE.md Cashfree notes. GST maths: `lib/hf_token_config.ts` (`gstBps`, 1800). | 6 |
| Top-up status `GET /api/hf/wallet/topup/:id` | YES `hf_topup.ts:161` | `hfTopupEnabled` | `{ok,id,status,credited,amountRupees}`; re-asks gateway while `created` | Id format `hftop_<24 hex>`. | 6 |
| Top-up webhook `POST /api/hf/wallet/topup/webhook/:gateway` | YES `hf_topup.ts:159` | `hfTopupEnabled` | signature verified, credits once | Receipts: `routes/hf_wallet_limits.ts` (`/api/hf/wallet/receipts`). | 6 |
| Play Billing tokens `GET /api/hf/tokens/products`, `POST …/play/prepare|verify` | YES `routes/hf_tokens_play.ts` | `hfTokensEnabled` + `hfCheckoutProvider=google_play` | — | Handover §5.4/Q10: confirm Cashfree vs Play for the app; both exist. | 6 |
| Payout summary/request `GET/POST /api/hosts/me/payouts` | YES `routes/hf_payouts.ts:328-329` (cancel :330) | `hfPayoutsEnabled` (declared, default off), **plus** `hf_payout` KYC/bank rows | `{enabled, minRupees, maxPerWeek, hostStatus, kycOk, bankOk, bank, withdrawable, held, testEarnings, requests[]}`; POST needs `Idempotency-Key` header and body `{amount}` rupees | Handover's `/api/hf/payouts/summary` + `{amountPaise}` differ from reality. It requires `kyc_required` + `bank_required` before a request (409) — conflicts with the owner's "UPI only, KYC at first payout" idea; owner Q5. UPI verify: `POST /api/hosts/payout/verify` (`hf_host_kyc.ts:693`). Admin UTR flow exists (`/api/admin/hf/payouts/:id/paid`). | 10 |

## 2. D1 tables

### 2.1 Exist today (migrations in `worker/migrations/`)
- **Account/auth:** `hf_phone_signup`, `hf_age_confirm` (`2026-10-10-hf-auth-wa.sql`), `hf_user_ack`, `hf_user_registration`, `hf_registration_progress`, `hf_registration_policy_acceptances`, `hf_user_profile`, `hf_user_prefs` (+`appt_reminders` ALTER), `hf_support_tickets`, `hf_push_tokens`, plus shared `users`, `contact_verification`, `phone_otp`.
- **Hosts:** `hf_hosts` (has `presence`, `presence_at`, `presence_call_id`, `nudge_paused`; **no `is_demo`**, no `followers`), `hf_avatars`, `hf_host_media`, `hf_media_jobs`, `hf_kyc`, `hf_selfie`, `hf_payout`, `hf_kyc_otp`, `hf_lane_access`.
- **Calls:** `hf_calls`, `hf_blocks`, `hf_incidents`, `hf_reviews`, `hf_review_tokens`, `hf_notify`, `hf_vobiz_*` (legs, balance, recharges, alerts, reports, state).
- **Money:** `hf_credits`, `hf_credit_ledger`, `hf_host_test_earnings`, token ledger (`hf_pricing_versions`, `hf_token_products`, `hf_token_lots`, `hf_token_ledger`, `hf_play_purchases`, `hf_token_debts`, `hf_host_ledger`, `hf_play_accounts`), `hf_topups`, `hf_receipts`, `hf_doc_counters`, `hf_spend_limits`, `hf_refund_requests`, `hf_exit_requests`, `hf_payout_requests`.
- **Bookings:** `hf_availability_schedules`, `hf_booking_quotes`, `hf_bookings`, `hf_booking_events`, `hf_booking_occupancy`, `hf_booking_schedule_locks`.
- **Favourites:** `hf_favourites(uid, host_uid, created_at)` — in `migrations/hf_favourites.sql` (no date prefix; confirm it is applied in prod before flipping `hfFavouritesEnabled`).
- Wallet balance itself is not a D1 table: rupee mode lives in `WalletDO` (`walletOp` in `routes/wallet.ts:206`); token mode in `hf_token_lots`.

### 2.2 Still needed (handover §5.2)
| New table | Why | Notes |
|---|---|---|
| `hf_channels` | Channels onboarding, follower check | CREATE in its own migration file (the `d1_apply_alters.py` trap). |
| `hf_reels` | Feed, profile videos | Needs `is_demo`, `face_check`, `visible`. |
| `hf_invite_votes` | Invite votes | Unique `(handle, uid)`. |
| `is_demo` column on `hf_hosts` | Hide/delete demo influencers with one switch | ALTER migration, separate file from CREATEs. |
| (maybe) `reel_alerts` column on `hf_user_prefs` | third WhatsApp switch | ALTER. |
| Not needed (already exist, different names) | `hf_availability` → `hf_availability_schedules`; `hf_bookings` exists; `hf_payout_requests` exists; `hf_favourites` exists. | Do not create duplicates. |

Every new table must be added to `hfPurgeTables` in `worker/src/lib/hf_purge.ts:72` (account deletion). Existing HF tables there include `hf_favourites` (:92) and `hf_user_prefs` (:94).

## 3. Flags (declared in HF-WIRE-1B, `worker/src/routes/config.ts`)

| Flag | Default | Public in `/api/config`? | Notes |
|---|---|---|---|
| `hfReelsEnabled` | false | yes | gates future `/api/hf/reels*` |
| `hfChannelsEnabled` | false | yes | gates future `/api/hf/channels*` |
| `hfInvitesEnabled` | false | yes | gates future invite votes |
| `hfDemoInfluencersVisible` | **true** | yes | one switch for `is_demo` hosts/reels |
| `hfInfluencerMinFollowers` | 10 | yes | NUMERIC (in `numericKeys`), 0–100,000,000 |
| `hfFavouritesEnabled` | false | yes | already existed |
| `hfPayoutsEnabled` | false | yes | already existed |
| `hfBookingsEnabled`, `hfTopupEnabled`, `hfCallsEnabled` | false | yes (`hfTopupEnabled` is replaced by a derived `hfTopup{}` block) | already existed |
| `hfAppLatestBuild`, `hfAppMinBuild` | 0 | yes | already existed; owner bumps per release |

## 4. Top gaps by stage
- **WIRE-1/2 (foundations, sign-up):** `/api/hf/me` shape (done now). Fan sign-up has no route that stores a fan-entered email (WhatsApp OTP path is phone-only). `PATCH /me/prefs` missing (PUT exists).
- **WIRE-3 (channels/treg):** nothing exists: table, routes, treg client, `TREG_API_KEY`, approval state (`pending_check`/`approved`) on `hf_hosts`. Open: ownership proof method, 10 vs 10,000 followers.
- **WIRE-4 (reels/jev):** no `hf_reels`, no feed route, no online count, no `is_demo`. Profile needs reels + followers fields. jev client and `JEV_API_KEY` absent.
- **WIRE-5 (presence):** route exists but at `/api/hosts/me/presence` (not `/api/hf/presence`) and gated by `hfCallsEnabled`; feed must filter on it. Influencer "summary" endpoint missing (use `/api/hosts/me/calls` `today` + bookings summary).
- **WIRE-6 (wallet/top-up):** routes exist behind `hfTopupEnabled`; mismatches with handover: `amount` is whole rupees, path is `/api/hf/wallet/topup`. Wallet read has three shapes by mode (rupee/tokens/Standard). Cashfree vs Play Billing still undecided (Q10). Checkout host is avatok.ai only.
- **WIRE-7 (calls):** complete but needs `hfCallsEnabled`, `HF_CALL_DID` and Vobiz secrets. Paths differ from handover (`POST /api/hf/calls`, `/api/hf/wallet/estimate`, `/api/hf/calls/:id/end`).
- **WIRE-8 (bookings):** full router exists but is rule/exception based with a quote-then-confirm flow and `role=customer`; the app's day→slot map needs an adapter. No standalone rate route; with `hfStdPlanEnabled` hosts cannot set a rate at all.
- **WIRE-9 (search/invites/favourites):** favourites exists (by host slug, flag off). `/api/hf/search` and invite votes do not exist.
- **WIRE-10 (payouts):** exists, but requires KYC + bank before any request, request body in rupees with an idempotency header; conflicts with the owner's lighter flow (Q5). Flag off.
- **WIRE-11 (settings):** delete-account is `/api/hf/account/exit`; email/WhatsApp change by OTP has no route.
