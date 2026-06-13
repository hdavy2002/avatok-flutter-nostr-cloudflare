# PROPOSAL — avatok.ai Web App Parity (v3)

> Turn the public web client into a **full web version of the Flutter app**: a marketing
> landing page on the apex, a public marketplace, and a signed-in **dashboard shell with
> the same sidebar the mobile app has** — so a creator or fan can do on the web (almost)
> everything they do on the phone, *except* the capture-only parts (broadcasting a live
> stream, the device camera for AI vision). Built on the existing `web/` Astro client we
> just shipped, in the `zine` design language.

**Status:** proposal for owner sign-off. Supersedes the "consume-only" framing of
`PROPOSAL-PUBLIC-WEB-CLIENT-v2.md` for everything except the capture rule.

---

## 0. Decisions locked with the owner (2026-06-13)

1. **Domain:** the web app **owns the `avatok.ai` apex**. Its own landing page replaces the
   current static marketing site; `/marketplace`, `/dashboard`, `/admin` all live under
   `avatok.ai`. The marketing content folds into the new landing page.
2. **Scope:** **consume + manage.** Marketplace, the user/creator dashboard (Verse-style),
   wallet/AvaCoins, my-bookings, **create/edit listings**, settings/identity, and the
   **watch / consult / agent viewers**. Broadcasting a live stream and the AI-vision camera
   stay **app-only** (a browser can watch a stream and talk to an agent, but a creator still
   goes live and points the camera from the phone).
3. **Auth:** **mirror the mobile flow** — handle-first (claim `@handle` → browse as guest →
   Clerk email/password sign-up + the onboarding steps), and **sign-in/sign-up lands the
   user on `/dashboard`**.

---

## 1. Why this is needed (the gap you saw)

On `avatok-app.pages.dev` today: `/sign-in` shows an empty card and `/vision` lets anyone
open the "Create a vision agent" studio. Two root causes:

- **Sign-in is blank** because the Clerk **production** instance (`clerk.avatok.ai`) only
  trusts the `avatok.ai` origin; the Clerk widget refuses to mount on the `pages.dev`
  preview domain. The code is correct (`forceRedirectUrl="/dashboard"` is already set) — it
  needs the **real domain + the origin allow-listed in Clerk** to render.
- **Vision creation is ungated** because Phase E/AvaVision shipped the studio as a public
  page. Creation of anything (vision agent, voice agent, live event, consult, class) must
  sit behind the **same auth wall** as the dashboard.

This proposal fixes both and, more broadly, restructures the site into the same shape as the
app.

---

## 2. Information architecture (the new route map)

Everything **public** is static/SSR and edge-cached. Everything **gated** requires a Clerk
session (guest tier is fine for *consuming*; a full account is required for *creating/
managing*). The redirect after auth is always `/dashboard`.

