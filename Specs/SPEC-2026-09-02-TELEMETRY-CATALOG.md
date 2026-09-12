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
| `platform` | `web` · `android` · `ios` · `macos` · `windows` · `linux` · `worker` | |
| `service_name` | `avatok-web` · `avatok-app` · `avatok-desktop` · `avatok-api` | |
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
