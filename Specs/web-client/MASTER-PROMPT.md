# MASTER PROMPT — avatok.ai Public Web Client (carry this in EVERY session)

You are an AI engineer building part of a new **public web client** for avatok.ai. You know nothing about this codebase except what is written here and in your assigned phase file. Read this whole document before you touch anything. Then read your **one** phase file (`PHASE-*.md`) and do only that phase.

---

## 0. The 10 rules you must never break

1. **Do NOT modify the Flutter app (`app/`) or the backend (`worker/`, `consumers/`).** This project is **additive**. You only create files under **`web/`** (plus your own Graphiti episode). If you think you need to change the app or worker, you are wrong — stop and re-read your phase file.
2. **Do NOT commit and do NOT push.** Multiple sessions run at the same time; committing causes overlap. Leave your work uncommitted in the working tree. Only the final glue session (Phase Z) commits.
3. **Own only your files.** Your phase file lists the exact directories/files you may create or edit. Touching anything outside that list will collide with another running session. The shared kit (`web/src/lib/**`, `web/src/components/**`), `astro.config.mjs`, `tailwind.config.*`, `tokens.css`, the root layout, and the nav are **read-only** for everyone except Phase 0 (creates them) and Phase Z (wires them).
4. **The web is a SECOND consumer of the same APIs.** Never invent a new endpoint, a new backend, or a new data model. Every network call goes to an **existing** `https://api.avatok.ai` endpoint listed in §4. If an endpoint you need is not listed, stop and ask — do not guess a URL.
5. **Match the app's look exactly** using the exported `zine` tokens and the shared component kit (§5). No new colors, no gradients (ever), shadows are **hard offset only (never blurred)**.
6. **Capture = app, consume = web.** You are building consume-side only: browse, book, pay, watch, consult, talk to AI. There is **no broadcasting/capture** in the web client.
7. **No heavy media SDK.** Live = WHEP/LL-HLS `<video>` (only dependency allowed: `hls.js`). Consult = native `RTCPeerConnection` against Cloudflare Realtime SFU. Agent = Gemini Live WebSocket + Web Audio. **Never add LiveKit** — it is app-group-conferencing only, not part of the web client.
8. **After you finish your phase, write a Graphiti episode** (§7) with `group_id="proj_avaflutterapp"` describing exactly what you built, which files, which endpoints, and any contract you relied on. **Then stop. Do not commit.**
9. **Stub cross-phase links, don't build them.** If your page links to a route another phase owns (e.g. a listing card linking to `/book/<id>`), just use the agreed path string (§6). Do not implement the other phase's screen.
10. **When unsure, prefer the smallest, fastest, most cacheable solution.** The product objective is a **fast and smooth** end-user experience. Static HTML over JS, edge cache over fetch, one dependency over five.

---

## 1. What we're building (1 paragraph)

A browser client at `avatok.ai` so a fan arriving from a shared link can browse the marketplace, book and pay (guest checkout), watch a live stream, sit in a 1:1 consult, or talk to an AI voice agent — **without installing the app**. It is built in **Astro + React islands + Tailwind on Cloudflare Pages**, renders in the app's **`zine`** visual language, and calls the **same Worker endpoints** the Flutter app calls. Read `PROPOSAL-PUBLIC-WEB-CLIENT-v2.md` for the full rationale.

---

## 2. Tech stack (fixed — do not substitute)

- **Astro** (latest) with the **`@astrojs/cloudflare`** adapter, output target Cloudflare Pages.
- **React islands** via `@astrojs/react` — only interactive widgets are islands; everything else is static `.astro`.
- **Tailwind CSS** via `@astrojs/tailwind`, themed from the exported `zine` tokens.
- **Clerk** React SDK (`@clerk/clerk-react`) for web auth/session.
- **`hls.js`** — the only allowed media dependency (live LL-HLS fallback).
- Language: **TypeScript** everywhere. Package manager: **npm**.
- Node 20+. The repo has **no local Flutter/web toolchain assumptions** — you install web deps inside `web/` only.

---

## 3. Repo facts you need

- Monorepo root contains `app/` (Flutter), `worker/` (Cloudflare Worker — the API), `consumers/` (queue consumers), `marketing/` (existing static marketing site), and you are adding **`web/`** (this client).
- **API base URL:** `https://api.avatok.ai` (production). Staging: `https://api-staging.avatok.ai`. Put this in `web/src/lib/config.ts` (Phase 0) as `PUBLIC_API_BASE`, read from an env var with the prod value as default.
- The Worker is **one Worker** with **route dispatch** in `worker/src/index.ts`. Read it if you need to confirm an endpoint exists — but **do not edit it**.
- The design system lives in `app/lib/core/ui/zine.dart` (tokens) and `app/lib/core/ui/zine_widgets.dart` (components). You **read** these to build the web equivalents; you never edit them.
- Graphiti project group id is **`proj_avaflutterapp`** — always pass it explicitly on every Graphiti call.

