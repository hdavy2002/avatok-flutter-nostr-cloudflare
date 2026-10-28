# TELEMETRY CATALOG — what every surface must emit to PostHog

Owner decision 2026-09-02: **PostHog is a default part of coding and planning
on every surface** — website, Android, iOS, macOS, Windows, Linux desktop, the
Worker, the consumers, and anything added later. A feature with no telemetry
line in its spec is not done. New events are added to THIS file first, then
coded. Project 139917 (EU), key `phc_hmYMsHQEYjQU4bYXNdqA4VZVsfHEIkBQdQL0Kv7FIc5`,
host `https://eu.i.posthog.com`.

Why this exists: the website ran with zero PostHog until 2026-09-02. A photo
upload failed on a creator's phone and there was nothing to pull.

---

## 1. The contract — identical on every surface

### 1.1 Super properties on EVERY event

| prop | value | note |
|---|---|---|
| `platform` | `web` · `android` · `ios` · `macos` · `windows` · `linux` · `worker` · `android-app` | `android-app` = the Hello Fraands app, both the old Capacitor shell (web events in app mode) and the native Flutter app (`hf-flutter/`, `[HF-NATIVE-1]`). |
| `service_name` | `avatok-web` · `avatok-app` · `avatok-desktop` · `avatok-api` · `hf-app` | `hf-app` = the native Hello Fraands app (`hf-flutter/`). Its `app` super prop is the brand slug. |
| `release` | git SHA of the build | filter any issue by deploy |
| `app` | product area: `avaexplore` · `avatok` · `avaconsult` · `admin` · `site` | matches the Worker's `app_name` |
| `email` / `phone` | when known | **the retrieval key** — support pulls by email |
| `clerk_uid` | Clerk user id | joins client and server timelines |
| `account_id` / `account_kind` | active account on shared devices | app only today |
| `trace_id` | when an action is in flight | correlates client ↔ server ↔ logs |
| `screen` (app) / `$current_url` (web) | | |
| `viewport` / `device_class` | `phone` · `tablet` · `desktop` | web: derived from width |

### 1.2 Products enabled on every client surface

Error tracking (uncaught + `captureException`), session replay (masked text and
images, sample 20%, 100% on error), pageviews/screens, web vitals (web), logs
sink for warn/error lines, LLM analytics where an LLM is called.

**Web, since [WEB-PERF-3] 2026-09-30:** replay sampling is rolled in the browser
(`REPLAY_SAMPLE = 0.2` in `web/src/lib/analyticsCore.ts`, once per browser
session) so the recorder script downloads only for sampled visitors. An
unsampled visitor who hits a reported `captureException` starts recording from
that moment (the seconds before the error are not captured). Surveys are
disabled on the web (`disable_surveys: true`) because the project has none —
re-enable there before launching a web survey.

### 1.3 Person identity

`identify(clerk_uid, {email, phone, handle, kyc_verified, account_kind})` at
sign-in; `alias` the pre-login anonymous id; `reset()` at sign-out. Persist the
last known email per uid so errors after a lapsed session still carry it (the
app already does this — `analytics.dart` `_persistEmail`).

### 1.4 Naming

`snake_case`, `<area>_<object>_<verb|outcome>`. Every event that can fail
carries `outcome: ok|refused|error`, `reason`, `status` (HTTP), and `ms`
(latency) so rule 3 of the ship gate ("assert the success value") is possible.
Never a new bespoke `*_ms` event — use `ui_interaction` with `name` + `ms`.

### 1.5 What is NEVER sent

Passwords, tokens, raw card/UPI ids, real phone numbers of *other* users,
message bodies, private-media URLs, DOB. Scrub with the surface's `_scrub` /
`scrubServer` / `beforeSend` hook.

---

## 2. Website (`web/`) — the catalog

Wiring: `web/src/lib/analytics.ts` exports `initAnalytics`, `identify`,
`reset`, `capture`, `captureException`, `uiInteraction`, `withTrace`. Loaded
from `Base.astro` **and** the landing page's own document (it never touches
Base). Islands import the module; nothing calls `window.posthog` directly.

### 2.1 Automatic

| event | source |
|---|---|
| `$pageview` / `$pageleave` | autocapture, with `app` derived from the path (`/dashboard/*`→`avaexplore`, `/admin/*`→`admin`, `/l/ /e/ /live/ /marketplace`→`avaexplore`, else `site`) |
| `$exception` | `window.onerror`, `unhandledrejection`, React error boundary around every island root |
| `$web_vitals` | LCP / CLS / INP / FCP |
| `$rageclick`, `$dead_click` | autocapture |
| session replay | masked; `$session_id` on every event |

### 2.2 Auth (`islands/auth`, `lib/clerk.tsx`)

`auth_signin_start` {method} · `auth_signin_result` {method, outcome, reason, ms} ·
`auth_signup_result` · `auth_signout` · `auth_session_lost` {endpoint, status} ·
`auth_token_null` {where} (a request was about to go out with no token — the
upload bug) · `auth_guest_token_issued`.

### 2.3 Marketplace + cards (`islands/marketplace`, `ListingTile`)

`market_browse_loaded` {section, count, ms, cursor} · `market_browse_error`
{status, reason} · `market_filter_change` {key, value} · `market_search`
{q_len, results, ms} · `market_sort_change` · `market_card_impression`
{listing_id, kind, position, section} (batched, IntersectionObserver) ·
`market_card_click` {listing_id, kind, position, cta: details|book|calendar} ·
`market_favorite_toggle` {listing_id, on} · `market_live_rail_loaded` {count}.

**`[MKT-V2-1 2026-09-27]` The new `/marketplace`** (`islands/marketplace/MarketplaceV2.tsx`)
replaced the bazaar grid (`ExploreGrid`/`FilterRail`/`LiveNowRail` — deleted), so the
`market_*` events above are no longer emitted by `/marketplace`. It emits:
`marketplace_loaded` {count, live_count, ms, from_snapshot, q, type} — once per page load, after
`/api/explore` (≤3×30) + `/api/explore/live-now` (`from_snapshot` = the grid was already painted
from the localStorage snapshot, [MKT-SPEED-1]) · `cache_event` {store: marketplace_cards,
result: hit|stale|miss, count?, render_ms?} — once per load, before the fetch · `marketplace_search` {q, source:
url|hero|deity|festival|temple, type?, when?} · `marketplace_filter` {key: q|intention|when|
price|sort|prasad|priv|clear|show_more, value} · `marketplace_tab` {type: all|havan|puja|
satsang|sermon|meditation|festival|gathering, source?: toolbar|rail_see_all|festival_panel} ·
`marketplace_card_click` {action: art|title|book|benefits|reviews|remind|whatsapp|tooltip|
join_live, listing_id, position, rail: havans|pujas|gatherings|grid|live}. Load failures go
through `captureException` {surface: 'marketplace', endpoint}. The homepage "Book now"
shelf keeps `home_booknow_loaded` / `home_booknow_click` (same shared `BookCard`).

### 2.4 Listing details (`ListingDetailView`, `/l /e /watch /live /c`)

`listing_view` {listing_id, kind, free_entry, status, seats_left, has_video,
section_count} · `listing_section_view` {section} (how-it-works, rules,
reviews, faq…) · `listing_cta_click` {cta: book|reserve_free|talk|share|
whatsapp|copy|qr|ask_host} · `listing_gallery_open` · `listing_video_play` ·
`listing_share` {channel} · `listing_review_helpful` · `listing_question_ask`
{outcome, status} · `listing_render_error` {listing_id, reason} · `creator_view`
{creator_id, has_stats, badges}.

### 2.5 Checkout (`islands/checkout`)

`checkout_open` {listing_id, kind, price, free_entry, from} ·
`checkout_slot_pick` {slot_id, ms_to_pick} · `checkout_gateway_pick` {gateway} ·
`checkout_submit` {gateway, amount_paise, free} · `checkout_result` {outcome,
status, reason, gateway, ms, entitlement_id?} — **this is the ship-gate success
value** · `checkout_return` {gateway, outcome} (PayReturn) ·
`checkout_free_refused` {reason: full|disabled} · `checkout_abandon` {step,
ms_on_step} (pageleave while open).

### 2.6 Live + consult players (`islands/live-gs`, `consult-gs`, `live`, `consult`)

`live_join_attempt` {listing_id, session_id, has_ticket} · `live_join_result`
{outcome, reason, status, ms} · `live_player_state` {state: connecting|playing|
stalled|ended, ms} · `live_stall` {ms, count} · `live_leave` {watched_s} ·
`live_refusal_shown` {reason} · `consult_prejoin` {booking_id, outcome} ·
`consult_join_result` · `consult_extension_quote` / `_confirm` {outcome} ·
`consult_end` {billed_min} · `gs_sdk_error` {code, message} (GetStream client
errors, also as `$exception`).

### 2.7 Creator dashboard (`islands/dashboard`)

`listing_create_start` {kind} · `listing_step_view` {step} ·
`listing_step_complete` {step, ms} · `listing_field_error` {field, reason} ·
`listing_save` {outcome, status, fields} · `listing_cover_upload` {outcome,
status, reason, size, type, ms} — the 2026-09-02 bug · `listing_publish`
{outcome, status, reason, kind, price, free_entry} · `listing_repeat` {weeks,
outcome} · `listing_cancel` · `listing_status_change` {to} ·
`dashboard_panel_view` {panel} · `dashboard_api_error` {endpoint, status} ·
`agent_create/edit` {outcome} · `wallet_view` · `payout_request` {outcome}.

### 2.8 Money on the web (`wallet`, `billing`, `PayStep`)

`topup_open` {tokens} · `topup_quote` {currency, amount_paise} ·
`topup_submit` {gateway} · `topup_result` {outcome, status, reason, ms} ·
`payout_view` · `receipt_view` {order_id}.

### 2.9 Site / marketing (`islands/site`, legal pages)

`waitlist_submit` {outcome} · `cta_click` {name, location} · `legal_page_view`
{page} · `beta_banner_dismiss` · `nav_click` {item}.

[WEB-HELP-1 2026-09-11] Help centre search (`components/HelpSearch.astro`):
`help_search` {q_len, result_count, zero_result} — fires 600ms after the
query settles, never the raw query text · `help_search_select` {rank} — on
navigating to a result. Index-load failures go through the shared
`captureException` with `{surface: 'help_search'}`, not a bespoke event.

### 2.10 Admin (`islands/admin`)

`admin_action` {action, target, outcome} for every write (adjust, refund,
flag flip, suspend). Email of the admin is on the super props already.

### 2.11 Web-only health

`ui_interaction` {name, ms} for every fetch-then-render path ·
`api_error` {endpoint, method, status, reason, ms} from the shared `request()`
helper (one place, covers everything) · `cache_event` {store, result} ·
`island_hydrate_error` {island, message} · `island_visible_never` {island}
(the marketplace grid hydrating on-visible: fire if not hydrated 10 s after
scroll-into-view).

**[WEB-PERF-1 2026-09-30] Load-later telemetry.** PostHog now starts after the
window `load` event plus an idle slot (8 s ceiling), not two frames after the
script runs — owner decision that every non-critical thing loads later, in the
background, on public and signed-in pages alike. Nothing is dropped: calls
queue in `lib/analytics.ts`, and uncaught errors before the SDK is up are
buffered as `$exception` with `source` = `early_window_error` /
`early_unhandled_rejection`.

| Event | Props | Meaning |
|---|---|---|
| `web_page_speed` | `path`, `fcp_ms`, `lcp_ms`, `ttfb_ms`, `dom_ready_ms`, `load_ms`, `telemetry_start_ms`, `transfer_kb`, `effective_type` | One per page load, sent once the SDK is up. **The success value** for WEB-PERF-1: median `lcp_ms` on `path='/'` for `effective_type='4g'` should fall versus the week before 2026-09-30. `telemetry_start_ms` shows how long telemetry was held back (expect ~load + idle, never above ~8000). |

---

## 3. Android / iOS app (`app/`) — already wired; keep the contract

`analytics.dart` already emits the super props, `$exception`, replay, logs,
`ui_frame_stats`, `ui_content_flash`, `ui_interaction`, `cache_event`, call
telemetry (`call_*`), `auth_session_lost`, `apps_unavailable`. Gaps to close:
listing form events mirroring §2.7 with the same names; `listing_view` /
`checkout_result` / `live_join_result` mirroring §2.4–2.6 so one dashboard
serves both surfaces; **pending** `flutter pub get` to posthog_flutter 5.x
(Logs, replay, native crash capture only activate after that).

### 3.1 Listing details in a WebView (`LIST-DETAIL-EMBED-1`, 2026-09-09)

The app's listing details screen is the website's `/l/<id>` inside a WebView
(`app/lib/features/marketplace/listing_web_detail.dart`), so the funnel now
crosses a surface boundary mid-journey: the tap is an APP event and the booking
that follows is a WEB event (§2.4–2.5). Both halves carry `listing_id`, which is
what lets one dashboard read the whole path; without it a drop-off between the
tap and the checkout is invisible on both surfaces.

| Event | Props | Why it exists |
|---|---|---|
| `listing_web_detail_opened` | `listing_id`, `source` | The tap. `source` is the entry point (explore, search, browse, my listings, creator channel, avalive, deep link, push), so a drop-off is attributable to a place and not to "the page". |
| `listing_web_detail_ready` | `listing_id`, `source`, `bridge_ms` | **The success value.** Fires only on the page's own bridge handshake, so it proves the WebView loaded avatok.ai and not a captive portal or a cached error page served 200. `bridge_ms` is time-to-usable on Indian mobile data — the number that says whether the swap was worth it. |
| `listing_web_detail_token` | `listing_id`, `source`, `outcome`, `ms` | Auth crossing the bridge. `no_session` = `ApiAuth.clerkBearer` returned null; `error` = it threw. A run of these means the buyer is anonymous on their own listing and will be asked for an email code at checkout. |
| `listing_web_detail_bridge_missing` | `listing_id`, `source` | 20s with no handshake. Reported, never shown — the page is public and readable without the bridge. |
| `listing_web_detail_error` | `listing_id`, `source`, `code`, `description` | Main-frame load failure only. Sub-resource failures are not the page failing. |
| `listing_web_detail_nav_blocked` | `listing_id`, `url` | A link out to a host the buying journey does not need. A run of one URL is a link on the page that a buyer wants and cannot follow. |
| `listing_web_detail_ua_failed`, `listing_web_detail_page_log`, `listing_web_detail_shared`, `listing_web_detail_closed` | see the emit sites | `ua_failed` means the page rendered WITH the website's header — usable, obviously a web page. |

Web-side pair: because chrome removal is keyed to the app's UA marker, every
`web/` event fired inside the app carries the ordinary web super props with
`platform: web`. To tell an in-app view from a browser view on the web side,
read the UA marker — do NOT add a second `platform` value, which would split
every existing web dashboard.

### 3.2 Marketplace first paint (`UI-MKT-NOSKEL-1`, 2026-09-12)

The browse grid no longer paints loading skeletons — six grey card placeholders
and the shelf's three poster-sized ones were removed (owner, 2026-09-12) because
on a marketplace that is often genuinely empty they read as real listings that
then vanished. Removing them removes the only on-screen evidence that the app is
still working, so the wait has to be measured instead of watched.

| Event | Props | Why it exists |
|---|---|---|
| `mkt_first_content` | `result`, `blank_ms`, `warm_cache`, `country`, `searched` | **The success value for removing the skeletons.** Fires once per mount, the first time the grid resolves. `result` is `cards` \| `empty` \| `error` — `empty` is a pass, not a failure: it is the honest outcome the six grey cards used to disguise. `blank_ms` is how long the user looked at nothing, and is the number to argue with if anyone wants the placeholder back. `warm_cache` pairs it with `marketplace_opened` ([MKT-CACHE-1]): a warm mount must report ~0ms with `cards`, so a run of warm mounts with a high `blank_ms` means the in-memory peek has regressed. The event NOT appearing on a build is itself the signal — it means the grid never reached `ConnectionState.done`, which with no skeleton on screen is indistinguishable by eye from a fast empty result. |

## 4. Desktop apps (macOS / Windows / Linux)

Same Flutter `Analytics` class, `platform` from `Platform.operatingSystem`,
`service_name: avatok-desktop`. Add `desktop_window_state`, `desktop_update_check`
{outcome}, `desktop_launch` {cold_ms}. No new bespoke events beyond that; the
product events are identical to the phone.

## 5. Worker + consumers

`hooks.track(env, uid, event, app_name, props)` — 5 args, always. Uncaught
route/queue errors → `$exception` via `hooks.trackException`. `$ai_generation`
at every LLM completion site. Money paths emit `*_result` with `outcome`.
Free lane: `free_session_hold`, `free_session_join_refused`,
`free_session_settled`, `free_session_settle_conflict` (shipped 2026-09-02).

### 5.1 Listing poster generation + moderation (`MKT-POSTER-*`, `worker/`)

`listing_poster_generate` {listing_id, creator_id, auto (bool), attempt (int),
outcome: draft|failed, duration_ms, error_kind} — emitted from
`submitListingForApproval` (`routes/listings.ts`, `auto: true`, gated by
`posterAutoGenerateOnSubmit` / capped by `posterAutoGenerateMaxAttempts`) and
from the admin generate/regenerate action (`routes/admin_listings.ts`,
`auto: false`). This is the **ship-gate success value** for
`MKT-POSTER-AUTO-1` — success is `auto=true` **and** `outcome="draft"`, not
merely the event's presence.