| Route | Tier | Purpose | Mobile equivalent |
|---|---|---|---|
| `/` | **Public** | Marketing landing (hero, what-it-is, featured creators, CTA) | Welcome screen |
| `/marketplace` | **Public** | The marketplace grid + search + categories + Live-now rail | AvaExplore home |
| `/m/<handle>` *(was `/c/`)* | **Public** | Creator channel/storefront | Creator channel |
| `/l/<id>` | **Public** | Listing detail (book CTA) | Listing detail |
| `/e/<event>` | **Public** | Event detail | Event detail |
| `/agent/<id>` | **Public page / gated action** | AI agent public page; "Talk now" gated | Agent public page |
| `/sign-in`, `/sign-up` | **Public** | Handle-first → Clerk; redirect → `/dashboard` | Sign-in / handle claim |
| `/dashboard` | **Gated (account)** | The **signed-in shell + sidebar** (default: Overview/Verse) | AvaShell + AvaVerse |
| `/dashboard/bookings` | Gated | My bookings & calendar | AvaCalendar |
| `/dashboard/wallet` | Gated | AvaCoins balance, ledger, top-up (Stripe) | Wallet |
| `/dashboard/listings` | Gated | My listings pipeline (drafts/published/live) | My Listings |
| `/dashboard/listings/new` | Gated | **Create a listing** (live/consult/class/agent) | Listing create |
| `/dashboard/library` | Gated | Saved media & files | AvaLibrary |
| `/dashboard/settings` | Gated | Account, identity/KYC, profile, notifications | Settings/Identity |
| `/book/<id>` | Gated (guest ok) | Checkout (guest email-OTP or full account) | Checkout sheet |
| `/watch/<id>` | Gated (guest ok) | Live **viewer** (WHEP/LL-HLS) | AvaLive viewer |
| `/consult/<booking>` | Gated (guest ok) | 1:1 consult room (WebRTC) | AvaConsult room |
| `/vision`, `/vision/studio` | **Public page / gated create** | Vision marketplace public; **studio gated** | AvaVision |
| `/admin` | **Admin gate** | Clerk username/password wall | (internal) |
| `/admin/dashboard` | **Admin-only** | Admin console (already built) | (internal) |

**Renames to do:** `/explore` → `/marketplace` (keep `/explore` as a 301 alias);
`/c/<handle>` → `/m/<handle>` (alias the old path). Header nav becomes
**Marketplace · (Vision) · Dashboard · Sign in**.

---

## 3. The signed-in shell — replicate the mobile sidebar

The Flutter app is **a single home view (AvaExplore) + a persistent left drawer**
(`app/lib/shell/ava_shell.dart`, `ava_sidebar.dart`). The web `/dashboard/*` adopts the
**same drawer**, rendered as a fixed left sidebar on desktop and a slide-over sheet on
mobile. It mirrors the drawer's exact sections:

- **Profile card** (avatar from npub seed, display name, `@handle`, "View public profile" →
  `/m/<handle>`).
- **Three featured destinations** (same icons/colors as the app):
  - **Marketplace** (storefront, blue) → `/marketplace`
  - **Your dashboard / Verse** (squares, lilac) → `/dashboard` (Overview)
  - **Library** (folder, mint) → `/dashboard/library`
- **APPS section** — the consume/manage-capable apps as rows:
  - **Wallet** → `/dashboard/wallet`
  - **My Listings** → `/dashboard/listings`
  - **Bookings / Calendar** → `/dashboard/bookings`
  - **AvaLive / AvaConsult / AvaVoice / AvaVision** → their *viewer/manage* surfaces
    (watch/join/agent pages + "manage my agents/events"); **"Go live" / camera capture is
    shown as "Open the app"** with a deep link / QR, never a dead end.
  - Coming-soon apps (AvaTweet, AvaBook, etc.) render the same "Coming soon" placeholder the
    app uses, so the surface looks complete.
- **Utilities:** Invite (share link), then **Sign out** (coral), exactly like the drawer
  footer.

The shell is a thin React island (`web/src/islands/shell/`) wrapping each `/dashboard/*`
page; the active item is driven by the URL. This is the single biggest new piece.

---

## 4. Marketplace design parity (match the phone)

Port `app/lib/features/explore/explore_home.dart` 1:1 into `/marketplace`:

- **Pinned search bar** — "Search events, sessions, creators…" → `GET /api/explore/search`.
- **"Live now" rail** — horizontally scrolling cards with the red **LIVE** sticker →
  `GET /api/explore/live-now`; tap opens the listing/checkout.
- **Category filter chips** — "All" + categories from `GET /api/explore/categories`.
- **2-column grid** (0.66 aspect) of **listing cards** showing exactly what the app card
  shows: cover image (color fallback), category tag **or** LIVE sticker, `18+` badge, title,
  one-liner, **price** (Nunito-900; free = mint; struck-through promo original), country
  flag, rating stars `4.8 (12)`, the when/date, and the **"🔥 N joined"** social-proof line.

