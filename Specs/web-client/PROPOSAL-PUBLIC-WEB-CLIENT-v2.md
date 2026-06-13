# Proposal v2: Public Web Client — `avatok.ai` as a second viewer of the APIs the app already uses

Date: 2026-06-13 · Status: **READY TO BUILD (multi-session)** · Owner: davy (hdavy2005)
Supersedes: `Specs/PROPOSAL-PUBLIC-WEB-CLIENT.md` (v1). Differences from v1 are called out in §11.

> **One-line summary for the engineer/AI picking this up:**
> Do **not** change the Flutter app or the Worker/DO backend. Build a new **web client** in `web/` (Astro + React islands + Tailwind on Cloudflare Pages) that calls the **exact same `api.avatok.ai` Worker endpoints the Flutter app already calls**. The app *captures* (creators broadcast). The web *consumes* (browse, book, pay, watch, consult, talk to AI). It must look identical to the app (the `zine` design system) and be responsive on phone / tablet / desktop. This is **additive** — a second API consumer, no backend fork.

---

## 1. The problem

All three products — **live streaming**, **1:1 consult**, and **AI voice agents (AvaVoice / Gemini Live)** — exist only inside the Flutter app today. An outsider must download the app → make an account → browse → book before they can do anything. That gate kills creator reach. A creator wants to drop one link in a YouTube description and have a fan land, book, pay, and show up — with **no app install**.

We are creator-focused: the **creator** needs the app (to point a phone camera at the event and broadcast). The **fan must not be forced to install anything**. The fan should do everything in a browser, and only be *offered* the app as a premium upgrade.

Hard constraint: **we will not re-architect the app or the backend.** The backend is already API-first (Cloudflare Workers + Durable Objects); the app is just one consumer. The web client is a **second consumer of the same endpoints**.

---

## 2. Guiding principle — capture = app, consume = web

- **Capture / broadcast = app only.** Creators going live, running a paid consult from their camera, recording. This is the genuinely better mobile experience and the *reason the app exists*.
- **Consume = web (and app).** Everything a fan does to *receive* the product — browse the marketplace, create a booking, pay, watch a live stream, sit in a 1:1 consult, talk to an AI voice agent — runs in the browser.

Safe because the Worker is already API-first and the data model is shared. The web authenticates with a **Clerk web session** and calls the **same endpoints**. No new "public" backend, no parallel data model. The app stays the **premium** surface (background calls, push-quality notifications, and the only place to broadcast).

---

## 3. Scope

**In scope (web, no app required):**
- Browse the marketplace — listings, creator profiles, scheduled events, AI agents.
- Public shareable pages — every creator, listing, and scheduled event has a public, SEO-clean, link-preview-friendly URL.
- Create bookings + pay — slot or "join now", **guest checkout** (§8).
- Join a live stream as a viewer — in the browser (§6.1).
- 1:1 consult, fan side — in the browser (§6.2).
- Talk to AI voice agents — browser caller side, Gemini Live (§6.3).
- A logged-in consumer **dashboard** — my bookings / tickets / upcoming.

**App-only (out of scope for web):**
- Broadcasting / capture (creator going live, running the consult from their camera).
- Premium consumer extras deliberately reserved for the app.

---

## 4. Front-end stack — Astro + React islands + Tailwind on Cloudflare Pages (CONFIRMED)

- **Islands = "cache the static parts."** Astro ships pages as static, edge-cached HTML by default and only hydrates the interactive widgets ("islands"). Landing, marketing, creator, listing, and event pages are static HTML on the CDN → near-instant first paint, real SEO, clean YouTube/social link previews. Only the genuinely dynamic widgets (dashboard, booking/checkout, live viewer, consult room, agent call) download JS.
- **React where it pays.** Islands are React so we reuse the first-party **Clerk** React SDK (web auth/session). The three real-time viewers are thin browser clients (see §6) — **no heavy media SDK in the web bundle.**
- **Native Cloudflare Pages target.** Astro's Cloudflare adapter; static assets on the edge CDN; dynamic islands fetch from `https://api.avatok.ai`.
- **Responsive is styling, not framework.** Tailwind handles phone/tablet/desktop breakpoints, fed by the exported `zine` tokens (§5).

Rejected (recorded): plain React SPA (no SEO/static cache), Next.js (heavier CF runtime; held in reserve — islands are React so future migration is cheap), non-React frameworks (lose the Clerk React SDK), Flutter Web (owner-excluded — heavy, slow, weak SEO).

---

## 5. Design parity — export `zine` tokens; canonical source = `app/lib/core/ui/zine.dart`

