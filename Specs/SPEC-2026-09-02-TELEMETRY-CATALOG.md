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
`LiveStage.tsx`. All four carry the standard super-properties (`platform`,
`service_name`, `release`, `app`, `email`, `clerk_uid`, `trace_id`) via
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