`listing_moderation_action` {listing_id, action, previous_status, next_status,
poster_status, admin_id, creator_id, reason_present (bool)} — emitted on every
admin moderation write (approve, reject, regenerate_poster, …).
`reason_present` is a boolean flag only; **never send the reason text itself**
— it is creator-facing free text and may contain anything the admin typed.

`admin_listing_detail_view` {listing_id, status, poster_status, admin_id} —
emitted by the admin full-detail endpoint (`routes/admin_listings.ts`) and is
the success value for `MKT-ADMIN-DETAIL-1` / `MKT-ADMIN-UI-1` (the review UI
is what calls the endpoint).

None of the three events above carry raw error text, exception messages, or
the rejection reason body — `error_kind` is a short enum/category, not a
message string, per §1.5.

---

## 6. Dashboards and alerts to create once web events flow

- **Web Health**: `$exception` by release, `api_error` by endpoint, web vitals,
  `island_hydrate_error`, `listing_cover_upload` outcome split.
- **Funnel**: `market_card_click` → `listing_view` → `checkout_open` →
  `checkout_result ok` → `live_join_result ok`, per `kind` and `free_entry`.
- **Creator funnel**: `listing_create_start` → each `listing_step_complete` →
  `listing_publish ok` — the drop-off step is the form step to fix next.
- Alerts (need a Slack/webhook destination first): `checkout_result error` > 3
  in 10 min; `$exception` new issue on latest release; `api_error` 5xx spike.

## 7. Rule for planners and reviewers

Every spec gets a **Telemetry** section listing: the events (from this file or
added here), the success value per the ship gate, and which dashboard shows it.
A PR that adds a fetch, a form, a player, or a money step without the matching
event is sent back.

## WP5 [LIVE-GRACE-WEB-1] — live host/viewer grace-period web events

Surfaces: `web/src/islands/live-gs/LiveGsHost.tsx`, `LiveGsViewer.tsx`,
`LiveStage.tsx`. All four carry the shared super-property contract (§1.1) via
`web/src/lib/analytics.ts`'s `capture()` — `email` is registered once at
sign-in (`identify()`) and does not need to be repeated per-call.

