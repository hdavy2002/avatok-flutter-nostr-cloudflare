# PLAN 2026-10-20 - Hello Fraands speed on slow networks

Owner (2026-10-20): "every page loads when I go to it; on a slow network it will be frustrating - devise a strategy to speed up the entire app."

This file has one section per surface. The app section is below. The web admin section is added by another agent under `## Web admin`.

## App

Issue tag: `[HF-APP-CACHE-1]`. Code: `hf-flutter/lib/data/response_cache.dart`, `api_client.dart` (`watchJson`, `peekJson`, `getJson(store:)`), the repos' `watch*` methods, `lib/ui/net_image.dart`, `Services.prefetch()`.

### Progress tracker (so another AI can resume)

| Phase | What | Status |
|---|---|---|
| A1 | `ResponseCache` (memory + disk, per account, generation guard) and `ApiClient.watchJson/peekJson/getJson(store)` | done, unit tests in `test/data/response_cache_test.dart`, NOT compiled (no Flutter on the Mac) |
| A2 | Invalidate on every successful write call (in `ApiClient.request`) | done |
| A3 | Repos: `watch*` for me, config, wallet, slots, fan + host bookings, availability, favourites, search, topics, invites, public profile, reels first page | done |
| A4 | Screens wired: Me balance tag, Wallet, fan bookings, host bookings (+ today list), slots (book, confirm, profile calendar), availability, search landing/chips, Favourites | done |
| A5 | Boot: saved `/me` and `/api/config` applied before the network answers; `Services.prefetch()` warms the cache after `/me` | done |
| A6 | Images: `NetImage` (cached_network_image disk cache) for avatars, favourites, my reels, reel thumbnails | done (`screens/profile.dart` still uses `Image.network`, see A8) |
| A7 | Telemetry `hf_app_cache` (catalog row added) | done |
| A8 | NOT done, left for after the favourites/channel-profile work lands: `screens/profile.dart` (`reelsRepo.watchProfile` + `NetImage` for thumbnails), `screens/feed.dart` (`reelsRepo.watchFirstPage` for instant first reel page), skeleton placeholders instead of the spinner (`AsyncView` loading state), cached `callsRepo` history, `payoutsRepo.summary` | open |
| A9 | Phone test on a throttled network (airplane toggle, 2G profile): open Me, Wallet, Bookings, Search, Favourites twice; second open must paint with no spinner | open (Opus) |

### 1. Inventory of network calls and class