The web is the same product in a browser, so it must render in the `zine` visual language: warm paper surfaces, thick warm-black ink borders, **hard offset shadows (never blurred)**, flat poster-color fills (**no gradients, ever**), fonts **Fredoka + Nunito + Space Mono**. Every token is a `static const` in one file (`app/lib/core/ui/zine.dart`), so the export is mechanical.

**Rule: `zine.dart` stays the single source of truth; *generate* the web tokens — never hand-copy (hand-copying drifts).** A build-time exporter (one Node script) parses the `static const` values out of `zine.dart` and emits `tokens.css` (CSS custom properties) + a Tailwind theme fragment (`theme.extend`). Wired into the web build so any `zine` change re-exports.

Token groups to map (exact values live in `zine.dart`; the exporter reads them — do not transcribe by hand):
- **Colors** → CSS vars + Tailwind `colors`: `paper #F9F7ED`, `paper2 #F4F0E3`, `card #FEFDFA`, `ink #231B14`, `inkSoft #554B42`, `inkMute #897E74`, `placeholder #8F847A`, accents `blue #A0F7F1`, `blueInk #007D7F`, `lime #BFEB56`, `coral #FE674C`, `lilac #CDAEF2`, `mint #77EDAE`, `mintInk #008853`, plus alpha tints `tape`, `coralMark`, `blueMark`.
- **Radii** → Tailwind `borderRadius`: `r 22`, `rSm 16`, `rField 18`, `rBadge 11`.
- **Border widths** → Tailwind `borderWidth`: `bw 2.5`, `bwLg 3`.
- **Hard offset shadows** → custom Tailwind `boxShadow` utilities, e.g. `shadow → 6px 7px 0 ink`, `shadowSm → 3px 3px 0 ink`, `shadowXs → 2px 2px 0 ink`, `shadowFocus → 5px 6px 0 blueInk`, `shadowError → 5px 6px 0 coral`. **No `blur` — offset only.**
- **Typography** → self-host Fredoka, Nunito, Space Mono via `@font-face` (edge-cached); map to Tailwind `fontFamily` (`display`=Fredoka, `body`=Nunito, `mono`=Space Mono).
- **Motion** → `dur 120ms`, `durSlow 250ms`.

Then build a small **web component kit** mirroring `zine_widgets.dart` one-to-one (button, card, listing tile, avatar, sticker/pill, modal/sheet), styled purely from the exported tokens. A heavier neutral `design-tokens.json` (Style-Dictionary style) is unnecessary now — the system is small and centralized. Start with the one-way exporter; revisit only if tokens churn.

---

## 6. The three real-time viewers — **corrected to match the actual backend**

> ⚠️ v1 said "start on LiveKit web SDK, add Cloudflare Stream Live later." **That is wrong.** The code already uses Cloudflare-native media. LiveKit is used **only** for AvaTalk group conferencing (`/api/conference/*`, ≤25), which is **not** part of the consume-web surface. **Do not add LiveKit to the web client.** Sources: `worker/src/routes/live.ts`, `worker/src/routes/consult.ts`, `worker/src/types.ts`.

### 6.1 Live-stream viewer — Cloudflare Stream Live (WHEP / LL-HLS)
The creator publishes from the phone via **WHIP**; viewers play the **WHEP** (low-latency WebRTC) or **LL-HLS** URL. `GET /api/live/:listingId/join` returns `{ whep, hls, room_token, starts_at, ends_at }` for a holder of a paid (or free) ticket. The web viewer is a plain `<video>` element fed by a **WHEP client** (low latency) with an **LL-HLS fallback** (`hls.js`) for compatibility. Live chat, viewer count, and donations ride the interaction room: `GET /api/live/:listingId/room` (WebSocket, signed `?token=`), `GET /state`, `POST /donate`. **No LiveKit. No SDK heavier than `hls.js`.**

### 6.2 1:1 consult room — Cloudflare Realtime SFU (native WebRTC)
Consult uses the **Cloudflare Realtime SFU** via its HTTPS API, with the Worker as a thin authed proxy at `ANY /api/consult/:bookingId/sfu/*` (`consult.ts`). The browser is a **native `RTCPeerConnection`** client — no third-party media SDK. Flow: `GET /api/consult/:bookingId/join` (gate + identity), `GET /api/consult/:bookingId/room` (WS for attendance/chat/countdown), then SFU offer/answer/track negotiation through the `/sfu/*` proxy. `POST /complete`, `/cancel`, `/extend` manage lifecycle and the refund engine. The phone publishes; the browser subscribes to the **same SFU session** — no backend fork.