`live_host_authz_refused` {listing_id, reason: 'not_found'|'not_creator'|'error',
status} — emitted by `LiveGsHost.tsx`'s `authorize()` when the pre-media
`GET .../live/:id/state` check fails, BEFORE `getUserMedia` is ever requested.
`reason` distinguishes a 404 (listing/event does not exist — "Event not
found") from a 403 (signed-in user is not the event's creator — "Not your
event") from any other transport/server failure.

`live_reconnecting_shown` {listing_id, surface: 'host'|'viewer'} — fired once
per reconnect episode, the moment either side learns (via the `/state` poll)
that `state:'reconnecting'` is in effect. Host: shown when opening the host
page lands on "Rejoin your live" instead of the normal preview. Viewer: shown
when the "Creator reconnecting · mm:ss" overlay first appears over the live
stage. De-duplicated per episode (resets when the state moves off
`reconnecting`), so a still-reconnecting session does not re-fire on every
3s poll tick.

`live_host_rejoin` {listing_id} — fired when the creator taps "Rejoin your
live" on the host page's reconnecting screen, immediately before the normal
prepare-host/getUserMedia/join flow re-runs against the same server-issued
call id (the client never mints a new one).

`live_no_return_shown` {listing_id} — fired once for a ticket holder when the
live state poll reports `state:'ended'` with `outcome:'host_no_return'`
(server contract, WP8) — the moment the "The creator couldn't return — the
unused part of your ticket is being refunded" card is shown in place of the
generic ended card. Success value for this WP's viewer-side refund
messaging: this event firing with a non-empty `listing_id` on a session that
actually ended with `host_no_return`.

Contract note: `reconnecting`/`reconnect_deadline_ms`/`outcome` on
`GET /api/commercial/live/:id/state` land with WP8 (wave 2). Until then these
fields are simply absent and every branch above is inert — coded against the
contract now so no follow-up web change is needed when WP8 ships.

## WP3 [SETTLE-CHECKIN-1] — consult settlement decision telemetry

Surfaces: `worker/src/commercial_settlement.ts`, `worker/src/money_engine.ts`. No new
event NAMES — the existing `commercialEvent(env, "settlement", null, {...})` call sites
(worker-side, scalar-only, redacted per `lib/commercial_telemetry.ts`) now carry the
check-in decision instead of the two-party GetStream-overlap one for `consult_1to1`:

- `commercialEvent(env, "settlement", null, { kind: "consult_1to1", outcome: "settled" })`
  — fires from the existing `finishSettlement()` path whenever
  `consultCheckInDecision()` found the creator checked in (RULEBOOK-PAID-SESSIONS.md §2
  C1). The receipt row it corresponds to now also carries `rule: 'creator_checked_in'`
  and `checked_in_at` (epoch ms) — read those off `commercial_receipts`, not off the
  event, for the audit trail; the event itself stays scalar/aggregate.
- `commercialEvent(env, "settlement", null, { outcome: "refunded", reason:
  "creator_no_show", kind: "consult_1to1" })` — fires from `refundCreatorNoShow()` (main
  settlement path) or `finalizeOverdueNoShow()` (the "never reached 'ended'" sweep) when
  the creator did NOT check in within `sessionCreatorCheckInMin` (C2). Both paths now also
  write an `account_strikes` row (`category: 'marketplace_no_show'`, `source:
  'commercial_settlement'`) — success value for this WP: every `creator_no_show` refund
  event has a matching strike row with the same `commercial_session_id` as evidence_url.

Not telemetry, but worth a dashboard eye: `money_engine.ts`'s delegation guard logs
`console.log('[money_engine] delegation guard: ...')` (worker logs, not PostHog) whenever
a stale Q_MONEY job for a `bookings.kind='consult_1to1'` order reaches the legacy Phase-7
engine — it should be rare-to-never post-cutover; a sustained rate means something is
still enqueueing legacy money jobs for commercial bookings.

## WP1 [SESSION-CLOCK-0] — consult session clock, waiting-room prejoin grant, call rejoin

Surface: `worker/src/routes/commercial_stream_sessions.ts`,
`worker/src/lib/commercial_session_clock.ts`. All emitted via
`commercialEvent(env, event, uid, props)` (`worker/src/lib/commercial_telemetry.ts`),
which stamps `lane: 'commercial'`, `schema_version`, and routes through the shared
`track()`/`metric()` sinks — same super-property contract as every other commercial
event in this catalog.

`commercial_provider_event` {kind: 'consult_1to1', outcome: 'applied',
event_class: 'interval_close_only'} — fired from `recordCommercialStreamEvent` when
a GetStream `session_ended`/`call.ended`/`live_stopped` webhook arrives for a 1:1
consult. Per RULEBOOK-PAID-SESSIONS.md §5 ("the schedule ends a session, never a
provider event"), this path now ONLY closes any open
`commercial_participant_intervals` rows — it never marks `commercial_sessions`
ended and never queues a settlement job. `live_event` webhooks are unaffected and
keep firing the pre-existing `outcome: 'ended'`/settlement-queuing path.

`commercial_session_clock` {kind: 'consult_1to1', outcome: 'ended',
reason: 'schedule_due'} — fired once per session by the new 5-minute cron sweep
`endDueConsultSessions` (`worker/src/lib/commercial_session_clock.ts`, wired into
the existing `scheduled()` handler in `worker/src/index.ts` next to
`reconcileCommercialSessions`) when a `kind='consult_1to1'` session's booking
`ends_at + commercialConsultJoinLateMin` has passed and the session is not already
ended/cancelled. This is the ONLY thing (besides the explicit
`POST /api/commercial/consult/:id/end` route) that ends a consult session. Success
value: this event firing for a session whose `commercial_settlement_jobs` row also
exists (settlement was actually queued, not just the flag flipped).

`commercial_join` {kind, outcome: 'rejoin_recreated_call'} — fired from
`authorizeProviderJoin` when a valid, in-window participant rejoins a session whose
GetStream call the provider reports as ended or missing (404) and the call is
recreated via `createProviderCall` rather than refusing the join. Distinguishes a
genuine rejoin-after-drop from the normal first-join path (which emits no extra
event beyond the existing `commercial_join {outcome:'refused', ...}` refusal
events already in this catalog).

Contract note: `commercialConsultPrejoin`'s response now includes `room_ws`,
`room_token`, `check_in_by` from WP2's `buildWaitingRoomGrant`
(`worker/src/lib/commercial_waiting_room.ts`) per the shared waiting-room contract
in `Specs/PLAN-2026-09-11-WAITING-ROOM-BUILD.md`. As of this WP that lib is a
stub (`// WP2 replaces this`) returning a placeholder `room_ws`/`room_token` and
`check_in_by: startsAt` — no new client-facing telemetry from this change until
WP2 lands the real grant and WP4/WP6 wire the waiting-room UI against it.

## WP4 [WAITROOM-WEB-1] — paid-consult waiting-room web events

Surfaces: `web/src/islands/consult-gs/ConsultRoomGS.tsx`, `WaitingRoom.tsx`,
`RoomSocket.ts`. All carry the shared super-property contract (§1.1) via
`web/src/lib/analytics.ts`'s `capture()`; `email` is ALSO passed explicitly
on every event below (not just relied on as a registered super-property),
because a guest's email can be set after the waiting room has already been
entered.

`waitroom_enter` {booking_id, role: 'creator'|'buyer', email} — fired when
the green room hands off into the waiting room (after PreJoin's device
preflight, before any GetStream participant exists) and again every time a
live call is left and the same booking's waiting room is re-entered
(`RULEBOOK-PAID-SESSIONS.md` §3: "back to waiting on leave, keep the
socket"). Coded against the WP1/WP2 prejoin contract (`room_ws`,
`check_in_by`, `counterparty`) — when those fields are absent (worker not
deployed yet, or the commercial lane's flags are off), the client logs a
`console.warn` and falls back to today's direct-join flow with no waiting
room and none of the events below.

`waitroom_autojoin` {booking_id, role, email} — fired the moment the
waiting-room socket's `roster {host, attendee}` message reports BOTH
present and the client calls the existing commercial `/join` (PLAN
contract: "Auto-join rule (clients): call the existing `/join` when
`roster.host && roster.attendee`"). De-duplicated per waiting-room visit
(`autoJoinFiredRef`) and re-armed on a later re-entry to waiting so a
retried join after a transient failure can fire again.

`waitroom_noshow_shown` {booking_id, role: 'buyer', email} — fired once, for
the customer only, the moment `check_in_by` passes with the socket's roster
still reporting `host: false` — the moment the "X didn't show up — your
payment is being refunded" line renders in the waiting room. Never computed
or asserted independently of the server's `roster`/`check_in_by` fields
(RULEBOOK §5: "Never compute money on the phone or in the browser").

`waitroom_chat_sent` {booking_id, role, email} — fired on every waiting-room
chat message sent over the `RoomSocket` (`type:"chat"`, ≤ 500 chars per the
WP2 contract). Message text itself is never sent to PostHog.

Success value for this WP's ship gate: `waitroom_enter` firing with a
non-empty `room_ws`-backed session (i.e. not the fallback-warned path) is the
signal the waiting room is actually live for a booking; `waitroom_autojoin`
firing before any `consult_join_result` event confirms the auto-join rule
fired ahead of the manual join path it replaces.

## WP7 [LIVE-GRACE-APP-1] — app-side live host-reconnect / viewer grace events

Surfaces: `app/lib/features/commercial_getstream/commercial_live_screens.dart`
(`LiveBroadcastScreen`, `LiveViewerScreen`), `commercial_live_gateway.dart`,
the commercial branch of `app/lib/push/push_service.dart`. All events go
through `Analytics.capture` (shared super-property contract, §1.1) and always
additionally carry `listing_id` and `role` (`'host'`|`'viewer'`).

`live_reconnecting_shown` {listing_id, role, email} — fired once per outage
(de-duplicated until the state clears) the first time a `GET
/api/commercial/live/:id/state` poll reports `state:'reconnecting'`, on
either the host's `LiveBroadcastScreen` or a `LiveViewerScreen`. The host
side also fires an out-of-band state poll the instant the GetStream SDK's
own `CallStatus` reports `isReconnecting`/`isDisconnected`, so this can beat
the normal 3 s poll tick; the event and its payload are unchanged either way
— the server's `state`/`reconnect_deadline_ms` remain the only source of
truth for what is shown (RULEBOOK §5: never compute this client-side).

`live_host_rejoin` {listing_id, role: 'host', email, source:
'in_app_banner'|'push'} — fired when the host asks to rejoin: either
tapping Rejoin on the in-broadcast reconnect banner, or opening the app via
a `commercial_reconnect` push (`push_service.dart`). Both paths land on
`LiveReadinessScreen`, which re-runs `prepareHost` — this event marks the
INTENT to rejoin, not confirmation that the SDK reconnected.

`live_no_return_shown` {listing_id, role: 'viewer', email} — fired once,
viewer-side only, the moment a state poll reports `state:'ended',
outcome:'host_no_return'` and the "The creator couldn't return — the unused
part of your ticket is being refunded" message renders.

Contract note: `reconnect_deadline_ms`, `outcome` and the `'reconnecting'`
value of `state` are WP8 (wave 2, worker `live_grace`) fields — this WP only
consumes them. `CommercialLiveState` parses all three as nullable/optional
so every event and UI path above degrades to "never fires / never shows"
rather than throwing until WP8 ships. `commercial_reconnect` push payloads
are allowlisted the same way as `CommercialNotificationPayload` (refused if
they carry any provider token/call id; require a stable `listing_id`) before
either `push_shown` or the notification tap is honoured.

Success value for this WP's ship gate: once WP8 ships, `live_reconnecting_shown`
appearing on BOTH the host's and a viewer's device for the same `listing_id`
within the same outage window is the signal the grace period is visible to
both sides; `live_host_rejoin` followed by the state poll leaving
`reconnecting` confirms the rejoin actually worked.

## WP2

[WAITROOM-1] WP2 is worker plumbing (`worker/src/lib/commercial_waiting_room.ts`,
`worker/src/do/stream_session.ts`, `worker/src/routes/consult.ts`,
`worker/src/routes/config.ts`) — it has no screen/path of its own, so it emits no
new `Analytics.capture`/`commercialEvent` events. It is the wire layer WP4
(web) and WP6 (app) build their waiting-room telemetry (`waitroom_enter`,
`waitroom_autojoin`, `waitroom_noshow_shown`) on top of:

- `buildWaitingRoomGrant(env, …)` returns `{room_ws, room_token, check_in_by}`
  (`check_in_by = starts_at + sessionCreatorCheckInMin·60000`) and arms the
  session DO (`consult:<bookingId>`) via `sessionOp(..., {op:"schedule", ...,
  commercial:true})`. Clients read `check_in_by` to decide when to show the
  no-show state — never compute it locally from a hardcoded 20.
- The DO's WS now emits `roster {host:boolean, attendee:boolean}` on `welcome`
  and after every `presence` change — this is the exact signal WP4/WP6's
  `waitroom_autojoin` should fire alongside (auto-`/join` when
  `roster.host && roster.attendee`), and `chat {from, text, at}` (≤500 chars)
  for the waiting-room chat surface.
- New flags (`worker/src/routes/config.ts`): `sessionCreatorCheckInMin`
  (default 20) and `liveHostGraceMin` (default 10) — both declared in
  `PlatformConfig`, `DEFAULTS` and `numericKeys` (CLAUDE.md "FAKE flag" rule).
- Commercial bookings (`commercial:true` on `schedule`) make the DO's own
  `money_noshow`/`money_end` alarms a no-op (`session_ended` still fires) —
  WP3's `commercial_settlement.ts` / the WP1 cron are the only money movers
  for these sessions (RULEBOOK-PAID-SESSIONS.md v2 §5). No telemetry implication;
  noted here so a future reader doesn't mistake the silent alarm for a bug.

Success value for this WP: `worker/test/commercial_waiting_room.test.ts` and
`worker/test/stream_session_do_waitroom_contract.test.ts` are the checkable
proxy for "the contract fields WP4/WP6 telemetry depends on actually exist and
have the shape documented above."

## WP6 [WAITROOM-APP-1] — paid-consult waiting-room app events

Surfaces: `app/lib/features/commercial_getstream/commercial_waiting_room_screen.dart`
(new), `commercial_consult_screens.dart` (`CommercialConsultationPrejoinFlow._join`),
`app/lib/core/commercial_waiting_room_api.dart` (new). All go through
`Analytics.capture`, which stamps the shared super-property contract (§1.1) on
every call automatically — `email` is never omitted here, it just isn't
repeated as an explicit property since `Analytics.capture`'s `_base()` already
attaches it.

`waitroom_enter` {booking_id, role: 'creator'|'buyer'} — fired in
`CommercialWaitingRoomScreen.initState`, i.e. once the prejoin flow's `_join`
has fetched a COMPLETE `CommercialWaitingRoomApi.prejoin` grant (`room_ws`,
`room_token`, `starts_at`, `ends_at` all present, `role` matching this
screen's `isCreator`) and pushed the waiting room. `Leave` from the in-call
`CommercialConsultationRoomScreen` pops back to the SAME waiting-room screen
instance (socket kept per RULEBOOK §3) rather than re-creating it, so a
re-entry does not double-fire this event within one visit. When the prejoin
grant is absent or partial (worker not deployed yet, or flags off), `_join`
silently falls back to the pre-WP6 direct-join flow and none of these events
fire — the app never breaks on an old server.

`waitroom_autojoin` {booking_id, role} — fired at the top of `_autoJoin`, the
moment the waiting-room socket's `roster {host, attendee}` event reports BOTH
present (PLAN contract: "call the existing `/join` when `roster.host &&
roster.attendee`"). Guarded by `_joining`/`_ended` so a retried roster event
before the first join attempt finishes cannot double-fire.

`waitroom_noshow_shown` {booking_id, role: 'buyer'} — fired once per visit,
customer-side only, in `_onTick` the moment `check_in_by` passes with the
roster still reporting no host present (`!_rosterHost`). Read straight off
the server's `check_in_by`/`roster` fields, never computed locally from a
hardcoded wait window (RULEBOOK §5).

`waitroom_chat_sent` {booking_id, role} — fired on every waiting-room chat
send (`CommercialWaitingRoomChannel.sendChat`, ≤ 500 chars per the WP2 DO
contract). Message text itself never reaches PostHog.

Success value for this WP's ship gate: `waitroom_enter` on a real booking
with a non-null `room_ws` confirms the app is on the new waiting-room path
rather than the fallback; `waitroom_autojoin` appearing before the existing
`consult_room_entered`/join telemetry on the same booking+device confirms the
auto-join rule fired ahead of the manual "Join consultation" tap it replaces.

## WP8 [LIVE-GRACE-1] — live host disconnect grace window, worker-side

Surface: `worker/src/routes/commercial_stream_sessions.ts` (live branches of
`recordCommercialStreamEvent`), `worker/src/lib/live_grace.ts`,
`worker/src/do/stream_session.ts` (alarm kind `live_grace`),
`worker/src/commercial_settlement.ts` (live `host_no_return` branch). All
worker-side events emitted via `commercialEvent(env, event, uid, props)`
(`worker/src/lib/commercial_telemetry.ts`) — same `lane: 'commercial'`,
`schema_version` super-property contract as every other commercial event in
this catalog.

`commercial_live_grace` {kind: 'live_event', outcome: 'armed'} — fired from
`armLiveGrace` when a GetStream `participant_left` webhook for the live
event's `host` member arrives while `commercial_sessions.state='live'`
(RULEBOOK-PAID-SESSIONS.md v2 §4 L4/L5). Idempotent: a replayed webhook for an
already-armed window fires nothing (the D1 write it gates on reports zero
rows changed).

`commercial_live_grace` {kind: 'live_event', outcome: 'rejoined'} — fired
from `clearLiveGrace` when the host's `participant_joined` webhook arrives
before the grace deadline. Same idempotency guard.

`commercial_live_grace` {kind: 'live_event', outcome:
'host_already_reconnected'} — fired from `endLiveOnHostNoReturn`'s
defence-in-depth re-check ([WAITROOM-4] R4): the alarm (or the cron sweep) fired
but the host already has an open participant interval, so the window is cleared
and the session stays live instead of ending. Should be RARE — a steady stream of
these means `clearLiveGrace` is not running on the host's rejoin webhook and the
grace window is only ever being torn down by the alarm.

`commercial_live_grace` {kind: 'live_event', outcome: 'host_no_return'} —
fired from `endLiveOnHostNoReturn`, called from the DO's `live_grace` alarm
(`do/stream_session.ts`) when nobody cleared the window in time. Session row
gets `state='ended', end_outcome='host_no_return'`; open participant
intervals and the open `commercial_live_outages` row are closed; one
`commercial_settlement_jobs` row is queued per order on the listing.

`commercial_settlement` {outcome: 'host_no_return_partial', kind:
'live_event'} — fired from `settleLiveHostNoReturn`
(`commercial_settlement.ts`) once per settled order. **Correction 2026-09-11
([WAITROOM-6]):** this paragraph was written from the PLAN's contract before
WP8's code landed and named a third property, `refund_pct`, that the emit site
does not carry — `commercialEvent(env, "settlement", null, { outcome:
parts.telemetryOutcome, kind: authority.kind })` sends `outcome` and `kind`
only (plus the `lane`/`schema_version` super-properties). Do not write a
PostHog assertion against `refund_pct`; the refund amount lives in the partial
receipt row, not in telemetry. The split itself is unchanged: the refunded
share is the unwatched fraction of the ticket's slot
(`gross × (slot_ms − watched_eligible_ms) / slot_ms`, `watched_eligible_ms`
excluding overlap with any `commercial_live_outages` row). The consumed
remainder is released through the pre-existing `releaseSnapshot` /
`finishSettlement` rails with the creator/platform amounts scaled by the
watched fraction; the unconsumed share goes out through the pre-existing
`executeCommercialRefund` / `finalizeCommercialRefund` refund rail with
`reason: 'host_no_return'`.

`commercial_reconnect` push (via `notifyCommercialUser`,
`worker/src/lib/commercial_notifications.ts`) — sent to the creator only,
`data: {kind:'commercial', type:'commercial_reconnect', listing_id,
session_id, deeplink}`. Routed through `consumers/src/fcm.ts`'s
`commercialType` branch (any `commercial_*` type forwards `type` +
`listing_id`/`session_id`/`deeplink` on the FCM data payload) rather than a
bare `notifyUser()` call, whose `notify` branch does not carry those fields —
this is the "preserves data" path WP7's push handler
(`app/lib/push/push_service.dart`) reads `listing_id` off.

Contract note: `GET /api/commercial/live/:id/state` (`commercialLiveState`)
now exposes `state:'reconnecting'` (projected — see
`migrations/2026-09-11-live-grace-alter.sql` for why the underlying `state`
column never stores that literal), `reconnect_deadline_ms` while the window
is open, `starts_at` unconditionally, and `outcome:'host_no_return'` once the
session has ended that way. No new telemetry from the state route itself —
WP5 (web) and WP7 (app) poll it and own the client-side events for what the
viewer/host sees.

## APP-ONLY-TX

Owner decision 2026-09-12 (rulebook §7): all transmission is from the app; the
browser is customer-only. Two events cover the browser-side surfaces this adds.

`web_creator_redirected_to_app {listing_id|booking_id, role}` — fired when a
creator's browser hits a retired hosting surface (`/live/:id/host`, the old
`ConsultRoomGS` entry, or the dashboard "Host" affordance) and is shown the
"Start this event/session from the avaTOK app" deep link instead. `role` is
always `'creator'` here (viewer/customer traffic never fires this event).
Exactly one of `listing_id` (live event) or `booking_id` (1:1 consult) is set.

`session_chat_attachment_sent {booking_id|listing_id, role, mime, bytes}` —
fired by web or app when a chat message with a file attachment is sent inside a
live/booked session (the side chat described in rulebook §3/§7). `role` is
`'creator'` or `'customer'`; `mime` and `bytes` describe the uploaded file (not
the ≤ 1 KB JSON descriptor that actually rides the chat socket). Exactly one of
`listing_id`/`booking_id` is set, matching whichever lane the session is in.


## JOIN-LINK-1

Owner rule 2026-09-12 (rulebook §7): the link in a booking/ticket email drops the
customer straight into the room with no login; a bare `/live/:id` or
`/session/:id` from any other source keeps the email-code gate and, if that
account holds no ticket, offers the listing's checkout. Two web events.

`join_link_opened {kind, outcome, status?, reason?}` — fired once by
`islands/join/JoinLink.tsx` for every `/j/:token` open. `kind` is
`'live' | 'consult' | 'unknown'` (unknown only when the token was refused before
a destination was known). `outcome` is `'joined'` (ticket redeemed, navigating to
the room), `'expired'` (worker answered 410 — link past session end + 24 h,
booking cancelled, entitlement refunded/revoked), or `'invalid'` (404 forged or
truncated token; also our own failures, with `reason` naming which). This is the
event that says whether rule (a) is actually working in the field: a rising
`expired`/`invalid` share means emails are carrying links that do not open.

`pay_and_join_shown {listing_id, kind, refusal?}` — fired when a signed-in
visitor is shown the "Pay and join" panel instead of a dead end: by
`islands/live-gs/LiveGsViewer.tsx` on a `needs_ticket` refusal (`kind:'live'`)
and by `islands/consult-gs/ConsultRoomGS.tsx` on `needs_ticket` / `not_yours`
(`kind:'consult'`, `refusal` naming which). Pair it with §2.5's checkout events
to see how many shared links become paid tickets.

Worker side: `join_link` on the commercial telemetry lane
(`lib/commercial_telemetry.ts`, so it carries `lane:'commercial'`) with
`{kind, token_version, listing_id, booking_id, outcome}` — the server's own
record of a link being exchanged for a session.

## `[AGENT-LIVE-1]` — AI voice agent listings on GPT-Live-1 (2026-09-12)

Canonical spec: `Specs/SPEC-2026-09-12-AGENT-LIVE-1-BUILD.md` §8. Web events go
through `web/src/lib/analytics.ts`'s `capture()` (shared super-property
contract, §1.1 above); worker events go through `hooks.track(env, uid, event,
app_name, props)` per §5 above. Per §1.5, **no transcript text, memory
content, tool-call arguments, image bytes, or OpenAI API keys ever ride any
event below** — only ids, enums, counts and durations.

### Web

| Event | Props | Note |
|---|---|---|
| `agent_listing_view` | `agent_id` | Listing detail viewed for `kind='agent'`. |
| `agent_quote` | `minutes, instant, outcome` | `POST .../quote`. `outcome` is the ship-gate-style success value: `ok` \| `unavailable` (503 `agent_live_unavailable`) \| `error`. |
| `agent_booking_created` | `minutes, instant, wait_s` | `POST .../book` succeeded. `wait_s` is time from now to `starts_at` (0 for Talk now). |
| `agent_seat_unavailable` | `next_free_in_s` | `book` returned 409 `seat_taken`. |
| `agent_talk_open` | `agent_id, booking_id` | Talk page mounted, before mic permission. |
| `agent_talk_ready` | `connect_ms, outcome` | **Ship-manifest success value.** Fires once the WS relay reports the OpenAI session is live and audio is flowing both ways. `outcome: 'ok'` \| `'error'` \| `'timeout'`; `connect_ms` is time from `agent_talk_open` to ready. |
| `agent_talk_image_shared` | `outcome, ms` | "Share a photo" round trip: upload → `session.commentary.append` spoken. `outcome: 'ok'` \| `'error'` \| `'quota'`. |
| `agent_talk_ended` | `reason, billed_s` | Talk room closed. `reason` mirrors `agent_live_sessions.end_reason` (`slot_complete`, `customer_end`, `disconnect_timeout`, `provider_error`, `capacity`, `platform_error`, `emergency_stop`, `no_show`). |
| `agent_memory_forget` | `agent_id` | "Forget me" tapped on the ended card. |
| `agent_admin_save` | `outcome` | Admin create/patch/publish. `outcome: 'ok'` \| `'error'` \| `'refused'` (non-admin, 403 `agent_admin_only`). |
| `agent_kb_upload` | `outcome, bytes` | Admin knowledge-base file upload. `outcome: 'ok'` \| `'error'`. Never the filename or file content. |

### Worker (`track()`)

| Event | Props | Note |
|---|---|---|
| `agent_session_start` | `outcome, reason, agent_id` | Room DO attempts the provider session at `starts_at`. `outcome: 'ok'` \| `'refused'` \| `'error'`; `reason` names the gate that refused (`agentTalkEnabled`, `agentEmergencyStop`, missing key/admin/secret, capacity). |
| `agent_openai_error` | `code` | Any non-2xx / socket error from the OpenAI Live or Responses API. `code` is the provider's error code/class, never the raw message body. |
| `agent_capacity_refused` | — | `AgentSeatAuthorityDO` refused a reservation (agent or platform cap). |
| `agent_session_settled` | `outcome, gross, refund, billed_s` | **Ship-manifest success value.** Fires once per booking when `agent_live_decisions` is written. `outcome` is the decision outcome enum: `completed_full` \| `no_show` \| `cancelled_by_customer_early` \| `refunded_platform_failure`. `gross`/`refund` are token amounts (never `$`, per CLAUDE.md's token rule). |
| `agent_memory_written` | `facts_n` | Summariser wrote `agent_live_user_memory`. Count only — never fact text. |
| `agent_money_job` | `kind, state, attempts` | Every `agent_live_money_jobs` transition (`refund` \| `release` \| `erase` \| `summarise`; `pending` \| `running` \| `done` \| `needs_attention`). |
| `$ai_generation` | `$ai_model, $ai_provider, $ai_input_tokens, $ai_output_tokens, $ai_total_cost_usd, $ai_trace_id` | Emitted at the summariser call and the vision (`describe_shared_image`) call on `agent.backend_model`, mirroring the existing `reception_room_cf.ts` pattern. |

### Ship manifest

`tool/ship_manifest.json` entry `AGENT-LIVE-1`: `two_sided:false`, flags
`agentListingsEnabled, agentCheckoutEnabled, agentTalkEnabled`. Success:
`agent_talk_ready.outcome == 'ok'` from **≥ 2 distinct persons** (the admin
test call is one; a real second customer booking via the `/j/` link is the
other — an admin-only pass does not count, per the ship gate's "two phones
before the word shipped" rule) and `agent_session_settled.outcome ==
'completed_full'` **≥ 1** (a real, non-`is_test` booking that paid out).

---

## `[VIDEO-HERO-1]` / `[PHOTO-STRIP-2]` / `[DETAIL-PROMO-1]` / `[CHECKOUT-PROMO-1]` — listing detail media + promo pricing (2026-09-13)

Surfaces: `web/src/components/ListingDetailsComp.astro` (the LIVE detail page for
`/l/[id]`, `/[username]/[slug]` and `/e/[event]` — `ListingDetailView.astro` is
dead code and emits nothing) and `web/src/islands/checkout/CommercialPayStep.tsx`.
All go through `web/src/lib/analytics.ts`'s `capture()`, so they carry the §1.1
super properties (`platform`, `service_name`, `release`, `app`, `email`,
`device_class`, `viewport`, `trace_id` where one is active). Per §1.5 no promo
code STRING is ever sent from the detail page, and the checkout events carry the
code's length and outcome, never the code itself where it could be harvested —
`checkout_promo_applied` reports only `result`, `quoted_total` and
`charged_total`.

### Web — listing detail (§2.4 addendum)

| Event | Props | Note |
|---|---|---|
| `listing_video_play` | `listing_id, creator_uid, provider, surface` | The buyer pressed play on the embedded hero video. `provider: 'youtube'` (the only embedded provider — anything else keeps the outbound HIGHLIGHT REEL tile and is a plain `listing_cta_click`), `surface: 'hero'`. Detected by focus moving into the `youtube-nocookie` iframe, so it fires at most once per page view and never without a real gesture. |
| `listing_photo_open` | `listing_id, creator_uid, index, photo_count` | A photo thumbnail opened the lightbox. `index` is 0-based within the strip; `photo_count` is how many real uploaded photos the strip is showing (the AI poster is excluded by `cover_media[].source === 'ai_poster'`, never by position). |
| `listing_photo_error` | `listing_id, creator_uid, reason` | The full-size photo failed to load inside the lightbox. `reason: 'image_load_failed'`. This is the "no silent catch" path for the new surface — before it, a broken R2/CDN render was invisible. |

### Web — checkout promo code (§2.5 addendum)

| Event | Props | Note |
|---|---|---|
| `checkout_promo_submitted` | `listing_id, kind, code_length` | "Apply" pressed. Staging only — there is no validate endpoint, so this is an intent, not a result. Never the code text. |
| `checkout_promo_applied` | `listing_id, kind, result, quoted_total, charged_total?` | **The success value.** `result: 'success'` only after the checkout POST returned 200 and `charged_total` is the amount the SERVER says it charged; `result: 'invalid'` when it returned 400 `invalid_promo_code` (no money moved). A client-computed discount is never reported, because the client never computes one. |

### Ship manifest note

These four issue ids ship together as a web-only change (`two_sided: false`, no
app build). The assertions to write down BEFORE the deploy, per the ship gate's
rule 3:

- `listing_video_play` present with `provider == 'youtube'` for a listing that
  has a `video_url` — i.e. the embed replaced the outbound tile and the buyer
  stayed on the page.
- `checkout_promo_applied.result == 'success'` at least once with
  `charged_total < quoted_total`. `result == 'invalid'` present is NOT a pass;
  it only proves the error path renders.

---

## `[LIST-APP-PARITY-1]` — app listing wizard + detail parity with the web (2026-09-13)

App events, emitted through `app/lib/core/analytics.dart` (`Analytics.capture`,
`Analytics.uiInteraction`, `Analytics.captureException`). The shared
super-property contract of §1.1 rides automatically via `Analytics._base` — in
particular `email`, `phone` and `clerk_uid`, so every event below is
retrievable per tester by email, which is the only way to tell whose device a
problem is on. Per §1.5, **no listing copy, no promo-code value and no photo
bytes ever ride an event below** — only ids, enums, counts and durations.

### Android / iOS app

| Event | Props | Note |
|---|---|---|
| `ui_interaction` name=`listing_ai_copy_assist` | `field, outcome, ai_source, kind, listing_id, latency_ms` | **Success value.** One tap of a per-field "Use AI" blip on the wizard's Pitch step, round trip to `POST /api/listings/copy-review`. `field: 'title' \| 'blurb' \| 'description'`; `outcome: 'ok'`; `ai_source: 'ai' \| 'rules'` — a run of `rules` means the model half is silently down and creators are getting a length fit, not an AI review. |
| `listing_ai_copy_assist_failed` | `field, outcome, kind, listing_id` | The call did not answer. `outcome: 'error'`. Paired with a handled `$exception` carrying `stage: 'copy_review'`. Note the step then UNBLOCKS — a provider outage must never make listing impossible — so a rise here means creators are publishing un-reviewed copy. |
| `listing_ai_copy_applied` | `field, outcome, ai_source, kind, listing_id` | The creator pressed Apply on a suggestion. `outcome: 'applied'`. The ratio against `listing_ai_copy_assist` is how useful the suggestions actually are. Never the text. |
| `listing_promotion_saved` | `listing_id, promotion_kind, pct_off, outcome` | A creator-side discount was reconciled into `listing_promotions`. `promotion_kind: 'early_bird' \| 'promo_code'`; `outcome: 'ok' \| 'error'`. Never the code string. |
| `listing_promo_applied` | `listing_id, surface, outcome` | **Success value for the buyer half.** A promo code was sent with a checkout. `surface: 'native_booking' \| 'commercial_checkout_sheet'`; `outcome: 'ok'` (the server accepted and charged the discounted amount) \| `'invalid'` (400 `invalid_promo_code`). Never the code itself. |
| `listing_video_play` | `listing_id, video_id, surface, outcome` | The video hero on the native detail page was tapped and the inline player mounted. `surface: 'detail_hero'`; `outcome: 'started'`. |
| `listing_gallery_opened` | `listing_id, photo_index, photo_count, outcome` | A gallery thumbnail was tapped and the full-screen viewer opened. `outcome: 'opened'`. |

Existing app events unchanged and still emitted from these surfaces:
`listing_native_wizard_opened`, `listing_native_wizard_saved`,
`listing_native_wizard_save_failed`, `listing_native_wizard_upload_completed`,
`listing_native_wizard_submitted`, `listing_detail_opened`,
`native_booking_opened`, `commercial_checkout_confirmed`,
`listing_checkout_refused_closed`.

### Worker

No new worker events. `POST /api/listings/copy-review` already emits
`listing_copy_review` via `track(env, uid, event, app_name, props)` with
`source`, `kind` and the per-field `*_changed` / `*_len` counts
(`worker/src/routes/listing_copy_review.ts`); the app calls the same route, so
those rows now carry app traffic as well as web traffic and are separated by
the `platform` / `service_name` super-properties, not by a new event name.
`POST /api/listings/:id/promotions` already emits `listing_promo_created`.

## Dashboard 2 — customer dashboard, WORKER half (`[DASH2-API]`, 2026-09-25)

Spec: `Specs/SPEC-2026-09-25-DASHBOARD-2.md`. Emitted from
`worker/src/routes/me_dashboard.ts` with `trackUser` (event + `$set` carry the
caller's email, resolved via `lib/identity.ts emailFor`), `app_name: 'saathum'`.
Uncaught route errors → handled `$exception` via `hooks.trackException` with
`extra.area: 'dash2'`. Never a phone number in clear (masked `+91 98•••••210`),
never a UTR, never the refund reason text.

| Event | Props | Note |
|---|---|---|
| `dash2_refund_request` | `payment_id, order_id, listing_id, ok, reason_code?, amount_paise, has_refund_vpa, hours_before_event` | **Success value: `ok: true`.** Customer asked for a refund (only allowed ≥24h before the event). `ok: false` rows carry `reason_code` (`refund_window_closed`, `not_paid`, `refund_already_requested`, `already_refunded`, `no_event_time`). |
| `dash2_refund_recorded` | `payment_id, order_id, amount_paise, admin_uid` | Admin entered the refund UTR after refunding by hand from the bank app. Distinct uid = the CUSTOMER, so the customer's email pulls it. |
| `admin_refund_rejected` | `refund_id, payment_id, admin_uid, amount_paise, has_note, note_len` | [DASH2-ADMIN-REFUNDS] **Success value: event exists.** Admin rejected an open refund request at /admin/refunds (POST /api/admin/refunds/:refund_id/reject). Distinct uid = the CUSTOMER. The note itself is kept in `admin_audit` (DB_WALLET, action `refund_request_rejected`), not in PostHog. |
| `dash2_receipt_generated` | `payment_id, receipt_no, stamp, regenerated, bytes` | **Success value.** A receipt PDF was rendered and stored in R2 `DIGITAL`. `stamp: 'PAID' \| 'REFUNDED'`; `regenerated: true` when an earlier PAID copy was replaced after a refund. Cache hits emit nothing. |
| `dash2_phone_change` | `step, ok, outcome, phone_masked, …` | `step: 'start'` — `outcome: 'sent' \| 'phone_taken' \| 'rate_limited' \| 'global_breaker' \| 'provider_error'`. `step: 'confirm'` — `outcome: 'swapped'` (**success value**) \| `'mismatch' \| 'expired' \| 'provider_unreachable' \| 'phone_taken'`. |
| `dash2_video_link_set` | `listing_id, cleared` | Admin set (`cleared: false`) or removed (`cleared: true`) an event's unlisted YouTube video via `PUT /api/admin/listings/:id/youtube`. Distinct uid = the ADMIN. Never the URL. |

## Dashboard 2 — event screens, WEB half (`[DASH2-EVENTS]`, 2026-09-25)

Emitted from `web/src/islands/dashboard2/{BookEvents,MyEvents,PastEvents}.tsx` and
`web/src/islands/admin/YouTubePanel.tsx` through `web/src/lib/analytics.ts` (same
super-properties as every web event: `email`, `clerk_uid`, `trace_id`, …).

| Event | Props | Note |
|---|---|---|
| `dash2_search` | `q, q_len, results, active_filters` | One per distinct committed search (250ms debounce) after the catalog answered. `results: 0` = the empty state was shown. |
| `dash2_filter_apply` | `filter, surface, cats, from, to, tod, min, max, active_count` | `surface: 'bar' \| 'drawer' \| 'rail'`. `filter` names what changed (`cat`, `from,to`, `tod`, `min,max`, `drawer`, `clear`). `from/to` are IST dates, `min/max` rupees. |
| `dash2_join_click` | `event_id, order_id, state, via, seconds_from_start` | **Success value:** `state: 'live'` with `seconds_from_start` ≥ 0. `via: 'player' \| 'link'`. Negative `seconds_from_start` = opened in the 15-minute get-ready window. |
| `dash2_add_to_calendar` | `event_id` | `.ics` downloaded from the get-ready window. |
| `dash2_replay_play` | `event_id, order_id, surface` | Past-event recording opened (`surface: 'dialog' \| 'drawer'`). |
| `dash2_replay_error` | `event_id, code, ms_after_open?, surface?` | YouTube player error. `code` 101/150 = embedding disabled on the video (fix on YouTube), 100 = removed/private, 2 = bad id, -1 = the IFrame API failed to load (network/CSP). Also fires from the live/upcoming player with `surface: 'live' \| 'upcoming'`. |
| `admin_youtube_link_saved` | `listing_id, cleared, ok, error?` | Client half of `dash2_video_link_set`: records the FAILED saves too (`ok: false`, `error: 'invalid_youtube_url'` …). |

## Preeti — site AI agent, WORKER half (`[SAATHUM-PREETI-1]`, 2026-09-30)

Emitted from `worker/src/routes/preeti.ts`, `worker/src/lib/preeti/*` with `hooks.track` (`app_name: 'saathum'`;
uid = the signed-in Clerk uid, else `anon`, else `system` for cron). Failures go through `hooks.trackException`
(`handled: true`, `route: 'preeti.*'`). Never a phone number, never a UTR (only `sha256` in `ai_booking_lookups`),
never message text in PostHog.

| Event | Props | Note |
|---|---|---|
| `preeti_turn` | `conversation_id, outcome, model, input_tokens, output_tokens, cost_micro_usd, tools, tool_rounds, grounded, cards, lead, mood, lang, page_kind, signed_in, is_test, handover, latency_ms` | **Success value: `outcome: 'ok'`** with tokens > 0. `outcome`: `ok` \| `blocked` (safety/empty -> fallback text) \| `partial_error` (Gemini failed after some text) \| `over_budget` (fixed WhatsApp-us reply, no Gemini call). `lead` 0-3, `mood` calm/upset/angry come from the hidden trailer. |
| `$ai_generation` | `$ai_model, $ai_provider:'google', $ai_input_tokens, $ai_output_tokens, $ai_total_cost_usd, $ai_trace_id, $ai_span_name:'preeti_turn', $ai_latency, conversation_id, is_test` | LLM Analytics (mirrors `reception_room_cf.ts` `[AI-OBS-1]`). One per turn (grounding + answer tokens summed). |
| `preeti_session` | `signed_in, restored, needs_identity, page_kind` | Widget opened / history restored. |
| `preeti_identified` | `signed_in` | Anonymous visitor gave name + WhatsApp (number NOT logged). |
| `preeti_handover` | `conversation_id, reason, signed_in, is_test` | Human hand-off requested; ops WhatsApp queued. |
| `preeti_lookup_locked` | `conversation_id` | 3 failed `check_booking` lookups in 10 min -> locked 1 h. |
| `preeti_rate_limited` | `signed_in` | 429 from the chat limits (30/visitor/h, 120/IP/h). |
| `preeti_spend_alert` | `kind: '80' \| '100', sent, reason?` | Monthly cap alert to the ops WhatsApp (once per IST month per level). `sent:false` carries the failure `reason`. |
| `preeti_retention_purge` | `day, messages_deleted, conversations_deleted` | Daily 12-month purge. |
| `preeti_kb_sync` | `source:'deploy_hook', scanned, uploaded, unchanged, removed, failed` | `POST /api/preeti/internal/sync` finished. |

## Shop — Hindu T-shirts (`[SAATHUM-SHOP-*]`, 2026-10-01)

Spec: `SPEC-2026-10-01-SAATHUM-SHOP.md` §8. Web events use `capture` from `web/src/lib/analytics.ts`; worker events use
`hooks.track` (`app_name: 'saathum'`); failures go through `captureException` / `hooks.trackException`. Never an address,
phone number or UTR in an event. Every product id is the `prd-…` id, every order id the `shp_…` id.

### Web — storefront (`SAATHUM-SHOP-WEB-STORE-1`)

| Event | Props | Note |
|---|---|---|
| `shop_home_viewed` | — | `/shop` rendered (fires from `ShopTelemetry`, `client:idle`). |
| `shop_list_viewed` | `filters` | `/shop/all` or `/shop/c/<slug>` hydrated. `filters` = the active URL filters as `group=a,b&min=…` (empty string = none). |
| `shop_filter_changed` | `group, value, on?` | `group`: `collection\|colour\|size\|fit\|print\|for\|sort`. Checkbox/chip toggles carry `on`; `sort` carries the sort key as `value`. |
| `shop_product_viewed` | `product_id` | `/shop/p/<slug>` hydrated. |
| `shop_add_to_cart` | `product_id, size, colour, qty, source` | `source: 'card'` (quick add; also `home_new`, `home_best`, `also_like` from the grids) `\| 'pdp' \| 'buy_now'`. **Success value:** fired once per click that actually added a line. |
| `shop_cart_opened` | `count` | Cart drawer opened (header button, quick add, add to cart). `count` = items in the cart. |
| `shop_wish_toggled` | `product_id, on` | Heart on a card (`on: false` = removed). |

### Web — checkout (`SAATHUM-SHOP-WEB-CHECKOUT-1`)

| Event | Props | Note |
|---|---|---|
| `shop_checkout_step` | `step` | `step`: `you\|address\|review\|pay\|done`. |
| `shop_checkout_terms_blocked` | — | "Go to payment" pressed without both required boxes ticked. |
| `shop_order_created` | `order_id, total` | `POST /api/shop/orders` succeeded (`total` = rupees incl. GST). |
| `shop_pay_paid_claimed` | — | "I've paid" pressed. |
| `shop_pay_utr` | — | A 12-digit UPI reference submitted. |
| `shop_order_confirmed_seen` | `order_id` | The confirmation screen was shown. **Success value of the whole funnel.** |

### Web — dashboard (`SAATHUM-SHOP-DASH-1`)

| Event | Props | Note |
|---|---|---|
| `dash_orders_viewed` | — | `/dashboard/orders` opened. |
| `dash_order_problem_reported` | `order_id` | "Wrong item? Report it" submitted. |

### Web — admin (`SAATHUM-SHOP-ADMIN-1`)

| Event | Props | Note |
|---|---|---|
| `admin2_shop_product_saved` | `product_id, created` | Add / edit product saved. |
| `admin2_shop_product_deleted` | `product_id` | Archived (restorable for 30 days). |
| `admin2_shop_product_promoted` | `product_id, slots, badge` | Promote dialog saved. |
| `admin2_shop_order_status_changed` | `order_id, from, to` | `at_printer\|shipped\|delivered\|cancelled\|refunded`. |
| `admin2_shop_payment_confirmed` | `order_id, via` | `via: 'sms' \| 'utr' \| 'manual'`. |

### Worker (`track()`; `SAATHUM-SHOP-API-*`)

| Event | Props | Note |
|---|---|---|
| `shop_order_created` | `order_id, total_rupees, items, coupon` | Order row + reserved UPI amount created. |
| `shop_order_confirmed` | `order_id, via` | **Success value:** payment matched/confirmed; `via: 'sms' \| 'utr' \| 'admin'`. |
| `shop_order_rejected` | `order_id, reason` | Payment rejected by an admin. |
| `shop_order_status_changed` | `order_id, from, to` | Fulfilment transition. |
| `shop_problem_reported` | `order_id` | Buyer reported a wrong / damaged item within the window. |

### Ship manifest note

`WEB-STORE` success definition: `shop_product_viewed` followed by `shop_add_to_cart` with `source` in (`pdp`, `buy_now`, `card`) for the
same person; and `shop_cart_opened.count > 0`. Absence of `shop_list_viewed` with `filters` ≠ '' means the filter sidebar never ran.

## Studio + POD (`AUMFE-POD-*`, Oct 2026)

Print-on-demand Studio in Admin 2 (`/admin/shop/studio/**`) and the partner hand-off. Spec: `Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md` §5, §6, §8.

### Web — admin Studio (`AUMFE-POD-STUDIO-WEB-1`)

| Event | Props | Note |
|---|---|---|
| `studio_viewed` | `step` | A Studio screen opened; `step` is `home\|upload\|product\|design\|photos\|publish`. |
| `studio_design_created` | — | First file of a new design chosen (design row created). |
| `studio_art_uploaded` | `w, h, has_alpha` | Artwork checked in the browser and stored (size after trimming). `has_alpha:false` = no see-through background. |
| `studio_placement_saved` | `shape, dpi` | "Looks good" — print file rendered at 300 DPI and uploaded. **Success value:** `dpi` ≥ 150 (the editor blocks lower). |
| `studio_photo_uploaded` | `kind, size_ok` | An owner model photo stored; `size_ok:false` = short side under 1200 px. |
| `studio_published` | `steps_failed` | Publish call returned. **Success value:** `steps_failed = 0`. |

Errors (all via `captureException`, tagged `where`): `studio_list`, `studio_get_design`, `studio_fits`, `studio_art_upload`, `studio_art_preview`, `studio_solid_edges`, `studio_rename`, `studio_upload_next`, `studio_put_products`, `studio_print_file`, `studio_print_preview`, `studio_plain_pictures`, `studio_photo_upload`, `studio_photo_update`, `studio_photo_reorder`, `studio_photos_next`, `studio_copy_ai`, `studio_save_draft`, `studio_publish`, `studio_collections`, `studio_resume`.

### Worker (planned by STUDIO-API / CORE / FULFIL — listed here so the catalog is one place)

| Event | Props | Note |
|---|---|---|
| `admin2_studio_*` | per route | Studio API writes (design, art, print, photos, publish). |
| `pod_partner_*` | per route | Print-partner admin API (test, sync, settings). |
| `shop_fulfilment_sent` | `provider, ms` | Order accepted by the partner. |
| `shop_fulfilment_failed` | `code` | Partner call failed (`not_configured\|auth_failed\|rejected\|unavailable\|not_found`). |
| `shop_fulfilment_status` | `from, to, provider` | Partner status moved (poll). |
| `$ai_generation` | — | Studio best-match text and product-copy draft (Gemini text only; no image generation anywhere). |

## Notify me durable delivery (`[HF-NOTIFY-DELIVERY-1]`, 2026-10-11)

Worker source: `worker/src/lib/hf_notify.ts` materializes eligible one-shot subscriptions into existing `whatsapp_outbox` rows with `kind = hf_notify`;
`worker/src/lib/whatsapp_notify.ts` atomically claims and performs the paced provider attempt. This outbox is internal notification delivery state, **not a caller queue**. It has no
caller line, position, ETA, reservation or held call. Both materialization and HF delivery reuse `hfCallsEnabled`; `hfPushEnabled` affects only the optional
supplemental push queued after a confirmed WhatsApp success.

| Event | Props | Note |
|---|---|---|
| `hf_notify_queued` | `host_uid`, `subscription_created_at`, `channel: 'whatsapp'` | A new deterministic `hf_notify` outbox row was inserted. Queue acceptance only: this does **not** mean the provider sent the message. Re-materializing the same subscription is an `INSERT OR IGNORE` duplicate and emits no second queued event. |
| `hf_notify_sent` | `host_uid`, `outbox_id`, `attempt`, `channel: 'whatsapp'`, `push_queued: boolean`, `status: 'sent'` | Emitted only after `sendWhatsAppText` reports success and the atomically claimed row is guarded into `sent`. This preserves the event as confirmed provider success, never queue acceptance. `push_queued` reports only the optional supplemental channel queued while the claim was held. **Success value:** `channel = whatsapp`, `status = sent`, `attempt >= 1`. |
| `hf_notify_failed` | `host_uid`, `stage: 'materialize' \| 'delivery'`, `retryable`; materialize also has `subscription_created_at`; delivery also has `outbox_id`, `attempt`, `reason`, `terminal`, `status`, optional `manual_reconcile` | Materialization failure is retryable and leaves the subscription for the cron safety sweep. Delivery `reason` is `rate_limited \| not_on_whatsapp \| ambiguous_provider_result \| ambiguous_exception \| ambiguous_in_flight`. Known-not-accepted `rate_limited` stays `status = queued`, `retryable = true` only before attempt six, then becomes terminal `failed`; `not_on_whatsapp` is terminal `failed` immediately. Ambiguous provider/exception results and a `sending` claim older than 120 seconds use `status = manual_reconcile`, `manual_reconcile = true`, `retryable = false`, `terminal = true` and are never auto-replayed. |

The 24-hour guard is per caller/host pair and compares the true prior `sent_at`, with `created_at` only as fallback; its strict boundary makes exact `+24 h` eligible.
When `WASENDER_API_KEY` is absent, the drain returns before scanning; queued rows remain untouched for a later configured run, and no attempt increment or delivery event occurs. `unconfigured` is therefore not an emitted HF delivery reason.
Handled exceptions remain in `trackException` under `hf_notify.materialize`, `hf_notify.notifyHostOnline` or `whatsapp_outbox_drain`.
Blocked pairs and callers without a currently verified WhatsApp number are silently removed before materialization. Immediately before provider I/O, an
already queued HF row is atomically claimed and revalidated: `hfCallsEnabled` off, a block, no current verified E.164 or a mismatch with the queued number
silently sets `status = cancelled`. Cancellation emits none of these delivery events and sends neither WhatsApp nor push. The atomic `queued -> sending`
claim increments `attempts`; only its winner may perform that attempt. This is at-most-once attempt control with explicit ambiguous reconciliation, not a
provider-idempotency claim. At catalog-update time, PostHog's 30-day event taxonomy contained none of the three delivery events; the rows above document
the inspected source contract and must not be presented as observed production traffic until they arrive.

### Native post-decline / missed-call action

The native call summary reuses `hf_app_notify_me` rather than introducing a second client event. For a non-cancelled `host_declined` or `no_answer`
with a host slug, it adds `surface = call_summary` and `call_status`; success removes the one-shot action, while an API error keeps it retryable.
The initial-unavailable host-profile/card shape remains unchanged.

## Hello Fraands Android app — app mode on the website (`[HF-APP-3]`, 2026-10-10)

Spec: the Hello Fraands Android app spec, HF-APP-3 / HF-APP-8 (project doc `hello-fraands-android-app-spec`). The app is a Capacitor shell that loads the
live site; the site runs in **app mode** when the user agent carries the `HelloFraandsApp/<shellVersion>` marker or `window.Capacitor` exists.
All web events go through `web/src/lib/analytics.ts` (`capture`, `registerSuperProps`); failures through `captureException`. No phone number, no uid in props
(identity comes from `identify`).

**Super properties (app mode only, registered once per page load; override the default `platform: 'web'`):** `platform: 'android-app'`, `shell_version` (number from the
user agent, `0` = unknown/older shell). On the plain web `platform` stays `'web'`.

### Web (`lib/appMode.ts`, `lib/hfApp.ts`)

| Event | Props | Note |
|---|---|---|
| `hf_app_open` | `platform: 'android-app', shell_version` | Once per session (sessionStorage flag) when the site loads in app mode. **Success value:** arrives with `platform = android-app` once the app ships; none from plain web. |
| `hf_app_back_exit` | — | The Android back button was pressed on the home screen (or with no history), the "Exit Hello Fraands?" sheet was shown and the person tapped Exit. |
| `hf_app_external_link` | `host` | In app mode a tapped link left the app: `host` is the other domain (e.g. `wa.me`) or the scheme for `tel`, `mailto`, `sms`, `whatsapp`. Brand domain, api, auth and media hosts never fire this. |
| `hf_app_deeplink_opened` | `path`, `launch: 'cold' \| 'warm'` | **App mode only** (`lib/appMode.ts`, `[HF-APP-LINKS-1]`). A https link on the site host (apex or www) opened the app: `warm` = app was running (`App.appUrlOpen`), `cold` = tapped while closed (`App.getLaunchUrl`). `path` is anonymised: ids, slugs and tokens become `:id` (`/h/:id`, `/review/:id`, `/people/:id`), other paths keep two segments (`/hosts/dashboard`, `/wallet`); the query string is never sent. Not fired for the DigiLocker return. **Success value:** `path = /h/:id` after tapping a host link from WhatsApp/email on a phone with the new build. |
| `hf_app_permission` | `kind: 'camera' \| 'mic'`, `result: 'granted' \| 'denied' \| 'error'` | **App mode only** (`lib/appPermissions.ts`, host onboarding selfie and voice steps). Fired right after `getUserMedia`: `granted` = the camera or microphone opened, `denied` = NotAllowedError (person tapped Don't allow, or Android blocked it; the "Open settings" panel shows), `error` = any other failure (no device, in use). Plain web never fires it. **Success value:** `result = granted` for both `kind = camera` and `kind = mic` during the owner's test host sign-up. (`kind = push` is added by the push issue.) |
| `hf_token_web_blocked` | `reason: 'topup' \| 'call'` | **Plain web only.** The person tapped the "Get the app" link on the wallet's "Add tokens in the app" panel (`reason: 'topup'`) or the "Open the app to call" button on a host card or profile (`reason: 'call'`). Never fires in app mode. |
| `hf_onb_web_download_app` | `source: 'panel_view' \| 'play' \| 'open_app'` | [HF-INTRO-B1] Plain web only, while hfIntroOnboardingEnabled is on. The "Influencer sign-up happens in our app" panel at /hosts/onboarding was shown (`panel_view`) or the person tapped the Google Play button (`play`) or the Android-only "Open the app" link (`open_app`). |

Errors (`captureException`, tagged `where`): `hf_app_init`, `hf_app_back_listener`.

### Ship manifest note

Success for `HF-APP-3`: `hf_app_open` with `platform = android-app` (only possible once the Android shell ships; the plain website is unchanged and emits none of these
except `hf_token_web_blocked`). The `hf_app_offline_shown`, `hf_app_deeplink_opened`, `hf_app_permission` and push events of HF-APP-8 belong to the later phases.

## Hello Fraands Android app — push notifications (`[HF-APP-4]`, 2026-10-10)

Spec: the Hello Fraands Android app spec, HF-APP-4 / HF-APP-8. Tokens are stored in D1 `hf_push_tokens`; sends go through the push queue to `consumers/src/fcm.ts`
(kind `hf_push`). The whole thing is behind flag `hfPushEnabled` (default `false`). Token registration works while the flag is off; nothing is sent until it is on.
Push `kind` values: `notify_me`, `host_approved`, `host_changes`, `withdrawal_approved`, `withdrawal_paid`, `low_balance`, `review_request`.

| Event | Where | Props | Note |
|---|---|---|---|
| `hf_app_permission` | web (`lib/appPush.ts`) | `kind: 'push'`, `result: 'granted' \| 'denied' \| 'dismissed'` | `granted`/`denied` = the Android permission prompt answer. `dismissed` = the person tapped "Not now" on our explainer sheet (Android prompt never shown). Camera and mic values for the same event belong to HF-APP-5. |
| `hf_push_registered` | web (`lib/appPush.ts`) | `shell_version` | FCM gave the app a token and the worker accepted it (`POST /api/hf/push/register` answered ok). |
| `hf_push_sent` | worker (`lib/hf_push.ts`, via `track`) | `kind` | A push job was queued for a user who has at least one registered device. Not sent when the flag is off, the user has no token, or the copy/path was unsafe. Queue acceptance, not phone receipt. |
| `hf_push_opened` | web (`lib/appPush.ts`) | `kind` | The person tapped a notification and the app opened its page. **Success value:** arrives for each kind; for `HF-APP-4` the shipped proof is `kind = notify_me`. |

Errors: web `captureException` tagged `where: 'hf_push_register' \| 'hf_push_registration_error' \| 'hf_push_permission' \| 'hf_push_open'`; worker `trackException` routes `hf_push.sendHfPush`,
`/api/hf/push/register`. FCM send failures and dead-token prunes reuse the existing consumer events `push_send_failed`, `push_token_pruned`.

## HF Play token purchases (`[HF-TOK-PLAY-1]`, 2026-10-10)

Server only (`worker/src/lib/hf_play.ts`, `routes/hf_tokens_play.ts`), all through `trackUser` (uid + email), `area: 'hf_token_play'`. Dark behind `hfTokensEnabled`
(default `false`): none of these fire until the owner flips it and a purchase is made. The Android app (separate issue) calls the routes.

| Event | Props | Note |
|---|---|---|
| `hf_token_purchase_prepared` | `product_id`, `tokens`, `estimate_paise` | `POST /api/hf/tokens/play/prepare` returned the account id. The buyer may still cancel in the Play sheet. |
| `hf_token_purchase_verified` | `tokens`, `paid_paise`, `duplicate`, `source: 'verify' \| 'rtdn' \| 'cron'` | A Play purchase was confirmed and its lot exists. `duplicate: true` = the lot already existed (retry, notification or cron saw the same purchase again; never a second lot). `paid_paise` is Play's rupee price when Play reports rupees, else the catalogue price. **Success value:** arrives with `duplicate = false` and `tokens = 100` for the owner's first real Rs 100 test purchase. |
| `hf_token_purchase_failed` | `reason`, `source: 'verify' \| 'rtdn' \| 'cron' \| 'prepare'`, `product_id` | `reason` is one of `disabled`, `unconfigured` (missing salt or Play key), `unknown_product`, `invalid_purchase` (Play does not know the token), `account_mismatch` (purchase belongs to another account), `unknown_account`, `no_order`, `unavailable` (Play unreachable, retry), `internal`. |
| `hf_token_refund_applied` | `debt_paise`, `source: 'rtdn' \| 'voided_sweep' \| 'race' \| ...`, `removed_tokens` | A Google refund / void removed a purchase lot, once. `debt_paise > 0` = some of those tokens were already spent: an open debt blocks calls until the next purchase clears it. Host earnings are never touched. |

Errors: worker `trackException` routes `/api/hf/tokens/play/*` and `hf_play` (`step: insert_purchase`).

## Hello Fraands native app (`hf-flutter/`, `[HF-NATIVE-1]`, 2026-10-10)

Spec: the Hello Fraands Android app spec, section 8 (project doc `hello-fraands-android-app-spec`). Project: PostHog EU 139917, through `posthog_flutter`
(`lib/core/analytics/analytics.dart`). **Super properties on every event:** `platform: 'android-app'`, `service_name: 'hf-app'`, `app` (brand slug), `os`,
`release` (git SHA, `--dart-define=GIT_SHA`), `app_version`, `app_build`, `environment`, `screen`, `account_id`, `email`, `phone`, `clerk_uid`, `session_seq`.
`identify(clerk uid)` after sign-in, `reset()` on sign-out. Error tracking, native crash capture and masked session replay are on. No phone number or uid in event props.

| Event | Props | Note |
|---|---|---|
| `hf_app_open` | `cold_ms`, `signed_in` | Once per process start, after the splash work (session restore + `/api/config`, capped at 6 s). **Success value:** `platform = android-app`. |
| `hf_app_deeplink_opened` | `path`, `source: 'link' \| 'scheme' \| 'push'`, `launch: 'cold' \| 'warm'` | A link or push opened a screen. `path` is anonymised (`/h/:id`, `/review/:id`, `/review/call/:id`), the query is dropped. Same event name as the Capacitor app; filter by `service_name`. |
| `screen_viewed` | `from` | Every route change, with the same templated path in `screen`. |
| `api_error` | `endpoint`, `status`, `code`, `ms`, `latency_ms` | Emitted once by the API client for every non-2xx or network failure. A `404 not_enabled` (flag off) is not reported. |
| `signup_step` | `provider: 'whatsapp_ticket'`, `step`, `reason`, `ms` | Steps `ticket_redeem_started` / `ticket_redeem_completed` / `ticket_redeem_failed`, `secure_storage_reset`, `fapi_timeout`, `jwt_guard_tripped`. |
| `hf_app_welcome_accepted` | `outcome`, `version`, `signed_in` | `[HF-NATIVE-2]` The person ticked the 18+ and safety box on Welcome and tapped Continue. `version` is the `hfAckVersion` accepted (or `hf-ack-v1` when the config could not be read). The device keeps it and `POST /api/hf/me/ack` sends it once signed in. |
| `hf_app_signin_started` | `from` | `[HF-NATIVE-2]` The sign-in screen opened. `from` is the anonymised path that needed an account (`/wallet`, `/call/:id`, ...), or `direct`. Never a slug, id or token. |
| `hf_app_signin_code_sent` | `outcome: 'ok'`, `ms`, `resend` | `[HF-NATIVE-2]` `POST /api/auth/whatsapp/send` answered 200 and the code step opened. `resend` is true for "Send a new code". A refused send is `hf_app_signin_failed` with `step: 'send'`. |
| `hf_app_signin_success` | `outcome: 'ok'`, `is_new`, `ms` | `[HF-NATIVE-2]` The code was right, Clerk accepted the ticket and a session is active. `is_new` is true for an account made by this sign-in (only present while the worker's phone-only sign-up flag is on, else false). **Success value:** `is_new = true` for a first-time number on the owner's test phone. |
| `hf_app_signin_failed` | `outcome: 'failed'`, `reason`, `status`, `step: 'send' \| 'verify' \| 'ticket'`, `ms`, `clerk_error` (ticket step only, scrubbed) | `[HF-NATIVE-2]` Any refusal in the flow. `reason` is the worker's stable code (`invalid_phone`, `not_on_whatsapp`, `rate_limited`, `otp_unavailable`, `provider_error`, `wrong_code`, `code_expired`, `too_many_attempts`, `no_code`, `invalid_code`, `verify_failed`, `signin_failed`, `signup_failed`, `signup_in_progress`) or `network`, `timeout`, `needs_email` (phone-only sign-up not open yet), `bad_response`, `ticket_redeem` (Clerk refused the ticket: check the Clerk native-API toggle), `unexpected`. Never carries the number or the code. |

Errors (`captureException`): uncaught Flutter, platform and zone errors. Later issues add their own events to this section.

### Home and Explore (`[HF-NATIVE-3]`, `hf-flutter/lib/features/home/` and `lib/features/explore/`)

| Event | Props | Note |
|---|---|---|
| `hf_app_explore_viewed` | `filtered: boolean`, `lane: 'women' \| 'lgbtq'` (only on a lane) | The Explore screen was opened for the first time in this process (the tab keeps its state afterwards). `filtered` = it opened with filters from a Home tile or a link. **Success value:** arrives with `platform = android-app` after opening the Explore tab on the native build. |
| `hf_app_filter_applied` | `filters: {topics[], languages[], min_price, max_price, online, lane, sort}` (only the set ones plus `sort`), `source: 'sheet' \| 'lane' \| 'route' \| 'clear'` | The list filters changed: the filter sheet (`sheet`), a lane tab (`lane`), a Home tile or link (`route`), "Clear filters" (`clear`). Topic slugs and language codes only, never free text. |
| `hf_app_host_card_tapped` | `slug`, `from: 'explore' \| 'home'` | A host card (full card in Explore, narrow card in the Home "Online now" strip) was tapped and the profile opened. The profile's own view is `hf_app_profile_viewed`. |
| `hf_app_intro_played` | `slug`, `from: 'explore' \| 'home'` | The inline voice intro on a host card started playing (play, not pause). One speaker at a time: starting another card stops the first. A playback failure is reported as a handled exception (`where: intro_play`). |
| `hf_hosts_list_loaded` | `screen_name: 'explore' \| 'home'`, `outcome: 'ok' \| 'error'`, `result: 'cards' \| 'empty' \| 'error'`, `count`, `from_cache: boolean`, `ms`, and on error `reason` (worker code or `network`, `timeout`, ...) and `status` | Once per load of the first page of `GET /api/hf/hosts`. `from_cache: true` on an error means a saved list was on screen instead. A `lane_required` / `not_enabled` answer is also `error` with that `reason`. Later pages are not reported (failures show in `api_error`). |

### Host profile (`[HF-NATIVE-4]`, `hf-flutter/lib/features/host_profile/`)

| Event | Props | Note |
|---|---|---|
| `hf_app_profile_viewed` | `slug`, `status: 'online' \| 'busy' \| 'offline'` | Once per opening of `/h/:slug`, when the profile (live or the saved copy) is on screen. Not fired for not-found or error states. **Success value:** arrives with `platform = android-app` after opening a host on the native build. |
| `hf_app_call_tapped` | `slug`, `status` | The Call button was tapped (before the sign-in check, so signed-out taps count). The call itself is reported by the call screen events. |
| `hf_app_notify_me` | `slug`, `on: boolean`, `outcome: 'ok' \| 'error'`, `reason`, `status`, `ms`, optional `surface: 'call_summary'`, optional `call_status: 'host_declined' \| 'no_answer'` | Notify me turned on or off (`POST` / `DELETE /api/hf/hosts/:slug/notify`). The host-profile/card path keeps the original shape. The post-call one-shot action adds `surface = call_summary`, `call_status`, and always has `on = true`; it is offered only after a host decline or missed host answer. `reason` is the worker code (`not_verified`, `own_profile`, `not_found`, `network`, ...) and `status` the HTTP status, on error only. **Success value:** `outcome = ok`, `on = true`; for the new post-call path also require `surface = call_summary`. |
| `hf_app_report_tapped` | `slug` | "Report this profile" opened the web report page in a Custom Tab. |

### Wallet and token purchases (`[HF-NATIVE-6]`, `hf-flutter/lib/features/wallet/`)

Client events of the native Wallet. The server half of a purchase is `hf_token_purchase_prepared` / `_verified` / `_failed` above (worker). Product ids are `hf_tokens_*`; no token, order id, uid or phone is ever sent.

| Event | Props | Note |
|---|---|---|
| `hf_app_wallet_viewed` | `mode: 'tokens' \| 'legacy'`, `has_debt: boolean` | Once per opening of the Wallet tab, when the balance is on screen. `legacy` = the old rupee shape (tokens off). |
| `hf_token_purchase_started` | `product_id`, `tokens` | Client. The Play purchase sheet is about to open: `prepare` passed (limits fine) and, for a pack at or above `confirmAbovePaise`, the buyer said yes to "Are you sure?". The buyer may still cancel in the sheet. |
| `hf_app_purchase_result` | `status`, `product_id`, `source: 'buy' \| 'recovery'`, `reason`, `tokens` | End of one purchase attempt. `status`: `credited` (tokens added, `tokens` = amount), `duplicate` (server already had it), `pending` (Google has not confirmed the payment yet), `payment_canceled` / `refunded` (server says nothing was credited), `limit` (prepare refused: day or month limit, `binding` also sent), `user_cancelled` (`reason`: `play_sheet` or `not_confirmed`), `failed` (`reason`: the worker error code, or `launch`, `prepare`, `play_error`, `no_account_id`). `source = recovery` is a purchase found unfinished on start, on resume or when the Wallet opens. **Success value:** `status = credited` with `tokens = 100` and `source = buy` for the owner's first Rs 100 test purchase on a phone. |
| `hf_app_refund_requested` | `outcome: 'ok' \| 'error'`, `reason`, `status`, `ms`, `kind: 'tokens' \| 'money'` | The refund request for unused purchased tokens (`POST /api/hf/wallet/refunds`) answered. `reason` is the worker code on error (`insufficient_refundable`, `nothing_refundable`, `active_call`, `lot_changed`, ...). |

### Ship manifest note

`HF-NATIVE-0` is build infrastructure (`no_telemetry`). Success for `HF-NATIVE-1`: `hf_app_open` with `platform = android-app` and `service_name = hf-app`. Success for `HF-NATIVE-2`: `hf_app_signin_success` with `platform = android-app` (and `hf_app_signin_code_sent` before it) from the owner's phone.

## Hello Fraands native app: calls and reviews (`[HF-NATIVE-5]`, 2026-10-10)

Native call confirm, call screen, summary and review (`hf-flutter/lib/features/call/`, `lib/features/review/`). Same super properties as the rest of the native app
(`platform = android-app`, `service_name = hf-app`). No phone number, uid, call id or review token rides on any of these events.

| Event | Props | Note |
|---|---|---|
| `hf_app_call_started` | `slug`, `outcome: 'ok' \| 'failed'`, `reason`, `status`, `ms`, `mode: 'tokens' \| 'inr'` | Start call was tapped and `POST /api/hf/calls` answered. `reason` is the worker code on failure (`low_balance`, `debt_open`, `host_unavailable`, `lane_required`, `spend_limit`, `call_in_progress`, `not_verified`, `network`, ...) and `status` the HTTP status. **Success value:** `outcome = ok` for the owner's test call. |
| `hf_app_call_status` | `status: 'ringing_host' \| 'ringing_caller' \| 'connected' \| 'completed' \| 'host_declined' \| 'no_answer' \| 'caller_no_answer' \| 'failed' \| 'blocked'` | Once per distinct status the call screen sees while following a call (polling `GET /api/hf/calls/:id` every 2 s in the foreground). A good call shows `ringing_host`, `ringing_caller`, `connected`, `completed`. |
| `hf_app_call_cancelled` | `outcome: 'ok' \| 'too_late' \| 'failed'`, `reason` | Cancel call was tapped before the call connected. `too_late` = `409 already_connected`. |
| `hf_app_call_ended` | `seconds`, `end_reason`, `status`, `mode` | Once per call, when the status turns terminal. `seconds` is the talked time (exact for token calls, billed minutes x 60 otherwise). `end_reason` is `caller_hangup \| host_hangup \| hash_block \| time_limit \| balance \| error \| spend_limit`, or `none`. **Success value:** `status = completed` with `seconds > 0` on the owner's two-phone test. |
| `hf_app_review_submitted` | `stars`, `via: 'call' \| 'token'`, `outcome: 'ok' \| 'failed'`, `reason`, `status`, `ms` | A review was sent. `via = call` from the call summary (signed in), `via = token` from a WhatsApp or push link. `reason` is the worker code on failure (`contact_details`, `already_reviewed`, `expired`, ...). **Success value:** `outcome = ok`. |
| `hf_app_booking_requested` | `mode: 'manual' \| 'auto' \| 'direct'`, `has_topic`, `outcome: 'ok' \| 'failed'`, `reason` | [HF-BOOK-APPROVE] A fan tapped Confirm booking (hf-flutter `bookings_real.dart`). `mode` = `manual` when the booking now waits for the influencer. The worker emits its own `hf_booking_requested` with both uids. **Success value:** `outcome = ok`. |
| `hf_app_booking_accept_tapped` | `booking_id`, `outcome: 'ok' \| 'failed'`, `reason` | [HF-BOOK-APPROVE] The influencer tapped Accept on a waiting booking. |
| `hf_app_booking_decline_tapped` | `booking_id`, `outcome: 'ok' \| 'failed' \| 'dismissed'`, `reason` | [HF-BOOK-APPROVE] The influencer tapped Decline (`dismissed` = left the confirmation without declining). |
| `hf_app_cache` | `endpoint` (ids made generic), `outcome: 'hit_fresh' \| 'revalidated' \| 'miss' \| 'stale_on_error'`, `age_s` | [HF-APP-CACHE-1] How a cached read was served (hf-flutter `ApiClient.watchJson`). Once per endpoint and outcome per app run. **Success value:** many `hit_fresh` / `revalidated` rows for wallet, bookings, slots, me. |
| `hf_app_booking_mode_changed` | `from`, `to` (`manual` \| `auto`), `outcome` | [HF-BOOK-APPROVE] The influencer flipped the approval switch on the Bookings page. |
| `hf_app_call_confirm_viewed` | `slug`, `can_start: boolean`, `low: boolean` | `[HF-WIRE-7]` The Reels app's call confirm sheet loaded its estimate (`GET /api/hf/wallet/estimate`). `low` = fewer than `lowBalanceSeconds` (3 min) of talk time, so TOP UP replaces CALL NOW. No uid, number or call id. |
| `hf_app_call_cap_warning` | — | `[HF-WIRE-7]` Once per call: the connected call screen showed "About 1 minute left. Top up to keep talking." (60 s before `capAt`). |

`[HF-WIRE-7]` (Reels app, `hf-flutter/lib/demo/screens/call_real.dart`, `call_records_real.dart`) also emits the existing `hf_app_call_started` (`mode: 'inr'`), `hf_app_call_status`, `hf_app_call_cancelled`, `hf_app_call_ended` and `hf_app_review_submitted` (`via: 'call'`) with the props above. Worker side: `GET /api/hf/calls/:id` gained `phase`, `reason`, `costPaise`, `walletPaise`, `capAt`, `lowBalanceSeconds`; `GET /api/hf/calls` rows gained `reason`, `myStars`; the estimate gained `lowBalanceSeconds` (no new events).

The earlier `hf_app_call_tapped` (host profile, HF-NATIVE-4) comes first in the funnel; `api_error` covers every failed request.

### Ship manifest note

`HF-NATIVE-5` is two-sided (the host's phone has to ring and be answered): `min_devices_on_build` is 2. Success: `hf_app_call_ended` with `status = completed` and a `seconds`
value, and `hf_app_review_submitted` with `outcome = ok`.

`HF-NATIVE-0` is build infrastructure (`no_telemetry`). Success for `HF-NATIVE-1`: `hf_app_open` with `platform = android-app` and `service_name = hf-app`.

## Hello Fraands native app: identity checks (`[HF-NATIVE-8]`, `[HF-NATIVE-9]`, 2026-10-10)

Native Flutter app (`hf-flutter/`), same super properties as above (`platform = android-app`, `service_name = hf-app`). Aadhaar, selfie, payout and lane joins
call the same worker routes as the website (`/api/hosts/kyc/*`, `/api/hosts/payout/verify`, `/api/hf/lanes/*`). **Never in any prop:** Aadhaar number, name,
gender, bank details, the lane self-declaration (HF-PRIV-6, HF-KYC-2).

| Event | Props | Note |
|---|---|---|
| `hf_app_permission` | `kind: 'camera' \| 'mic'`, `result: 'granted' \| 'denied' \| 'error'` | One event per Android prompt, from the shared permission flow (selfie video; the part B voice step uses the same widget with `kind = mic`). `granted` = allowed, `denied` = the person said no (the "Open settings" panel shows), `error` = the prompt or camera failed (no camera, camera in use). Same event name as the Capacitor app: filter by `service_name = hf-app`. **Success value:** `result = granted` for `kind = camera` and `kind = mic` during the owner's test host sign-up on a phone. |
| `hf_app_kyc_step` | `step`, `result`, `reason?`, `status?` | `step`: `aadhaar_otp`, `aadhaar_verify`, `digilocker_start`, `digilocker_complete`, `selfie_code`, `selfie_upload`, `payout_verify`. `result`: `sent`, `ok`, `already_verified`, `started`, `pending` (DigiLocker 202, polled every 3 s), `wrong_code`, `fallback` (the worker said `fallback: digilocker`, the app switched), `mismatch` (payout name differs), `error`. Failures carry `reason` (the worker error code, for example `otp_unavailable`, `code_expired`, `too_large`) and `status` (HTTP). **Success value:** `step = aadhaar_verify` or `digilocker_complete` with `result = ok`, then `step = selfie_upload` with `result = ok`, then `step = payout_verify` with `result = ok`. |
| `hf_app_lane_join` | `lane: 'women' \| 'lgbtq'`, `result`, `reason?`, `status?` | `result`: `joined`, `not_eligible` (women space and Aadhaar is not female or transgender, `reason` = `aadhaar_record` or the worker code), `aadhaar_required`, `error` (any other failure, `reason` = worker code). **Success value:** `result = joined` for `lane = women` from a test account whose Aadhaar shows female, and for `lane = lgbtq`. |

### Ship manifest note

Success for `HF-NATIVE-8`: `hf_app_lane_join` with `result = joined`. Success for `HF-NATIVE-9`: `hf_app_kyc_step` with `step = payout_verify` and `result = ok`
(the last of the identity steps part A owns). Both need a phone with the native build; the Aadhaar OTP and DigiLocker run against the live vendor.

## Hello Fraands native app: push and links (`[HF-NATIVE-7]`, `hf-flutter/lib/features/push/`, 2026-10-10)

Same super properties as the native section above (`platform = android-app`, `service_name = hf-app`). Same event names as the Capacitor app's push events
(section `[HF-APP-4]`): filter by `service_name`. Behind `hfPushEnabled` for the opt-in sheet; the token is registered while the flag is off, as the worker allows.

| Event | Props | Note |
|---|---|---|
| `hf_app_permission` | `kind: 'push'`, `result: 'granted' \| 'denied' \| 'dismissed'` | `granted` / `denied` = the answer of the Android 13+ notification prompt, shown only after Allow on our sheet. `dismissed` = Not now (or a swipe down or Back) on the sheet; the Android prompt was not shown. Re-asked 14 days later. **Success value:** `result = granted` on the owner's phone. |
| `hf_push_registered` | `outcome: 'ok' \| 'failed'`, `reason?`, `status?`, `ms`, `shell_version` | `POST /api/hf/push/register` after sign-in (quietly, when notifications are already allowed), after Allow, and on every FCM token refresh. `shell_version` is `native-<versionCode>`. `reason`: `no_token` (Firebase gave none), the worker's error code, or `error`. |
| `hf_push_opened` | `kind: 'notify_me' \| 'host_approved' \| 'host_changes' \| 'withdrawal_approved' \| 'withdrawal_paid' \| 'low_balance' \| 'review_request' \| 'other'` | The person tapped a notification (app closed or in the background) or tapped Open on the in-app banner. Followed by `hf_app_deeplink_opened` with `source = push`. **Success value:** arrives for each kind; the shipped proof is `kind = notify_me`. |
| `hf_app_push_opened` | `path`, `state: 'cold' \| 'background' \| 'foreground'` | **Native app only** (`[HF-BOOK-APPROVE-PUSH]`, `lib/data/push.dart` + `DeepLinks.openPush`). A push notification was tapped. `cold` = the tap started the app (`getInitialMessage`), `background` = the app was running behind (`onMessageOpenedApp`), `foreground` = OPEN on the in-app banner (a push arriving with the app open is not counted until OPEN is tapped). `path` is the payload `path` anonymised like `hf_app_deeplink_opened` (`/bookings/:id`, `/inf/bookings`, `/inf/availability`), or `/unmapped` when the app has no screen for it. Followed by `hf_app_deeplink_opened` with `source = push`. **Success value:** `state = cold` with `path = /bookings/:id` after tapping a booking-request push on a phone with the new build. |
| `hf_app_deeplink_opened` | `path`, `source: 'push'`, `launch: 'cold' \| 'warm'` | Same event as the native links section: `cold` = the push or link started the app (held until the splash finished), `warm` = the app was running. The path is anonymised (`/h/:id`, `/review/:id`). |

Errors (`captureException`, `handled`): `where: 'hf_push_permission' \| 'hf_push_register'`.

### Ship manifest note

Success for `HF-NATIVE-7`: `hf_push_opened` with `kind = notify_me`. It needs a phone with the native build, `HF_GOOGLE_SERVICES_JSON` in the repository secrets (the build is silent about push without it) and `hfPushEnabled` on.

## Hello Fraands native app: Host dashboard (`[HF-NATIVE-11]`, 2026-10-10)

Native Host tab (`hf-flutter/lib/features/host_dashboard/`), same super properties as the rest of the native app (`platform = android-app`, `service_name = hf-app`). Hosts see rupees only; no amount of tokens, bank detail, UTR, caller handle or id rides on any of these events.

| Event | Props | Note |
|---|---|---|
| `hf_app_host_dashboard_viewed` | `status: 'none' \| 'draft' \| 'generating' \| 'pending_host' \| 'pending_review' \| 'submitted' \| 'live' \| 'rejected' \| 'paused'` | Once per opening of the Host tab, when `GET /api/hosts/me` answered. `none` = the person has no host profile yet (the Become a host panel shows). **Success value:** `status = live` from the owner's test host. |
| `hf_app_host_presence` | `online: boolean`, `outcome: 'ok' \| 'error'`, `reason?`, `status?` | The big switch was tapped and `PUT /api/hosts/me/presence` answered. `online` is what the host asked for. On error `reason` is the worker code (`not_live`, `not_verified`, `account_closing`, `network`, ...) and `status` the HTTP status. The 5-minute heartbeat (`POST /api/hosts/me/presence/beat`, only while online AND the app is in the foreground) sends no event of its own. **Success value:** `online = true` with `outcome = ok`, then the host appears as Online now to a caller. |
| `hf_app_payout_requested` | `amount_rupees: number`, `outcome: 'ok' \| 'error'`, `reason?`, `status?` | A withdrawal was requested (`POST /api/hosts/me/payouts`, whole rupees, minimum Rs 500). On error `reason` is the worker code (`below_minimum`, `weekly_limit`, `insufficient_withdrawable`, `kyc_required`, `bank_required`, `not_live`, `wallet_error`, `network`, ...). The server also sends its own `hf_payout_requested`. **Success value:** `outcome = ok` for the owner's first withdrawal. |

### Ship manifest note

`HF-NATIVE-11` is one-sided (one phone). Success: `hf_app_host_presence` with `online = true` and `outcome = ok`, and `hf_app_payout_requested` with `outcome = ok` once Rs 500 has cleared the 7-day hold.
## Hello Fraands native app: Me, settings, delete account and update prompts (`[HF-NATIVE-12]`, 2026-10-10)

Native Flutter app (`hf-flutter/`), same super properties as above (`platform = android-app`, `service_name = hf-app`). **Never in any prop:** the name,
the phone number, an amount of money or a token count.

| Event | Props | Note |
|---|---|---|
| `hf_app_me_viewed` | `signed_in: boolean` | The Me tab was opened (once per process, the tab keeps its state afterwards). **Success value:** arrives with `platform = android-app` and `signed_in = true` after opening Me on the native build. |
| `hf_app_name_updated` | `outcome: 'ok' \| 'failed'`, `reason?`, `status?` | The name sheet saved (`PATCH /api/hf/me`). `failed`: `reason` is the worker code (`invalid_field` for a name with numbers, a phone number or a link, `rate_limited`, `network`, ...) or `empty` (refused on the phone, no request sent), `status` the HTTP status. |
| `hf_app_account_delete_started` | `decision: 'delete' \| 'exit'` | The person ticked the box and confirmed on the delete screen. `decision` is what `GET /api/hf/account/exit` said: `delete` = nothing to settle, `exit` = unused purchased tokens are refunded through Google Play and host earnings are paid out first. |
| `hf_app_account_delete_result` | `decision`, `outcome: 'ok' \| 'deferred' \| 'failed'`, `reason?`, `status?` | How the confirmed step ended. `ok` = the 30-day deletion was scheduled (`delete`) or the closing started (`exit`). `deferred` = `POST /api/account/delete` answered 409 `deferred` and the screen switched to the settle path. `failed`: `reason` is the worker code (`active_call`, `forfeit_required`, `bank_required`, `nothing_to_settle`, `try_again`, `network`, ...). |
| `hf_app_update_prompt` | `kind: 'soft' \| 'forced'`, `action: 'shown' \| 'update_tapped' \| 'dismissed'`, `installed` | The update banner (`soft`, installed build below `hfAppLatestBuild`) or the blocking screen (`forced`, below `hfAppMinBuild`). `shown` once per process and kind, `update_tapped` = the Update button opened the Play Store, `dismissed` = Not now on the banner (the blocking screen has no such button). `installed` is the build number. **Success value:** after the owner sets `hfAppLatestBuild` above the installed build, `kind = soft`, `action = shown` arrives. |

Success for `HF-NATIVE-12`: `hf_app_me_viewed` with `platform = android-app`.


## Hello Fraands native app: host onboarding part B (`[HF-NATIVE-10]`, `hf-flutter/lib/features/host_onboarding/part_b/`, 2026-10-10)

Avatar, about, languages, topics, price, hours, voice introduction, review, profile making, preview and submit. Same super properties as the rest of the native app (`platform = android-app`, `service_name = hf-app`). Nothing the host typed (name, about text, tagline, transcript) and no audio ever rides on these events.

| Event | Props | Note |
|---|---|---|
| `hf_app_onboarding_step` | `step: 'avatar' \| 'about' \| 'languages' \| 'topics' \| 'price' \| 'hours' \| 'voice' \| 'review' \| 'generating' \| 'preview'`, `result: 'ok' \| 'saved' \| 'claimed' \| 'taken' \| 'started' \| 'done' \| 'failed' \| 'submitted' \| 'blocked' \| 'error'`, `reason?`, `status?` | One per finished step action. `ok` = Continue after the fields saved; `claimed` / `taken` = avatar claim; `saved` = voice upload accepted or a tagline / quote / about edit saved; `started` / `done` / `failed` = the profile job; `submitted` = sent for review; `blocked` = the phone refused a recording (`reason = too_short` or `too_long`) before uploading. On `error` and `failed`, `reason` is the worker code (`invalid_field`, `locked`, `profile_incomplete`, `attempts_exhausted`, `incomplete`, `network`, ...) and `status` the HTTP status. |
| `hf_app_voice_recorded` | `seconds: number` | The worker accepted the voice introduction (`PUT /api/hosts/me/voice`, 30 to 300 seconds). Only the length. |
| `hf_app_host_submitted` | none | `POST /api/hosts/submit` answered ok: the profile is now with the team. |

### Ship manifest note

`HF-NATIVE-10` is one-sided (one phone). Success: `hf_app_host_submitted` arrives, and `hf_app_voice_recorded` with `seconds` between 30 and 300.


### HF native redesign — HF-NATIVE-REDESIGN-1

The native redesign retains the existing auth, wallet, call, host, KYC, notification and account events.
`hf_app_registration_step` adds the account-name chapter with `step=name` and
`outcome=viewed|completed|cancelled`; failures of the name API remain `hf_app_name_updated`
with the existing outcome/reason/status properties. No typed name, OTP, Aadhaar data, private declaration
or video content is included. Account UID, known email and phone come from the existing analytics base.

Consent and incomplete registration are scoped to the signed-in account. Cancelling or switching accounts
clears the pending action; resuming registration does not start a call, purchase or notification subscription.
LGBTQ+ declaration can be saved while video review is pending. `hf_app_lane_join` result=joined
means access was granted; pending/rejected review is a separate UI state and never evidence of access.
Latest review status controls protected listings, explicit-lane profiles and direct calls server-side.

Release review must cover guest Browse, existing login, new registration and cancellation, zero-balance
call/top-up return, protected-space pending/rejected/approved video, host KYC reuse, payouts and
account switching. The real-font layout matrix includes 320×640 and 412×915 at normal and 2× text
and reduced motion. These checks are prepared; source review is not executed device telemetry.

## Hello Fraands host offline reminder (`[HF-PRESENCE-NUDGE-1]`, worker cron, 2026-10-11)

Server events (`app_name = hello-fraands` brand slug, `service_name` as every worker event). Never in any prop: the name or the phone number.

| Event | Props | Note |
|---|---|---|
| `hf_presence_nudge_sent` | `area: 'hf_presence_nudge'`, `outcome: 'ok' \| 'skipped' \| 'failed'`, `reason` | One per host per reminder attempt, from the 5-minute cron (flag `hfPresenceNudgeEnabled`). `ok`: `reason` = `whatsapp`, `push` or `whatsapp_push` (what was delivered). `skipped`: `no_verified_whatsapp`, `not_on_whatsapp`, `unconfigured` or `account_closing` (nothing delivered, next try in 3 h). `failed`: `provider_error`, `rate_limited` or `exception` (the slot is handed back, the next tick retries). **Success value:** `outcome = ok`. |
| `hf_presence_nudge_paused` | `area`, `paused: boolean` | The host paused or resumed the reminders (`PUT /api/hosts/me/presence/nudges`). |

## Hello Fraands saved hosts (`[HF-DASH-FRAANDS-1]`, web, 2026-10-14)

Web events (flag `hfFavouritesEnabled`). Never in any prop: the person's name, phone number or uid.

| Event | Props | Note |
|---|---|---|
| `hf_favourite_toggle` | `host_slug`, `on: boolean`, `surface: 'profile' \| 'explore' \| 'dashboard'` | A signed-in person saved (`on = true`) or removed (`on = false`) a host with the heart, only after the server confirmed. **Success value:** `on = true`. |
| `$exception` | `area: 'hf_favourites'`, `step: 'save' \| 'unsave' \| 'list'`, `status`, `host_slug` | Saving, removing or listing failed (the heart rolls back). |

## Hello Fraands dashboard Overview summary (`[HF-DASH-SUMMARY-1]`, web + worker, 2026-10-14)

| Event | Props | Note |
|---|---|---|
| `hf_dash_summary_load` | `ms` (load time), `parts_failed` (numbers this role shows that came back empty), `role: 'host' \| 'customer'` | Web, once per Overview summary load (on open and on each 60 s refresh for live hosts). **Success value:** `parts_failed = 0`. |
| `$exception` (web) | `area: 'hf_dash_summary'`, `status` | The whole summary call failed; tiles show a dash and a Retry. |
| `$exception` (worker) | `extra.area: 'hf_dash_summary'`, `extra.part` (`role`, `calls_made`, `calls_received`, `appointments`, `expected`, `fraands_saved`, `fraands_new`, `recent_made`) | One part of `GET /api/hf/me/summary` could not be read; it is returned as null and the answer is still 200. `fraands_saved` fails until the favourites table exists. |

## Hello Fraands dashboard Calls screen (`[HF-DASH-CALLS-1]`, web, 2026-10-14)

| Event | Props | Note |
|---|---|---|
| `hf_calls_list_load` | `role: 'caller' \| 'host'`, `status: 'all' \| 'completed' \| 'missed'`, `count`, `ms` | One per page of calls loaded in the dashboard Calls screen (first load, tab or filter change, Load more). **Success value:** `count >= 0` with the event present. Failures go through `captureException` with `area: 'hf_dashboard'`, `step: 'calls_list'`. |


## Hello Fraands new customer dashboard (`[HF-DASH-V3-1]`, web + worker, 2026-10-16)

| Event | Props | Note |
|---|---|---|
| `hf_dash_view` | `section`, `role` | Unchanged: one per dashboard screen shown (DashboardApp). The ship-manifest success event. |
| `hf_dash_summary_load` | `ms`, `parts_failed`, `role`, `surface: 'dash_v3'` | Now emitted by the shared dashboard data load (every screen), not only the Overview. |
| `hf_calls_list_load` | `role`, `status`, `count`, `surface: 'dash_v3'` | Calls screen page loaded. |
| `hf_dash3_cta` | `cta` | A hero button (e.g. `find_someone`). |
| `hf_dash3_bell_open` | – | Notifications bell opened. |
| `hf_dash3_signout` | – | "Haan, sign out" pressed in the sign-out dialog. |
| `hf_dash3_call_open` | `role` | A call's detail sheet opened from Calls. |
| `hf_dash3_review_sent` | `stars` | Rating sent from the dashboard (POST /api/hf/calls/:id/review). |
| `hf_dash3_topup_start` / `hf_dash3_topup_credited` | `amount` (rupees) | Add money started / confirmed credited on the Wallet screen. |
| `hf_dash3_refund_requested` | – | Refund requested from the Wallet screen. |
| `hf_dash3_profile_saved` | `strength` | Profile saved. |
| `hf_dash3_notify_pref` | `on` | "Notify me on WhatsApp" switch changed. |
| `hf_dash3_appt_open` | `status` | An appointment opened from My appointments. |
| `hf_dash3_become_start` | `step` | "Start now / Continue" on Become an influencer. |
| `hf_dash3_ticket_sent` | `topic` | Support question sent. |
| `hf_dash3_close_started` | `with_money` | Close-account confirmed. |
| `$exception` (web) | `area: 'hf_dash_v3'`, `part` or `step` | A dashboard data part or the calls list failed. |
| worker `hf_dash_profile_saved` | `fields` | PUT /api/hf/me/profile. |
| worker `hf_dash_prefs_saved` | `notify_whatsapp` | PUT /api/hf/me/prefs. |
| worker `hf_dash_block` | `reason`, `call_id` | Block & report from a call (also an `hf_incidents` row `dash_report:<reason>`). |
| worker `hf_dash_unblock` | – | Unblocked from Profile. |
| worker `hf_dash_ticket_created` | `topic`, `ticket_id` | Support question stored and emailed to the support inbox. |
| worker `$exception` | `extra.area: 'hf_dash_v3'`, `extra.step` | Any failure in routes/hf_dash_v3.ts. |

## Hello Fraands appointment reminders (`[HF-APPT-REMIND-1]`, worker + web, 2026-10-16)

| Event | Props | Note |
|---|---|---|
| worker `hf_booking_reminder_queued` | `booking_id`, `role: 'customer' \| 'host'`, `window: 't60' \| 't10'`, `channel: 'whatsapp'` | A reminder joined the WhatsApp outbox (the drain then sends it, or cancels it as `ineligible_before_send` if the booking changed). |
| worker `hf_push_sent` | `kind: 'booking_reminder'` | The app push that goes with it, when push is on. |
| worker `hf_dash_prefs_saved` | `notify_whatsapp`, `appt_reminders` | Dashboard notification switches saved. |
| web `hf_dash3_notify_pref` | `key: 'notifyWhatsapp' \| 'apptReminders'`, `on` | A switch changed on Profile → Notifications. |
| worker `$exception` | `extra.area: 'hf_booking_reminders'`, `booking_id`, `window` | One booking failed to queue (others continue). |

## Hello Fraands booking approval (`[HF-BOOK-APPROVE-BE]`, worker, 2026-10-20)

| Event | Props | Note |
|---|---|---|
| worker `hf_booking_requested` | `booking_id`, `mode: 'manual' \| 'auto'`, `amount_paise`, `topic` | A fan booked; manual bookings wait for the influencer. |
| worker `hf_booking_accepted` | `booking_id` | The influencer accepted (or auto mode confirmed). |
| worker `hf_booking_declined` | `booking_id`, `refund_paise` | Declined; the hold went back to the wallet. |
| worker `hf_booking_expired_refunded` | `booking_id`, `amount_paise` | Not accepted in time; refunded in full. |
| worker `hf_booking_msg_sent` | `event`, `channel: 'push' \| 'whatsapp' \| 'email'`, `result`, `booking_id` | One approval message attempted on one channel. |
| worker `hf_booking_mode_changed` | `from`, `to` | Influencer switched Manual or Auto. |
| worker `hf_open_alert_sent` | `channel`, `result`, `date`, `start_min` | An open-window alert went to the influencer. |
| worker `$exception` | `extra.area: 'hf_booking_approval' \| 'hf_open_alerts'` | A step failed; others continue. |

## Hello Fraands influencer Channels (`[HF-WIRE-3]`, worker + Flutter app, 2026-10-19)

| Event | Props | Note |
|---|---|---|
| worker `hf_channel_added` | `platform`, `ok`, `followers`, `consent_version`, `code` (on failure: `provider_not_configured`, `provider_unavailable`, `channel_claimed`) | POST /api/hf/channels. |
| worker `hf_channel_check` | `platform`, `action: 'check' \| 'resync'`, `ok`, `result`, `followers`, `qualified` | Check / resync of one channel. |
| worker `hf_channel_removed` | `platform` | DELETE /api/hf/channels/:id. |
| worker `$exception` | `extra.area: 'hf_channels'` | Any failure in routes/hf_channels.ts. |
| app `hf_channels_open` / `hf_channel_add_start` / `hf_channel_check_tap` | `platform`, `state` | Screens in Settings -> Channels and Join. |

## Hello Fraands native app: hardening (`[HF-WIRE-12]`, `hf-flutter/lib/data/telemetry.dart`, 2026-10-19)

Events go to PostHog (EU, project 139917) only in builds made with `--dart-define=HF_POSTHOG_KEY=<key>` (CI secret `HF_POSTHOG_KEY`; host override `HF_POSTHOG_HOST`). With no key the events stay on the debug console. The visitor is anonymous: no `identify()`, no person profile, no lifecycle auto-events. The app sends **only** the names in `Telemetry.catalogEvents` (same list as this section); everything else is dropped. Properties are scrubbed: keys containing phone, mobile, whatsapp, email, token, otp, secret, plus `name`, `uid`, `vpa`, `upi`, `utr`, `address`, `bio`, `message`, `note`, `caption`, and any value that looks like an email or a 10+ digit number, never leave the phone. Super properties added to every event: `platform: 'android-app'`, `service_name: 'hf-app'`, `app`, `release` (git SHA).

| Event | Props | Note |
|---|---|---|
| `app_crash` | `source: 'flutter' \| 'platform' \| 'zone'`, `fatal: boolean`, `error_type`, `library` (flutter source only), `stack_top` (first 6 stack lines) | Uncaught error: `FlutterError.onError` (`flutter`), `PlatformDispatcher.onError` (`platform`), `runZonedGuarded` (`zone`). The error MESSAGE is never sent (it can hold typed text). De-duplicated per run (same error type + top frame) and capped at 10 per run. **Success value:** arrives with `platform = android-app` after a forced error on a test build. |
| `hf_signup_code_sent` | none | `[HF-WIRE-2]` The WhatsApp code request was accepted (`POST /api/auth/whatsapp/send` answered 200). |
| `hf_reel_action` | `action: info/book/save/unsave`, `platform?` | Reel controls, no personal data. |
| `hf_reel_start` | `platform`, `ms`, `warmed: boolean`, `source?: 'intro'` | `[HF-INTRO-A2]` A reel started playing (ms from on screen to playing). `source: 'intro'` = an approved intro video. No personal data. |
| `hf_reel_share` | `source: 'intro'` | `[HF-INTRO-A2]` Share tapped on an intro reel (the link plays the video). |
| `hf_social_link_open` | `platform: youtube/instagram/facebook`, `surface: overlay/sheet` | `[HF-INTRO-A2]` A verified social icon (or Open in the ⓘ sheet) opened that account inside the app. |
| `hf_women_gate` | `result: blocked_aadhaar/blocked_female_only/allowed/verify_now/not_now/verified/verify_incomplete` | `[HF-INTRO-A2]` The Women-to-Women pop-up on Call / Join queue / Book. Never carries the gender. |
| `reel_profile_tap` | `source: rail/callbar`, `kind: network/invite` | `[HF-REEL-CALL-2]` The influencer's photo (rail) or the Call bar on a reel opened that creator's profile. No personal data. |
| `reel_deeplink_open` | `reel_id`, `cached: boolean` | `[HF-REEL-CALL-2]` A shared reel link (`/r/<id>`) opened the Reels tab on that reel; `cached` = the reel was already held locally (poster shown at once) rather than fetched. |
| `hf_reel_bookmark_sync` | `outcome: synced/pending/rejected`, `reason?` | Account-scoped local bookmark sync outcome. |
| `hf_intro_decision` | decision and reason | Onboarding routing outcome, no personal data. |
| `hf_auth_entry` | entry mode | Login or account creation entry, no personal data. |
| `hf_auth_outcome` | outcome | Authentication result, no personal data. |
| `hf_signup_verified` | `is_new: boolean` | `[HF-WIRE-2]` The code was right and a session is active. |
| `hf_signup_age_confirmed` | none | `[HF-WIRE-2]` The person confirmed 18+ (`POST /api/hf/me/ack` answered). |
| `hf_topup_started` | `amount_rupees` | `[HF-WIRE-6]` A top-up order was created and the payment page opened. |
| `hf_topup_result` | `result: 'paid' \| 'failed' \| 'slow' \| 'native_refused' \| 'hosted_<completed\|failed\|unavailable\|notEnabled>'`, `ms` (poll results only), `method`, `reason`, `detail` (provider error text, ≤120 chars, on `native_refused`) | `[HF-WIRE-6]` What the app saw when it polled the order. `paid` = the server confirmed the credit; the payment provider's signed webhook is the only thing that adds money. `[HF-CHECKOUT-FALLBACK-1]` `native_refused` = our own UPI app / UPI ID / card screen was refused by the provider, so the provider's secure checkout opened instead; `hosted_*` is how that ended. |
| `hf_channels_open` / `hf_channel_add_start` / `hf_channel_check_tap` | `platform` | `[HF-WIRE-3]` Already listed in the Channels section above. |
| `hf_app_call_confirm_viewed` / `hf_app_call_started` / `hf_app_call_status` / `hf_app_call_ended` / `hf_app_call_cancelled` / `hf_app_call_cap_warning` / `hf_app_review_submitted` | see the native calls section | `[HF-WIRE-7]` Same events as the native calls section above. |

## Hello Fraands admin desk actions (`[HF-ADMIN-COMPLETE-1]`, worker `routes/hf_admin_desk_actions.ts` + `routes/hf_money_audit.ts`, 2026-10-23)

| Event | Properties | Meaning |
|---|---|---|
| `hf_admin_action` | `kind: ticket/report/incident/member/money`, `verb: note/resolve/reopen/reviewed/actioned/closed/open/reply_email/reply_whatsapp`, `target_id`, `status?`, `channel?`, `audited: boolean`, `result?` (only when a reply failed: `no_email`, `no_whatsapp`, `email_failed`, `whatsapp_<reason>`) | An admin acted on a support question, a report, a call incident, a member or a money alert from the desk. Every success also writes an `hf_admin_actions` row and an `admin_audit` row (`audited:false` = the audit insert failed and a `$exception` with `step: admin_audit` was logged). |
| worker `$exception` | `extra.area: 'hf_admin_desk_actions'` (`step: wallet` / `admin_audit`) | Any failure in the member page, wallets list or desk actions. |
## Hello Fraands influencer merch shop (`[HF-MERCH-CORE-1]`, worker, 2026-10-23)

Every server event carries the user's email (`trackUser`). Failures go through `trackException` with `extra.area: 'hf_merch'` and a `route`.

| Event | Props | Note |
|---|---|---|
| worker `merch_art_uploaded` | `design_id`, `w`, `h`, `bytes`, `moderation: 'ok' \| 'unscanned'` | Influencer art accepted. |
| worker `merch_art_blocked` | `label`, `nsfw`, `violence` | Art refused by the image classifier. |
| worker `merch_studio_step` | `step: 'print_file'`, `design_id`, `w`, `h` | Print file saved. The web and app send the other steps. |
| worker `merch_product_created` | `product_id`, `catalog_id`, `kind`, `side`, `markup_rupees`, `status`, `moderation`, `sizes`, `colours` | Influencer made a product. |
| worker `merch_product_reviewed` | `product_id`, `seller_uid`, `decision: approve/reject/hide`, `has_note` | Admin review. User is the admin. |
| worker `merch_checkout_started` | `order_id`, `product_id`, `seller_uid`, `method`, `total_paise`, `qty` | Order row created. |
| worker `merch_bag_checkout_started` | `group_id`, `lines`, `sellers`, `method`, `total_paise` | [HF-CHANNEL-CORE-1] Bag order rows created (one `merch_checkout_started` per line also carries `group_id`). |
| worker `merch_bag_paid` | `group_id`, `orders`, `method`, `total_paise` | [HF-CHANNEL-CORE-1] Wallet bag fully charged and every order confirmed. **Success value:** exists `total_paise` after the first real bag. (Cashfree bags emit `merch_order_paid` per order when the gateway confirms.) |
| worker `merch_bag_rolled_back` | `group_id`, `reason: insufficient_balance/debt/conflict/…`, `orders`, `failed_order_id?` | [HF-CHANNEL-CORE-1] A wallet bag could not be charged in full: earlier charges given back and every order cancelled. Failure value if frequent. |
| worker `host_profile_photo_uploaded` | `bytes`, `width`, `height`, `mime`, `host_status` | [HF-CHANNEL-CORE-1] Influencer saved their own profile photo (`PUT /api/hosts/me/photo`). User is the influencer. |
| worker `host_profile_photo_rejected` | `reason: bad_type/too_big/too_small` | [HF-CHANNEL-CORE-1] The upload failed validation. Server errors go to `$exception` (`route: /api/hosts/me/photo`). |
| worker `merch_order_paid` | `order_id`, `seller_uid`, `method`, `total_paise`, `qty`, `influencer_paise`, `platform_paise` | Payment confirmed (wallet or Cashfree). **Success value:** exists `total_paise` after the first real order. |
| worker `merch_auto_approve_skipped` | `order_id`, `error` | Auto-approve was on but the order was left for a person (for example `cost_rose`). |
| worker `merch_order_approved` | `order_id`, `seller_uid`, `buyer_uid`, `auto`, `platform_net_after_paise`, `quote_stale` | Admin (or auto) approval. |
| worker `merch_cost_rose` | `order_id`, `rise_paise`, `platform_net_after_paise`, `frozen_base_unit_paise`, `live_base_unit_paise` | Approval refused because the print cost went up. |
| worker `merch_order_rejected` | `order_id`, `seller_uid`, `buyer_uid`, `reason`, `method`, `after_delivery` | Rejected or refunded. |
| worker `merch_order_shipped` | `order_id`, `seller_uid`, `buyer_uid`, `courier`, `source` | Tracking set by admin. |
| worker `merch_order_delivered` | `order_id`, `buyer_uid`, `actor`, `earning: credited/duplicate/skipped` | Delivered (partner poll or admin). User is the influencer. |
| worker `merch_earning_credited` | `order_id`, `earning_paise`, `available_at`, `hold_days` | Delivered order credited to the influencer, once. |
| worker `merch_problem_reported` | `order_id`, `kind`, `has_photo` | Fan reported a wrong or damaged item. |
| web/app `merch_strip_viewed` / `merch_product_viewed` / `merch_buy_clicked` / `merch_pay_method_chosen` / `merch_order_opened` | surface props | Sent by the web and app packages, not the worker. |

### Channel page + Bag (`[HF-CHANNEL-WEB-1]`, web, 2026-10-23)

Spec: `.agent-wt/SPEC-HF-CHANNEL.md` (web section). Sent by the web package, not the worker. The app lane (HF-CHANNEL-APP-1) reuses the same names with `surface: app`.

| Event | Properties | Meaning |
|---|---|---|
| web `channel_viewed` | `host_slug`, `merch_count`, `reels_count`, `call_eligible`, `status`, `utm_medium` | The rebuilt `/h/<slug>` channel page was opened. |
| web `merch_filter_used` | `host_slug`, `category` (`all` or a category slug), `count` | A category chip was pressed in the Merch section. |
| web `merch_page_changed` | `host_slug`, `page`, `category`, `mode` (only `show_more` on phones) | The merch pager (or phone "Show more") was used. |
| web `bag_added` | `source` (`quick`/`product`), `host_slug`, `product_id`, `category`, `qty`, `price_paise`, `via` (product page only: `add`/`buy`) | An item went into the Bag (merch tile "+ Add", or Add to bag / Buy now on the product page). |
| web `bag_viewed` | `lines`, `items` | The `/bag` page was opened. |
| web `bag_checkout_started` | `source` (`drawer`/`bag`/`checkout`), `method` (checkout only), `lines`, `items`, `total_paise` | Checkout pressed in the drawer or on the bag page; on the checkout page it fires when Pay is pressed (with `method`). |
| web `bag_paid` | `group_id`, `method` (`wallet`/`online`), `orders`, `total_paise`, `source` (`return_url` for online) | The Bag was paid: wallet at once, online when the buyer returns to `/dashboard/orders?group=`. Server truth is `merch_order_paid`. |
| web `channel_video_played` | `host_slug`, `platform`, `reel_id`, `surface` (`featured`/`row`) | A video or reel was played inline in "Now Showing". |
| web `channel_slot_requested` | `host_slug`, `date`, `duration_minutes`, `price_paise` | "Request this slot" pressed in the inline booking calendar (hands off to `/bookings`). |
| web `merch_checkout_step` / `merch_checkout_failed` / `merch_pay_method_chosen` | as for single-item checkout plus `surface: bag` | Same events as the retired single-item sheet, now sent by the Bag checkout. |
| web `merch_product_viewed` / `merch_buy_clicked` / `merch_pincode_checked` | unchanged | Now sent by the rebuilt product page. |

## Hello Fraands call modes, queue, chunk billing and booking lengths (`[HF-CALL-MODES-A..E2]`, worker + web + app, 2026-10-23)

Spec: `Specs/SPEC-2026-10-23-HF-CALL-MODES-QUEUE.md` section 2.8. All dark behind `hfCallModesEnabled`, `hfCallQueueEnabled`, `hfCallChunkBillingEnabled`, `hfBookingLengthsEnabled`. Server events use `track(env, uid, event, HF_CALL_APP, props)` (the `uid` is the person named in the Meaning column); the call events from the Durable Object carry `call_id`. Failures use `trackException` with `extra.area` of `hf_host_mode` or `hf_queue`.

### Worker

| Event | Properties | Meaning |
|---|---|---|
| `hf_host_mode_changed` | `area: 'hf_call'`, `from`, `to` (`online`/`bookings_only`/`offline`), `surface: 'web'/'app'/'legacy'/'unknown'` | The influencer changed her mode. `legacy` = a shipped app that still sends `{online:boolean}`. Only fires when the mode really changed. User is the influencer. |
| `hf_host_on_call` | `area: 'hf_call'`, `call_id`, `on: boolean` | `on_call_since` was set (both legs joined, `on:true`) or cleared (`on:false`). User is the influencer. |
| `hf_queue_joined` | `area: 'hf_queue'`, `host_uid`, `position` | A fan joined a queue. User is the fan. |
| `hf_queue_left` | `area: 'hf_queue'`, `wait_s`, `expired?: true` | The fan left, or their wait passed `hfQueueMaxWaitMinutes` (`expired:true`). |
| `hf_queue_dispatched` | `area: 'hf_queue'`, `wait_s`, `position_at_join`, `call_id` | It was the fan's turn and the queued call was placed. **Success value:** `wait_s` median. |
| `hf_queue_skipped` | `area: 'hf_queue'`, `reason: 'fan_no_answer'/'low_balance'/'blocked'/'host_missed'/'host_offline'/'booking_conflict'` | A fan's turn was skipped. |
| `hf_queue_closed` | `area: 'hf_queue'`, `reason`, `waiting` | The whole queue was closed (she left Online, or the account is closing). User is the influencer. |
| `hf_queue_paused` | `area: 'hf_call'` or `'hf_queue'`, `paused: boolean`, `by: 'host'/'sweep'/...` | The queue was paused or resumed. |
| `hf_call_chunk_reserved` | `call_id`, `n`, `from_sec`, `covered_sec`, `paise`, `partial: boolean`, `funded_seconds`, `reason: 'chunk'/'retry'/'topup'` | Another 5-minute slice of a call was paid for from the wallet. `partial:true` = the wallet covered only part. User is the caller. |
| `hf_call_funds_short` | `call_id`, `funded_seconds`, `remaining_sec`, `chunk_n`, `reason` | The next slice could not be fully paid; the caller was told. |
| `hf_call_whisper` | `call_id`, `kind: 'low_funds'/'topped_up'/'one_minute'`, `via`, `ok: boolean` | A spoken message to the caller only. `via` says which Vobiz path carried it, `ok:false` = it was not delivered. |
| `hf_call_topup_extended` | `call_id`, `added_seconds`, `funded_seconds`, `reason` | A top-up while talking pushed the end of the call back. |
| `hf_call_ended` (additions) | `source?: 'instant'/'queue'/'booking'`, `funded_seconds?`, `chunks?` (the last two only for chunk-billed calls) | Added to the existing call-ended event. |
| `hf_booking_quote_created` (addition) | `hold_minutes` | Minutes held up front (15 for long bookings, or the whole call if shorter). |

### Web (PostHog `capture`, signed-in)

| Event | Properties | Meaning |
|---|---|---|
| `hf_web_mode_changed` | `from`, `to` | Influencer chose a mode on the dashboard (`HostModes.tsx`). |
| `hf_web_queue_paused` | `paused` | Influencer paused or resumed her queue on the dashboard. |
| `hf_web_queue_joined` | `host` (slug), `position`, `waiting` | A fan joined from the profile (`QueueSheet.tsx`). |
| `hf_web_queue_failed` | `host`, `code`, `status` | Join refused (`queue_closed`, `queue_full`, `already_queued`, `low_balance`, `not_verified`, ...). |
| `hf_web_queue_left` | `host`, `wait_s` | The fan left the queue. |
| `hf_web_booking_length_picked` | `host`, `minutes` | The fan picked a booking length (15 to 300). |
| `hf_web_topup_in_call` | `host` | The fan tapped Top up from the "balance ran out" note during a call. |

### App (`Telemetry.event`, `hf_app_` names are listed in `hf-flutter/lib/data/telemetry.dart`)

| Event | Properties | Meaning |
|---|---|---|
| `hf_app_mode_changed` | `from`, `to`, `surface: 'footer'/'home'` | Influencer picked a mode in the three-way sheet. |
| `hf_app_queue_joined` | `position` | A fan joined a queue. |
| `hf_app_queue_left` | `wait_s`, `reason: 'user'/'left'/'skipped'/'expired'/'closed'/'done'/'gone'` | The fan's queue ended; `user` = they tapped Leave. |
| `hf_app_queue_failed` | `reason` (server error code) | Join refused. |
| `hf_app_booking_length_picked` | `minutes` | Fan picked a booking length. |
| `hf_app_call_topup_tapped` | `surface: 'call'/'queue'`, `short?: boolean` | Top up tapped from the live call banner (`short` = the wallet could not fund the next slice) or from a low-balance queue refusal. |

### Ship manifest note

Each of the four flags must be on before its events appear. Events arrive only after the worker (A to D) is deployed with the flag, and after the web and app builds that carry E1/E2.

## Influencer profile photo (`[HF-CHANNEL-PHOTO-1]`, web dashboard, 2026-10-23)

| Event | Props | Note |
|---|---|---|
| `profile_photo_opened` | none | An influencer opened Dashboard > My public page > Profile photo. **Ship-manifest success event.** |
| `profile_photo_saved` | `bytes`, `zoom` | The cropped 1200x1500 JPEG was accepted by `PUT /api/hosts/me/photo`. |
| `profile_photo_failed` | `reason` (`bad_type`/`too_big`/`too_small`/`not_host`/`rate_limited`/`network`/`client`/...), `status` | The save failed; the person saw a plain-language message. |

## Host identity by WhatsApp OTP (`[HF-IDV-WHATSAPP-1]`, worker, 2026-10-24)

| Event | Props | Note |
|---|---|---|
| `hf_public_profile_served` | `slug`, `call_eligible`, `identity_verified`, `identity_method` (`whatsapp_otp`), `listing_status` | A public influencer profile was served (`GET /api/hosts/public/:slug`), distinct_id = the host uid. **Ship-manifest success event** (`call_eligible = true`). |
| `hf_host_identity_gate` | `identity_method`, `passed` (false) | Profile generation refused because the host's WhatsApp number is not OTP-verified. |
| `hf_host_generate_started` | + `identity_method` | Existing event; now records that WhatsApp OTP was the identity check. |

## App channel page parity with the web profile (`[HF-APP-CHANNEL-PARITY-1]`, hf-flutter app, 2026-10-24)

| Event | Props | Note |
|---|---|---|
| `channel_voice_intro_played` | `slug`, `surface` (`app`), `seconds` | A fan pressed play on the influencer's own voice introduction. **Ship-manifest success event.** |
| `channel_voice_intro_failed` | `slug`, `surface`, `error` | The intro could not play; the fan saw "Could not play the introduction". |
| `channel_viewed` | (existing) | Unchanged; the page now also shows reviews, facts, privacy line and the calls-unavailable state. |

### [HF-CHANNEL-MOBILE-1] Channel page on phones + "Find me on" social cards (2026-10-24)

| Event | Props | Note |
|---|---|---|
| web `channel_social_tap` | `host_slug`, `platform` (`instagram`/`youtube`/`facebook`/`tiktok`) | A fan tapped one of the influencer's social channel cards. **Ship-manifest success event.** |
| web `channel_viewed` | (existing) + `socials_count` | How many social cards the page showed. |

### [HF-VERIFIED-BLIP-1] Verified tick beside creator names (2026-10-25)

| Event | Props | Note |
|---|---|---|
| web + app `hf_verified_tick_shown` | `surface`, `level` (`kyc`/`channel`) | A verified tick was drawn beside a creator's name. Once per mount. **Ship-manifest success event.** |
| web + app `hf_verified_tick_tap` | `surface`, `level` | A fan opened "what we checked". |

## `[HF-SCROLL-HERO-1]` — homepage scroll film (2026-10-25)

Web only (`web/src/lib/scrollStoryHero.ts`). CTA clicks reuse `homepage_cta_click` with `cta` = `story-explore-top` / `story-explore-end` / `story-become-creator`.

| Event | Props | Meaning |
|---|---|---|
| `home_scroll_hero_impression` | `mode` (`live`/`static`), `layout` (`cover`/`phone`/`split`), `variant` (`large`/`small`), `reason` | The hero mounted. |
| `home_scroll_hero_ready` | `ms`, `layout`, `variant` | First film frame decoded (time from mount). |
| `home_scroll_hero_buffered` | `ms`, `variant` | Whole film now in memory; every seek is local. |
| `home_scroll_hero_scene` | `scene`, `index` (1–6), `layout` | A scene's message became fully visible (once per page view). Scene 6 = the visitor reached the end. |
| `home_scroll_hero_fallback` | `reason` (`video_error`, `metadata_timeout`, `reduced_motion_changed`) | Switched to the static version. |
| `$exception` | `surface: home-scroll-hero`, `step`/`reason` | Film or in-memory fetch failed. |