| Screen / caller | Endpoint | Class | Policy (fresh / max age) |
|---|---|---|---|
| Boot | `GET /api/config` (public) | static-ish | saved, 30 d; always re-asked at start (boot is capped by the splash) |
| Boot, Me tab, settings | `GET /api/hf/me` | static-ish, per account | saved 30 d at boot; `profile` policy when watched |
| Me tab balance tag | `GET /api/hf/app/wallet?limit=1` | money | `live`: paint saved, ALWAYS re-ask, max age 1 d |
| Wallet screen | `GET /api/hf/app/wallet?limit=20` | money | `live` |
| Wallet "load more" | `GET ...wallet?cursor=` | money | not cached |
| Top-up | `POST /api/hf/wallet/topup`, `GET .../topup/:id` | must-be-fresh | never cached |
| Book / confirm screens | `GET /api/hf/hosts/:slug/slots` (public) | semi-fresh | `slots`: fresh 20 s, max 6 h (booking still re-checks on the server, 409 = pick again) |
| Book confirm | `POST /api/hf/bookings` | money | never cached |
| Fan Bookings | `GET /api/hf/bookings?role=fan[&status=past]` | live list | `live` |
| Host Bookings (+ today) | `GET /api/hf/bookings?role=host&shape=app...` | live list | `live` |
| Host booking settings | `GET/PUT /api/hf/hosts/me/booking-settings` | small, rare | not cached |
| Availability | `GET /api/hf/hosts/me/availability` | per account | `live` (shows saved calendar, then the server's) |
| Rate | `GET/PUT /api/hf/hosts/me/rate` | small | not cached |
| Search landing and queries | `GET /api/hf/search` (public) | list | `list`: fresh 30 s, max 1 d |
| Topic chips | `GET /api/hf/options` (public) | static | `stable`: fresh 6 h, max 30 d |
| "Most wanted" invites | `GET /api/hf/invites/top` (public) | list | `list` |
| Favourites tab | `GET /api/hf/favourites` | per account | `live` |
| Public profile | `GET /api/hosts/public/:slug` | profile | `profile`: fresh 2 min, max 3 d (repo ready, screen is A8) |
| Reels feed first page | `GET /api/hf/reels?limit=` | list | `list` (repo ready, screen is A8); next pages never cached |
| My reels | `GET /api/hf/hosts/me/reels` | per account | not cached yet |
| Calls | `GET /api/hf/wallet/estimate`, `GET/POST /api/hf/calls/...` | must-be-fresh | never cached |
| Payouts | `GET /api/hf/payouts/summary`, `PUT upi`, `POST payouts` | money | not cached |
| Presence | `GET/PUT /api/hosts/me/presence`, online count, notify | must-be-fresh | not cached |
| Channels, settings prefs, account exit | various | rare | not cached |

### 2. Strategy: stale-while-revalidate in `ApiClient`

- `ApiClient.watchJson(path, policy:)` returns a `Stream`. It emits the saved answer first (if younger than `maxAge`), then the server's answer if it differs. If the saved answer is younger than `fresh`, it is the only emission (no request). If the network fails after a saved answer was shown, the error is swallowed. With nothing saved, the error is thrown exactly like `getJson`, so the "Try again" panel still works.
- One automatic retry (700 ms) on a momentary failure (offline, timeout, 5xx, unreadable reply). Refusals (4xx) are not retried. Two watchers of the same URL share one request.
- Screens call the repo's `watch*` inside `await for` and `setState` on every emission. First paint is instant on the second visit; the spinner only shows on the very first load of an account.
- `getJson(..., store: true)` writes through, so plain fetches (prefetch, retry buttons, pull to refresh) keep the cache warm.
- Disk: `shared_preferences`, key `hfc1|<scope>|<path?query>`, value `<epochMs>|<json>`, entries over 256 KB are skipped, entries older than 14 days are pruned at start.

### 3. Per-account scoping (privacy)

Every signed-in key is `hfc1|u:<Clerk user id>|...`; public reads are `hfc1|pub|...`. A signed-in read with no account id yet is never cached. `Services.signOut()` and `_sessionLost()` call `cache.clearAccount(id)`, so the next person on a shared phone sees nothing of the previous one. (The avaTOK `scopedKey` helper lives in the other Flutter app; hf-flutter has no `AccountScope`, so the Clerk id is the scope.)

### 4. Invalidation

- Every successful write call (`POST/PUT/PATCH/DELETE`) in `ApiClient.request` runs `cache.invalidateAfterWrite()`: everything is deleted EXCEPT public slow-changing data (`/api/config`, `/api/hf/options`, `/api/hf/reels`, `/api/hf/search`, `/api/hf/invites/top`). That covers book, cancel, accept, decline, top-up, payout, availability save, rate save, presence toggle, favourite add/remove, profile edit, call start/end. Counting a reel view (`.../view`) does not invalidate. A failed write does not invalidate.
- Race guard: `ResponseCache.generation` bumps on every invalidation; a read that STARTED before a write is not stored after it.
- Money is never shown from the cache alone: the wallet and bookings use `CachePolicy.live` (no fresh window), so every visit re-asks the server, and any write deletes the saved wallet first.
- Changes made by someone else (a fan books an influencer, a payment webhook credits the wallet) are picked up by the `live` re-ask on the next visit.

### 5. Prefetch

`Services.prefetch()` (once per account per app run, right after `/me` loads, parallel, errors swallowed): wallet (limit 1 and 20), fan bookings, favourites, topic chips, search landing, first reels page, and for an influencer her bookings and availability.

### 6. Images

`cached_network_image` was already in `pubspec.yaml` but unused; all pictures were plain `Image.network` (re-downloaded on every visit). `lib/ui/net_image.dart` wraps it (placeholder and error = the same fallback as before; plain `Image.network` under `flutter test`).

### 7. Not changed on purpose

- Tabs already stay alive (StatefulShellRoute), left as is.
- Timeouts stay 15 s; retry is only for cached reads (the wallet repo keeps its own retry).
- Skeletons: `AsyncView` still shows the spinner when nothing is saved; swapping it for shimmer rows is A8 (touches the shared widget used by tests).

### 8. Risks for the reviewer (could not compile)

- `ApiClient` constructor gained `cache`, `accountId`, `retryDelay`; `FakeApiClient` subclasses in tests only call `super(origin:)`, so they are unaffected and run uncached (no account id).
- Boot now keeps the SAVED update status if the config call fails (before: reset to none). A saved "forced" update therefore blocks while offline.
- Search/slots tests that make the fake client throw an `ApiException` now see one retry after 700 ms (`pumpAndSettle` covers it).
- `favourites_real.dart` and `search_real.dart` `_load` loops: `return` inside `try` before the `next` variable is assigned (Dart accepts it; check the analyzer).
# Hello Fraands speed plan (2026-10-20)

## Web admin

Owner report: each admin page "loads" when opened; slow on a weak network.

### Measured causes (from code; browser timing to be confirmed by the coordinator)
1. Every admin link is a plain `<a>`: a full document load (Astro MPA, no view transitions). The React island, Clerk and every fetch restart on each click. Admin HTML is `private, no-store`, so nothing about the page is reused.
2. A serial waterfall before any data: HTML -> JS -> Clerk init -> getToken -> `GET /api/admin/whoami` -> only then `.admin2-content` is shown and `whenAdmin()` releases the screens' first fetch -> data -> render. The user sees a 4-card skeleton for the whole chain.
3. No client cache at all: lists refetch from empty every visit.
4. API origin (api.hellofraands.com) is first contacted at the first data call (DNS+TLS then).
5. Already fine: `/_astro/*` is `immutable` for a year (public/_headers); Clerk `getToken` is cached by Clerk (~60s) and 401 retry exists, so token caching is not a win. `hover-prefetch` deliberately skips /admin and HTML is no-store, so link prefetch would not help.

### Changes (HF-ADMIN-CACHE-1)
- `adminCache.ts`: per-admin-uid stale-while-revalidate (memory + sessionStorage, 30 min max age). Opt-in via `adminCall(..., { onCached })`; the live fetch always runs and replaces the cached paint. Any non-GET admin call clears the whole cache before and after, so nothing shows pre-write data (refunds, payouts, wallets) as current.
- Wired into `usePaged` (Bookings, Payments, Users, Wallets) and the HF screens: host review, KYC, call reviews, avatars, demo/invite creators, calls, payouts, refunds.
- Remembered admin verdict (localStorage, 12h): the shell shows at once and screens fetch without waiting for `/whoami`; AdminNav still probes and overrides (denied clears the flag). Worker still enforces `requireAdmin`. Sign-out clears flag and cache.
- `<link rel=preconnect>` to the API origin in the admin layout.

### Not done / next
- True SPA navigation (Astro ClientRouter) would remove Clerk re-init per click but touches the whole shell; risky for the single-ClerkProvider design.
- Money screens not cached: reconciliation, phone costs, std calls (computed reports).

## Status 2026-10-20 22:00 IST (coordinator)
- Landed on main: HF-APP-CACHE-1 (+ compile fix), HF-ADMIN-CACHE-1 (web deployed, run 39454225619), HF-REELS-FAV-1, HF-PALETTE-RANGOLI-1 (owner chose "Rangoli Soft"), HF-TESTS-FIX-1. APK run 39458496306 built OK and is INSTALLED on the owner's phone (not yet looked at: phone locked).
- Admin measured after deploy: HTML 0.26 s, whoami now parallel with the data fetches, calls list served from cache (`a2c:` sessionStorage). Remaining slow parts are server-side: /api/admin/hf/std/calls 1.36 s, /std/summary 1.2 s, and an unneeded /api/admin/v2/shop/kpis (0.9 s) fired on every HF admin page by the shell — NEXT: drop the shop KPI call from HF pages, add worker-side caching/indexes for std reports.
- NEXT on the phone: Rangoli palette look on Me/Bookings/Availability/Confirm/Wallet, green Online bar + footer pill, kolam footer, heart on reel cards, channel name → profile (on-platform) / invite page (not on platform), second visits instant (cache), unknown route → "This page moved".