### 6.3 AI voice agents — Gemini Live (browser WebSocket client)
AvaVoice agents run on **Google Gemini Live** (voice: `gemini-live-2.5-flash-native-audio`; vision: `gemini-3.1-flash-live-preview`) — `worker/src/routes/avavoice.ts`, `app/lib/core/avavoice_api.dart`. The Worker mints a **short-lived ephemeral Gemini auth token** scoped to the session; the client opens the Gemini Live WebSocket directly with that token (no Google secret ever touches the browser). Web flow, identical pattern to the app:
1. Island calls `POST /api/avavoice/sessions/start` → receives the **ephemeral Gemini token** + session id.
2. Island opens the **Gemini Live WebSocket** and streams mic audio ↔ agent audio via the **Web Audio API**; vision agents additionally send camera/screen frames.
3. `POST /api/avavoice/sessions/heartbeat` keeps the session alive; `POST /api/avavoice/sessions/stop` ends it. Billing, concurrency ("Agent Busy"), and the hard time cap are enforced by the **same Worker logic** the app uses.

This also covers the shareable creator web-call link / embeddable snippet for creator-pays agents. **No ElevenLabs anywhere** — confirmed, the only "elevenlabs" string in the tree is an unrelated `node_modules` type.

---

## 7. Site structure & routing

- **Static, edge-cached (HTML on the CDN):** landing/marketing, creator pages `avatok.ai/c/<handle>`, public listing pages `avatok.ai/l/<id>`, public scheduled-event pages `avatok.ai/e/<event>`. These are the shareable, SEO-critical surfaces; they render server-side from public reads (`/api/explore`, `/api/listings/:id`, `/api/creators/:id`) and include OpenGraph/Twitter card meta.
- **Dynamic islands (hydrated React, data from the Worker):** `avatok.ai/dashboard`, marketplace browse/filter, `/book/<id>` (checkout), `/watch/<id>` (live viewer), `/consult/<booking>` (consult room), `/agent/<id>` (agent call).

Public marketplace reads require **no auth** (the Worker already treats `/api/explore*`, `/api/listings/:id`, `/api/creators/:id` as public — `index.ts` comment "Marketplace reads are PUBLIC (A3 guest browsing)"). Booking/joining requires identity, satisfied by **guest checkout** (§8).

---

## 8. Gating & the money — browse free, gate at the action (CONFIRMED)

**The gating model (applies to the whole client):**
- **Browse is free and ungated.** The entire marketplace and every public landing page — `/`, `/explore`, `/c/<handle>`, `/l/<id>`, `/e/<event>`, and the agent's shareable page `/agent/<id>` — open for anyone with no sign-in and no email prompt. (These are the public reads, already auth-free in the Worker.)
- **The email-OTP guest gate fires only at the action:** booking checkout, tapping "Talk now" on an AI agent, joining a live stream, or entering a consult room. At that moment the fan enters an **email → receives an OTP / magic link → a silent guest account is created**, yielding a Clerk session JWT.
- **A guest is a valid authenticated user.** Every `requireUser` endpoint (booking, `avavoice/sessions/start`, `calls/now`, consult/live join) accepts the guest JWT — confirmed in `worker/src/routes/avavoice.ts` and `authz.ts`. There is **no separate guest API**; guest is just an identity tier on the existing endpoints.
- **Why email:** it's the channel for booking confirmations and notifications, so we capture it at the gate. The guest can later upgrade to a full account (`/api/identity/upgrade`) without re-doing anything.

**The flow:** `POST /api/id/email/start` (send OTP/magic link) → `POST /api/id/email/verify` → `POST /api/identity/guest` (email-keyed shadow account) → JWT. A single reusable `GuestGate` (built in the foundation phase) runs this everywhere.

**The money is unchanged.** Payment is the existing Stripe path: `POST /api/wallet/topup` → `/webhooks/stripe`. Booking is `POST /api/calendar/book` (events/consult) or `POST /api/avavoice/bookings` (agents), and the existing **escrow-style hold** (funds held until the event completes) is untouched. **The web invents no money flow — it calls the existing ones with the guest's JWT.**

---

## 9. How the work is split — parallel sessions, one glue session

The build runs as **independent AI sessions in parallel**, then a final glue session. Every session carries the **same `MASTER-PROMPT.md`** plus **one phase file**. **No session commits** (overlap risk) — only the final glue session commits and pushes. **After every phase, the session writes a Graphiti episode** (`group_id="proj_avaflutterapp"`) describing what it built — but does **not** commit.