The existing `web/src/islands/marketplace/*` already has `ExploreGrid`, `Filters`,
`LiveNowRail`, `SearchBox`, `api.ts` — this is **refinement to match the card spec**, not a
rebuild. Listing **kinds** to render: `live_event`, `consult`, `class_event`,
`agent_session` (same as `app/lib/core/listings_api.dart`).

---

## 5. Dashboard / Verse parity

`/dashboard` (Overview) ports `app/lib/features/verse/verse_screen.dart`:

- **Period chips:** Today · 7d · 30d · All.
- Cards: **Earnings**, **Projections**, **Momentum**, **Top events**, **Audience**,
  **Reach**, **Reviews** — each deep-linking to the relevant `/dashboard/*` sub-page, like
  the app's cards deep-link into Wallet / My Listings. (Reuses the same metrics endpoints the
  app calls; we confirm field names against `worker/src/routes/*` — read-only.)

Sub-pages reuse what's already built where possible: `/dashboard/bookings` from the existing
`islands/dashboard/MyBookings.tsx`; `/dashboard/wallet`, `/dashboard/listings`,
`/dashboard/settings` are new but thin (lists + forms over existing endpoints).

---

## 6. Gating matrix (this is the core of your ask)

| Action | Public? | Gate |
|---|---|---|
| Browse marketplace, view listing/creator/event/agent pages | ✅ Yes | none |
| **Book + pay** (checkout) | gated | **guest** email-OTP *or* full account |
| **Join a live stream / consult room / "Talk now" to an agent** | gated | guest ok |
| **Open the dashboard** | gated | **full account** (handle-first) |
| **Create a listing** (live/consult/class) | gated | **full account + KYC** (same as app) |
| **Create a vision/voice agent** (studio) | gated | **full account + KYC** |
| Wallet top-up / payout | gated | full account |
| **Admin console** | gated | **admin-only Clerk identity** at `/admin` |

