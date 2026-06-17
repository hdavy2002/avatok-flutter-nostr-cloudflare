# Proposal: Public Web Client — avatok.ai as a Dynamic App (a second viewer of the APIs the app already uses)

Date: 2026-06-13 · Status: **DECISIONS LOCKED — ready to build** (owner confirmations in §9)
Decision owner: davy (hdavy2005)

> **Read this first (one-line summary for the AI/engineer picking this up):**
> Do **not** change the app or the backend. Build a new **web client** on Cloudflare Pages that calls the **exact same Worker/DO APIs the Flutter app already calls**. The web client is for *consuming* (browse, book, join, watch, talk to AI agents); the app stays the tool for *capturing* (creators broadcasting). The web must look and feel like the app (same `zine` design system) and be fully responsive on phone, tablet/iPad, and desktop. **This is additive — no app/backend rewrite.**

---

## 1. The issue (what we're solving)

Today all three products — **live streaming**, **1:1 consult**, and **AI voice agents (AvaVoice, Gemini Live)** — live only inside the Flutter app. To do anything, an outsider has to: download the app → create an account → browse the marketplace → book. That gate kills the creator's reach. A creator wants to drop a single link in a YouTube description and have a fan land, book, pay, and show up — without being forced to install an app first.

We are a creator/influencer-focused platform: the creator is the one who needs the app (to point their phone camera at the event and broadcast). The **fan should not be forced to download anything**. The fan should be able to do everything from a browser, and only be *offered* the app as a premium upgrade.

The constraint that matters: **we will not re-architect the app or the backend to achieve this.** New custom flows on the existing clients risk breaking what already works.

---

## 2. Guiding principle — capture = app, consume = web

The whole proposal rests on one clean dividing line:

- **Capture / broadcast = app only.** Creators going live, running a paid consult from their camera, and recording stay in the Flutter app. This is genuinely the better mobile experience (camera, mic, background handling, going live on the move), so it's the *reason the app exists*, not a limitation.
- **Consume = web (and app).** Everything a fan does to *receive* the product — browse the marketplace, create a booking, pay, join a live stream as a viewer, sit in a 1:1 consult, talk to an AI voice agent — runs in the browser.

The reason this is safe: the backend is already **API-first** (Cloudflare Workers + Durable Objects). The Flutter app is just one consumer of those endpoints. **The web client is a second consumer of the same endpoints.** We are adding a surface, not rewiring the plumbing. No new "public" backend, no parallel data model — the web simply authenticates (Clerk web session) and calls the same APIs the app calls.

The app is then positioned as the **premium experience**: better notifications, higher quality, backgrounded calls, and the only place to broadcast.

---

## 3. What the web client must do

In scope (consume side, web-first, no app required):
- **Browse the marketplace** — listings, creator profiles, scheduled events, AI agents.
- **Create bookings** — pick a slot / "join now", with payment (guest checkout — see §8).
- **Join live streams** — as a viewer, in the browser.
- **1:1 consult via web** — the fan's side of a paid consult, in the browser.
- **Talk to AI voice agents** — the web caller side, in the browser (Gemini Live — see §6).
- **Public shareable pages** — every listing and scheduled event has a public URL that previews well when dropped in a YouTube description / social post.

App-only (out of scope for web):
- **Broadcasting / capture** (creator going live, running the consult from their camera).
- Premium consumer extras we deliberately reserve for the app (e.g. push-quality notifications).

---

## 4. Front-end stack — **CONFIRMED: Astro + React islands + Tailwind on Cloudflare Pages**

The owner has confirmed the stack. Rationale recorded for the build team:

- **Islands is exactly the "cache the static parts" model.** Astro renders pages as static HTML by default and only hydrates the interactive components ("islands"). So the landing, marketing, and listing/event pages ship as edge-cached HTML — near-instant first paint, great SEO, and clean link previews for the YouTube-share funnel. Only the genuinely dynamic widgets (dashboard, booking flow, live viewer, consult room, agent call) download JavaScript.
- **React where it pays off.** The islands are written in React, so we reuse first-party React SDKs we already depend on: **Clerk** (web auth/session) and **LiveKit** (live-stream viewer + consult room web SDK). The AI-agent island is a thin browser **Gemini Live** WebSocket client (see §6).
- **Native Cloudflare Pages target.** Astro has a first-class Cloudflare adapter; static assets sit on the edge CDN, and the dynamic islands fetch from the **same Worker APIs** the app uses.
- **Responsive is a styling concern, not a framework one** — Tailwind handles phone/iPad/desktop breakpoints cleanly and pairs naturally with the `zine` token export (§5).

Alternatives recorded as rejected: plain React SPA (no SEO / no static-cache benefit), Next.js (heavier server runtime on Cloudflare; held in reserve — islands are React, so a future migration is low-cost), non-React frameworks (lose the Clerk/LiveKit React SDKs), and Flutter Web (owner-excluded — heavy, slow, weak SEO).

---

## 5. Design parity — **export `zine` tokens; canonical source = `zine.dart`** (resolves the open token-path question)

The web is the same product in a browser, so it must render in the app's visual language — the **`zine` design system**, defined entirely as `static const` values in one file: `app/lib/core/ui/zine.dart` (155 lines; `zine_widgets.dart` for components). Because every token is a centralized constant, the export is mechanical. **Recommended path:**

**Keep `zine.dart` as the single source of truth and *generate* the web tokens from it — do not hand-copy values (hand-copying drifts).** Concretely:

- Write a small build-time exporter (a ~one-file Dart or Node script) that reads the `static const` values out of `zine.dart` and emits two artifacts: a **`tokens.css`** of CSS custom properties, and a **Tailwind theme config** (`theme.extend`). Wire it into the web build / CI so any `zine` change re-exports automatically.
- Map the token groups:
  - **Colors** → Tailwind `colors` + CSS vars: `paper #F9F7ED`, `paper2`, `card`, `ink #231B14`, `inkSoft`, `inkMute`, `placeholder`, and the accents `blue`, `blueInk`, `lime`, `coral`, `lilac`, `mint`, `mintInk`, plus the alpha "marker"/"tape" tones (`tape`, `coralMark`, `blueMark`).
  - **Radii** (`r 22`, `rSm 16`, `rField 18`, `rBadge 11`) → Tailwind `borderRadius`.
  - **Border widths** (`bw 2.5`, `bwLg 3`) → Tailwind `borderWidth`.
  - **Typography** — the three families (`display`, `body`, `mono`) and the weight/size scale → Tailwind `fontFamily` + `fontSize`; replicate the handful of named text styles (heading/value/mono) as web components or utility classes.
- **Self-host the same font files** on the web via `@font-face` (edge-cached) so type matches the app exactly — fonts are the most visible source of "off-brand" web rendering.
- Build a small **web component kit** (buttons, cards, listing tiles, avatars, modals) mirroring the `zine_widgets.dart` components one-to-one, styled purely from the exported tokens.

A heavier "neutral `design-tokens.json` feeding both Dart and web" pipeline (Style Dictionary style) is possible but unnecessary now: the system is small, stable, and already centralized. Start with the one-way exporter; revisit only if tokens start churning.

---

## 6. AI voice agents on web — **Gemini Live** (corrected — not ElevenLabs)

AvaVoice agents run on the **Google Gemini Live API**, confirmed in code: voice-only agents use `gemini-live-2.5-flash-native-audio`, vision agents use `gemini-3.1-flash-live-preview` (`worker/src/routes/avavoice.ts`, `app/lib/core/avavoice_api.dart`). The Worker mints a **short-lived ephemeral Gemini auth token** (`generativelanguage.googleapis.com/v1alpha/auth_tokens`) scoped to the session; the client then opens the Gemini Live real-time connection directly with that token.

For the web client this is a clean story and the **same pattern as the app**:
1. The browser island calls our existing Worker endpoint to start a session and **receive the ephemeral Gemini token** (no Google secret ever touches the browser).
2. The island opens the **Gemini Live WebSocket** from the browser and streams mic audio ↔ agent audio using the Web Audio API. Vision agents additionally send camera/screen-share frames.
3. Session lifecycle, billing, concurrency ("Agent Busy"), and the hard time cap are enforced by the **same Worker logic** the app uses — the web is just another caller.

This also matches the already-specified AvaVoice web story (logged-in web calls + the shareable creator web-call link / embeddable snippet for creator-pays agents). **No ElevenLabs anywhere in the product** — the only "elevenlabs" string in the tree is an unrelated type in `node_modules`.

---

## 7. Site structure & media — static-cached shell, dynamic islands

`avatok.ai` grows from a static landing page into a dynamic site while keeping the static parts cached:

- **Static, edge-cached (HTML on the CDN):** landing/marketing pages, creator profile pages, public listing pages, and public scheduled-event pages (`avatok.ai/e/<event>`). These are the shareable, SEO-critical, YouTube-link-friendly surfaces.
- **Dynamic islands (hydrated React, data from the Worker APIs):** `avatok.ai/dashboard`, marketplace browse/filter, the booking/checkout flow, the **live-stream viewer**, the **1:1 consult room**, and the **AI agent call**.

Media uses the **same real-time infrastructure the app already uses** — the browser just joins with the matching web SDK: **LiveKit web SDK** for live-stream viewing and group/consult rooms; the existing 1:1 call path (CallRoom DO) is a 2-peer WebRTC session that a browser joins natively (creator + fan). The phone publishes; the browser subscribes to the **same room** — no backend fork.

---

## 8. The money — **CONFIRMED: guest checkout**

A fan arriving from a shared link must be able to book and pay **without creating an account**. The plan: a **silent shadow account keyed to their email** (Clerk passwordless / magic link) so "no account required" is true from the fan's side, while we still attach the ticket and hold funds until the event completes. The payment-hold (escrow-style) mechanism is covered in the separate booking spec; this proposal does not change it.

---

## 9. Owner decisions (LOCKED 2026-06-13)

1. **Framework — CONFIRMED:** Astro + React islands + Tailwind on Cloudflare Pages.
2. **Live-stream audience scale — CONFIRMED (staged approach):** start on the **LiveKit web SDK** for interactive rooms; **add Cloudflare Stream Live** (WHIP ingest from the phone → HLS playback in the browser) when a creator needs to broadcast to a **large paying audience**. This affects only the viewer island, not the rest of the site.
3. **Guest checkout — CONFIRMED:** bookings on web use guest checkout via an email-keyed shadow account.
4. **Design-token path — RESOLVED (§5):** `zine.dart` stays canonical; a build-time exporter generates `tokens.css` + Tailwind config; fonts self-hosted on the web.

---

## 10. Suggested next step

Stand up the Astro + Cloudflare Pages skeleton, run the **`zine` token exporter** into Tailwind, and wire **one** end-to-end consume flow (marketplace browse → public listing/event page → guest-checkout booking) against the existing Worker APIs as the proof of the "second viewer of the same APIs" model. Then layer in the three viewer islands in order: **live-stream viewer (LiveKit web)** → **1:1 consult** → **AI agent call (Gemini Live browser client)**.