---

## 4. The API contract (existing endpoints — call these, never invent)

All paths are under `https://api.avatok.ai`. Auth, when required, is a **Clerk session JWT** as `Authorization: Bearer <jwt>` (the Worker verifies via `verifyClerk`). Public reads need **no** auth.

**Public marketplace reads (NO auth):**
- `GET /api/explore?kind=&category=&country=&creator=&limit=&cursor=` → `{ listings: Card[], cursor: string|null }`
- `GET /api/explore/live-now` → `{ listings: Card[] }` (each `joinable: true`)
- `GET /api/explore/search?q=&minPrice=&maxPrice=&from=&to=&minRating=&sort=&limit=&cursor=`
- `GET /api/explore/categories` → category list (cached 300s)
- `GET /api/listings/:id` → `{ listing: Card & {description}, creator_stats, reviews[], viewer:{following,booked,is_owner} }`
- `GET /api/creators/:id` → creator channel: profile, public fields, listings, reviews

**Identity / guest checkout:**
- `POST /api/identity/guest` — create silent shadow account (email-keyed)
- `GET /api/identity/guest/check?...` — handle/availability check
- `POST /api/identity/upgrade` — promote guest → full account
- `GET /api/identity/level` — current identity level
- Email magic-link / OTP: `POST /api/id/email/start`, `POST /api/id/email/verify`

**Booking + calendar:**
- `GET /api/calendar/slots?...` / `POST /api/calendar/slots` (creator-only)
- `POST /api/calendar/book` — book a slot/event (the fan action)
- `POST /api/calendar/cancel`
- `GET /api/calendar/events` , `GET /api/booking/list?role=&when=` (my bookings)

**Money (Stripe — existing flow, do not re-implement):**
- `POST /api/wallet/topup` → returns Stripe checkout/intent; settlement via `POST /webhooks/stripe`
- `GET /api/wallet/balance`, `GET /api/wallet/transactions`

**Live viewer (Cloudflare Stream Live — WHEP/LL-HLS):**
- `GET /api/live/:listingId/join` → `{ whep, hls, room_token, starts_at, ends_at }` (ticket holders/creator only)
- `GET /api/live/:listingId/room` → **WebSocket** (signed `?token=` from join); chat + viewer count
- `GET /api/live/:listingId/state` → `{ whep, hls, state, started_at, ... }`
- `POST /api/live/:listingId/donate`

**1:1 consult (Cloudflare Realtime SFU — native WebRTC):**
- `GET /api/consult/:bookingId/join` → gate + identity (errors: `too early` 425, `not your session` 403, `session not active` 409)
- `GET /api/consult/:bookingId/room` → **WebSocket**: attendance, chat, countdown
- `ANY /api/consult/:bookingId/sfu/*` → authed proxy to Cloudflare Realtime SFU (offer/answer/tracks)
- `POST /api/consult/:bookingId/complete` | `/cancel` | `/extend`

**AI voice agent (Gemini Live):**
- `GET /api/avavoice/marketplace` , `GET /api/avavoice/agents/:id`
- `POST /api/avavoice/bookings` (book agent) , `POST /api/avavoice/calls/now`
- `POST /api/avavoice/sessions/start` → `{ ephemeral Gemini token, sessionId, model, ... }`
- `POST /api/avavoice/sessions/heartbeat` , `POST /api/avavoice/sessions/stop`
- Gemini Live WS (opened by the browser with the ephemeral token): voice model `gemini-live-2.5-flash-native-audio`, vision model `gemini-3.1-flash-live-preview`.

> If your phase needs a request/response field not shown here, open the matching `worker/src/routes/*.ts` and read the handler — **read only, never edit.**

---

## 4b. Gating model (read carefully — this governs every phase)

**Browse is free. Auth is requested only at the point of use/checkout — never before.**

