# avatok.ai — public web client (`web/`)

A fast, cacheable browser client for avatok.ai: browse the marketplace, book &
pay (guest checkout), watch live, sit in a 1:1 consult, or talk to an AI voice
agent — **without installing the app**. Built with **Astro + React islands +
Tailwind on Cloudflare Pages**, rendered in the app's **zine** visual language,
calling the **same Worker** (`https://api.avatok.ai`) the Flutter app calls.

This is the **Phase 0 foundation**: scaffold, token pipeline, shared kit,
`apiClient`, Clerk provider + `GuestGate`, and the layout/nav shell. **No feature
screens** — Phases A–E add those.

## Run it

```bash
cd web
npm install
cp .env.example .env        # set PUBLIC_CLERK_PUBLISHABLE_KEY (and PUBLIC_API_BASE for staging)
npm run dev                 # http://localhost:4321  (runs the token exporter first)
npm run build               # prebuild re-exports tokens, then astro build
npm run preview             # serve the production build
```

Requires **Node 20+**. Package manager: **npm**.

> Build note: run the build on a normal filesystem. (Inside some sandboxed
> mounts, Astro's final "Rearranging server assets" step can hit an `EPERM` on
> `rmdir dist/_worker.js/_astro` — a filesystem-permission quirk, not a code
> issue. On a real dev machine / CI it completes cleanly.)

## The token pipeline (design parity)

`scripts/export-zine-tokens.mjs` reads **`../app/lib/core/ui/zine.dart`** and
generates:

- `src/styles/tokens.css` — `:root { --zine-*: … }` (committed; regenerated each build)
- `tailwind.zine.cjs` — the `theme.extend` fragment imported by `tailwind.config.ts`

It runs automatically on `predev` / `prebuild`. **Never hardcode a hex / radius /
shadow** — change `zine.dart` (in the app, owned by the app team) and rebuild.
The exporter self-verifies the canonical hexes (`paper #F9F7ED`, `lime #BFEB56`,
`coral #FE674C`, `ink #231B14`, `blueInk #007D7F`) and fails the build on drift.
Shadows are emitted as **hard offsets, never blurred**.

This is why `web/` must live inside the monorepo next to `app/` — the relative
path resolves and the web stays in lockstep with the app's design system.

## What's here

```
web/
  scripts/export-zine-tokens.mjs   token exporter (zine.dart → css + tailwind)
  public/fonts/                    self-hosted woff2 (served at /fonts/*) — see note
  src/
    styles/tokens.css              GENERATED — do not edit
    styles/global.css              @font-face + base resets (paper bg, ink text)
    fonts/                         woff2 source-of-record (also copied to public/fonts)
    lib/config.ts                  API_BASE, CLERK key, cfImage() transform helper
    lib/apiClient.ts               typed request<T>, ApiError, ws(), getExplore/…
    lib/types.ts                   Card, Listing, Creator, Booking, …
    lib/clerk.tsx                  ClerkIsland, useAuthToken, GuestGate, requireGuestAuth
    components/                    shared kit (Button, Card, ListingTile, Avatar,
                                   Pill, Modal, Sheet, Field, Spinner) + README (the contract)
    layouts/Base.astro             root layout (head/meta, fonts, nav, footer)
    components/Nav.astro           nav SHELL (links registry — Phase Z populates)
    pages/index.astro              PLACEHOLDER landing (Phase A overwrites)
```

> **Fonts:** the woff2 are referenced by absolute URL (`/fonts/*.woff2`) so they
> are served from **`public/fonts/`**. A source-of-record copy also lives in
> `src/fonts/` (per the phase brief). Phase Z may consolidate to one location.

## The rules (MASTER-PROMPT)

- **A–E own only their own dirs.** The shared kit (`src/lib/**`,
  `src/components/**`), `astro.config.mjs`, `tailwind.config.ts`,
  `tailwind.zine.cjs`, `tokens.css`, `layouts/Base.astro`, and `components/Nav.astro`
  are **read-only** for everyone except Phase 0 (creates) and Phase Z (wires).
- **The web is a second consumer of the same APIs.** Every call goes to an
  existing `https://api.avatok.ai` endpoint (MASTER-PROMPT §4) via `apiClient`.
  Never invent an endpoint.
- **Consume-side only** — no broadcasting/capture, no LiveKit. Live = WHEP/LL-HLS
  `<video>` (`hls.js` is the only allowed media dep). Consult = native WebRTC.
  Agent = Gemini Live WS.
- **Match the app exactly** via the zine tokens + kit. No new colors, **no
  gradients**, shadows are **hard offset only**.

## Routes (agreed cross-link strings)

`/`,`/explore` (A) · `/c/<handle>` (A) · `/l/<id>` (A) · `/e/<event>` (A) ·
`/book/<id>` (B) · `/dashboard` (B) · `/sign-in` (B) · `/watch/<id>` (C) ·
`/consult/<booking>` (D) · `/agent/<id>` (E). Link to a route you don't own with
a plain `<a href>` — don't build the target.

## Auth + GuestGate

See `src/components/README.md`. TL;DR: call `requireGuestAuth()` at a gated
action to get a session JWT (opens the email/OTP modal only if needed), then
retry the action with `Authorization: Bearer <jwt>`. **Note the documented
contract drift**: the real Worker is handle-first
(`identity/guest` mints the JWT, then `id/email/start|verify` capture the email).