| Phase | File | Runs | Owns (distinct files — zero overlap) |
|---|---|---|---|
| **0 — Foundation** | `PHASE-0-FOUNDATION.md` | **First, solo** (prerequisite) | scaffold `web/`, `astro.config.mjs`, Tailwind, `tokens.css` exporter, fonts, shared kit `web/src/lib/**` + `web/src/components/**`, root layout + nav shell, `apiClient`, Clerk provider |
| **A — Marketplace + public SSR** | `PHASE-A-MARKETPLACE.md` | Parallel | `web/src/pages/index.astro`, `/explore`, `/c/[handle].astro`, `/l/[id].astro`, `/e/[event].astro`, `web/src/islands/marketplace/**` |
| **B — Auth + guest checkout + booking + dashboard** | `PHASE-B-AUTH-BOOKING.md` | Parallel | `web/src/pages/book/**`, `/dashboard`, `web/src/islands/checkout/**`, `web/src/islands/auth/**`, `web/src/islands/dashboard/**` |
| **C — Live viewer (WHEP/HLS)** | `PHASE-C-LIVE-VIEWER.md` | Parallel | `web/src/pages/watch/[id].astro`, `web/src/islands/live/**` |
| **D — Consult room (SFU)** | `PHASE-D-CONSULT.md` | Parallel | `web/src/pages/consult/[booking].astro`, `web/src/islands/consult/**` |
| **E — AI agent call (Gemini Live)** | `PHASE-E-AGENT.md` | Parallel | `web/src/pages/agent/[id].astro`, `web/src/islands/agent/**` |
| **Z — Glue + push** | `PHASE-Z-GLUE-AND-PUSH.md` | **Last, solo** | wires nav links, full build, integration fixes, **commits + pushes** |

**Why a solo Phase 0 first:** an AI "that knows nothing" cannot build a feature island before the scaffold, token pipeline, and shared kit exist. Phase 0 produces the **contracts** (kit component API, `apiClient` signature, route conventions) that the parallel wave codes against. Phases A–E touch **only their own directories** and import the kit **read-only**, so simultaneous sessions never edit the same file. Phase Z is the only writer of shared files (nav links, `astro.config` route registration) and the only committer.

---

## 10. Build order (recommended)

1. **Phase 0** (solo) → scaffold + tokens + kit + `apiClient` + Clerk + nav shell. Deploy a blank Cloudflare Pages preview to prove the pipeline.
2. **Phases A–E** (simultaneous, 5 sessions) → each builds its slice against Phase 0 contracts, stubbing cross-links with the agreed route paths. Proof-of-model is **Phase A's** chain: marketplace browse → public listing/event page → (hand-off to B's) guest-checkout booking.
3. **Phase Z** (solo) → wire nav, resolve any contract drift, `npm run build`, fix, then **commit + push** and deploy to the `avatok-web` Cloudflare Pages project.

Layer the viewers in the order **A → B → C → D → E** if you cannot run all five at once: marketplace+booking first (the funnel), then live, then consult, then agent.

---

## 11. What changed from v1 (and why)

1. **Media stack corrected.** v1's LiveKit-for-live claim is wrong. Live = **WHEP/LL-HLS** (Cloudflare Stream Live), consult = **Cloudflare Realtime SFU (native WebRTC)**, LiveKit = group-conference-only (not web scope). The web client carries **no media SDK heavier than `hls.js`** → smaller bundle, faster load, exact parity with the backend. (Directly serves the "fast and smooth" objective.)
2. **Explicit parallel-session model.** v1 was a single narrative. v2 is partitioned into file-disjoint phases with a master prompt + per-phase files, a no-commit rule for parallel sessions, a Graphiti-after-each-phase rule, and a single glue/commit/push session.
3. **Exact endpoints + response shapes** are now pinned to the real routes in `worker/src/index.ts` and the route files, so the AI is not guessing.
4. **Tokens spelled out** with the real hex values and the hard-shadow rule, and fonts named (Fredoka/Nunito/Space Mono), so web rendering matches the app exactly.
5. **Dashboard** added to scope (logged-in consumer view of bookings/tickets).

---

## 12. Open items to confirm before/while building (non-blocking)

- **Cloudflare Pages project name** for the web client (v1 mentions `avatok-web` already hosts the marketing site — decide: extend that project, or a new `avatok-app` project, so the static marketing site and the dynamic client cohabit cleanly). Phase Z deploy step depends on this.
- **WHEP client library** for the live viewer: use a tiny WHEP helper or hand-roll the `RTCPeerConnection` + WHEP `POST`/`PATCH`/`DELETE` (recommended; ~100 lines, zero dependency). `hls.js` is the only hard dependency for the fallback.
- **Clerk web instance / publishable key** for `avatok.ai` (the app uses a Clerk instance already; confirm the web origin is allowlisted).