Implementation: a small `requireAccount()` guard island wraps every `/dashboard/*` page and
the create/studio pages — if there's no Clerk session it routes to `/sign-in?next=…`; if the
session is a *guest* tier and the page needs a full account, it shows the **upgrade prompt**
(the app's `AccountGate` equivalent — we already have `islands/auth/UpgradePrompt.tsx`).
Creation pages additionally check identity level (`GET /api/identity/level`) and route to the
KYC steps in `/dashboard/settings` when needed — mirroring the app's progressive KYC.

---

## 7. Auth flow on web (mirror mobile, handle-first)

1. **Guest browse** (no auth) — full marketplace.
2. **Claim handle** on `/sign-up`: reserve `@handle` (`GET /api/identity/guest/check`), then
   Clerk email/password sign-up inside `ClerkIsland`.
3. **Onboarding** (lightweight web version of the app's steps): display name + handle, terms,
   notifications opt-in, and the **identity/KYC** steps only when an action needs them.
4. **Redirect → `/dashboard`** (already wired via `forceRedirectUrl`).
5. **Guest checkout stays** for fans who only want to book: email → OTP → shadow account,
   upgradeable later (`POST /api/identity/upgrade`).

**Prereq (blocking, you must do once):** in the Clerk dashboard add `avatok.ai` (and any
staging origin) to the production instance's **allowed origins / domains**, or the widget
stays blank. This is the reason `/sign-in` looked empty in your screenshot.

---

## 8. Admin area (`/admin`)

- `/admin` renders a **Clerk sign-in restricted to admins** (username/password). The existing
  `islands/admin/AdminGate.tsx` already calls `getOverview()` and fail-closes on 403 — we put
  it behind the Clerk wall so only an admin identity can even attempt it.
- `/admin/dashboard` (+ the other `admin/*` pages already built: analytics, creators, live,
  money, system, users) render only after the gate passes. Server endpoints remain the source
  of truth (fail-closed), so the gate is defence-in-depth, not the only check.
- The Nav's `data-admin-link` (already added) reveals an **Admin** link only for confirmed
  admins.

---

## 9. What stays app-only (and how the web handles it gracefully)

| Capability | Web behaviour |
|---|---|
| **Going live** (broadcast a stream) | Web shows "Go live from the app" + QR/deep-link; web can **watch** any stream. |
| **AI-vision camera session** (creator/host capture) | Web can **book/manage** vision agents and view results; the live camera-scoring capture is app-side. (A browser-camera fallback is a possible later phase but out of scope here.) |
| **Full chat/calls (AvaTOK messaging)** | Out of scope for this proposal (it's the heavy server-readable inbox). Deep-link to the app. |

Every app-only surface is a **styled "open the app" panel**, never a broken link — so the web
feels complete.

---

## 10. Deployment & domain cutover (apex takeover)

1. Add the **custom domain `avatok.ai`** (and `www`) to the **`avatok-app`** Pages project.
2. Repoint the apex DNS / move the domain off the `avatok-web` (marketing) project. Keep
   `avatok-web` as a fallback until the new landing page is signed off.
3. Allow-list `avatok.ai` in **Clerk** (see §7) and confirm `PUBLIC_CLERK_PUBLISHABLE_KEY` +
   `PUBLIC_API_BASE` env on the project.
4. Confirm `api.avatok.ai` CORS allows the `avatok.ai` web origin (read `worker/` — no edits;
   if the origin isn't allowed, that's the one backend change to request from the worker
   owner).
5. Ship behind the existing build → `wrangler pages deploy`.

---

## 11. Phase plan

| Phase | Deliverable |
|---|---|
| **W0 — Domain + auth unblock** | Custom domain on `avatok-app`, Clerk origin allow-list, `/sign-in` + `/sign-up` (handle-first) rendering, redirect to `/dashboard`. Marketing landing `/` v1. |
| **W1 — Shell + gating** | The sidebar shell for `/dashboard/*`, `requireAccount()` guard, gate `/vision/studio` + all create pages, upgrade prompt. |
| **W2 — Marketplace parity** | `/marketplace` card spec to match the phone, `/explore`→`/marketplace` alias, creator page `/m/<handle>`. |
| **W3 — Dashboard parity** | Verse overview cards + `/dashboard/{bookings,wallet,listings,settings}`. |
| **W4 — Create + manage** | `/dashboard/listings/new` (all kinds) + vision/voice agent studio behind auth+KYC; my-listings pipeline. |
| **W5 — Admin + polish** | `/admin` Clerk gate, app-only "open the app" panels, Lighthouse/perf pass, full funnel smoke test. |

Each phase is independently shippable and keeps the build green.

---

## 12. APIs reused (no new backend)

All existing `https://api.avatok.ai` endpoints already cataloged in MASTER §4 — explore/
search/categories/live-now, listings/creators, identity (guest/upgrade/level + email OTP),
calendar/booking, wallet (balance/transactions/topup), live join/room/state, consult join/
room/sfu, avavoice + avavision sessions. Dashboard/Verse metrics and listing-create use the
same endpoints the app calls; any field we need that isn't documented gets read from
`worker/src/routes/*` (read-only) and noted. **No new endpoints, no backend fork.**

---

## 13. Open items / risks

- **Clerk origin allow-list** is a hard prerequisite — nothing auth works until `avatok.ai`
  is trusted by the production instance.
- **`api.avatok.ai` CORS** must include the web origin for browser fetches; confirm before W1.
- **Apex cutover** is the one irreversible-ish step — stage it (keep `avatok-web` as fallback)
  and verify the new landing page first.
- **Listing-create contract** (multipart upload of cover photos, the 1–5 photo rule) needs the
  exact `/upload/public` + create payload shape verified against the app.
- **AvaVision dedupe** (`vision/{,session/}avavisionApi.ts`) — fold in during W4.