- **Ungated (no auth, ever):** the entire marketplace and all public landing pages — `/`, `/explore`, `/c/<handle>`, `/l/<id>`, `/e/<event>`, and the agent's public page `/agent/<id>` (the shareable URL opens and shows the agent for anyone). These use the public reads in §4.
- **Gated by a lightweight GUEST account** (email → OTP/magic link → silent shadow account): the actual *actions* — **booking checkout**, **tapping "Talk now" on an agent**, **joining a live stream**, **entering a consult room**. The gate fires **at the action**, not on page load.
- **The guest gate flow (use this everywhere a gate is needed):**
  1. User triggers a gated action.
  2. If a Clerk session already exists → proceed immediately.
  3. Else show the **`GuestGate`** modal (built in Phase 0's `lib/clerk.tsx`): collect **email** → `POST /api/id/email/start` (sends OTP/magic link) → user enters code → `POST /api/id/email/verify` → `POST /api/identity/guest` (creates the email-keyed shadow account) → now a Clerk session JWT exists.
  4. Retry the original action with `Authorization: Bearer <jwt>`.
- **Why email:** it's required so we can send the user booking/notification emails. Capture it at the gate, nothing more. Offer (never force) a later upgrade to a full account via `POST /api/identity/upgrade`.
- **A guest is a valid authenticated user.** Every `requireUser` endpoint (booking, `avavoice/sessions/start`, `calls/now`, consult join, live join) accepts a guest JWT. Do **not** build a separate "guest API" — guest is just an identity tier.
- **Phases C/D/E/B all reuse the same `GuestGate` from Phase 0.** Do not each reinvent the email-OTP UI.

## 5. Design system (the `zine` look) — use the exported tokens + shared kit

Phase 0 generates `web/src/styles/tokens.css` + the Tailwind theme from `app/lib/core/ui/zine.dart`. Use Tailwind classes / CSS vars — **never hardcode a hex value**. Key facts:
- Surfaces: `paper #F9F7ED`, `paper2 #F4F0E3`, `card #FEFDFA`. Ink (text/border/shadow): `ink #231B14`, `inkSoft`, `inkMute`.
- Accents (flat fills, no gradients): `blue`, `blueInk` (link/accent text), `lime` (primary action), `coral` (destructive/error — the only fill that takes white text), `lilac` (AI/magic), `mint`/`mintInk` (money/success).
- Geometry: radii `r 22 / rSm 16 / rField 18 / rBadge 11`; borders `bw 2.5 / bwLg 3` on every contained element.
- **Shadows are hard offsets, never blurred:** `shadow 6×7`, `shadowSm 3×3`, `shadowXs 2×2`, focus `5×6 blueInk`, error `5×6 coral`.
- Fonts (self-hosted `@font-face`): **Fredoka** (display/headings), **Nunito** (body), **Space Mono** (mono/values).
- Use the shared kit from `web/src/components/` (Button, Card, ListingTile, Avatar, Pill, Sheet/Modal). If a component you need is missing, **do not add it to the shared kit** (that's Phase 0/Z territory) — build a local one inside your phase's island folder and note it in your Graphiti episode so Phase Z can promote it.

---

## 6. Route map (agreed paths — use these strings for cross-links)

| Path | Owner phase | Type |
|---|---|---|
| `/` , `/explore` | A | static + island |
| `/c/<handle>` | A | static (creator) |
| `/l/<id>` | A | static (listing) |
| `/e/<event>` | A | static (event) |
| `/book/<id>` | B | island (checkout) |
| `/dashboard` | B | island |
| `/sign-in` (Clerk) | B | island |
| `/watch/<id>` | C | island (live viewer) |
| `/consult/<booking>` | D | island (consult room) |
| `/agent/<id>` | E | island (agent call) |

Linking to a path you don't own = just render an `<a href="...">` / Astro link with the string above. Do not build the target.

---

## 7. End-of-phase Graphiti episode (required — then STOP, no commit)

When your phase's acceptance checklist passes, call `add_memory` with `group_id="proj_avaflutterapp"`:
- **name:** `web-client PHASE-<X> complete — <short title>`
- **episode_body:** what you built, the exact files you created under `web/`, which endpoints you call, which shared-kit pieces you used, any local component Phase Z should promote, any contract drift or assumption, and the acceptance results.
- **source:** `text`.

Then end the session. **Do not run `git commit` or `git push`.** Phase Z owns version control.

---

## 8. Definition of done for any phase

- All files live under your owned paths only; nothing outside is modified.
- `cd web && npm run build` succeeds for your additions (Phase Z runs the full integrated build; you ensure your slice compiles).
- Lighthouse/first-paint sanity: static pages ship as HTML, islands hydrate lazily (`client:visible` / `client:idle` where possible).
- Visual parity with the app (tokens + kit, hard shadows, correct fonts).
- Graphiti episode written. No commit.
