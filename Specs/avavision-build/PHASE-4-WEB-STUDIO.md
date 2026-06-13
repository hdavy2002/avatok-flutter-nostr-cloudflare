# PHASE 4 — Web (avatok.ai): AvaVision Studio + Marketplace. Runs in parallel.

> Carry `MASTER-PROMPT.md`. You build the browser creator + discovery surfaces for AvaVision **inside
> the real public web client** (`Specs/web-client/`). You do **not** scaffold `web/` — that already
> exists, built by the web-client **Phase 0 foundation**. You ride on its kit, apiClient, Clerk
> `GuestGate`, `zine` tokens, and `Base.astro`. **No commit.**

## Pre-flight checklist (do BEFORE writing code)
- [ ] Confirmed the **web-client Phase 0 foundation** exists in `web/` (apiClient, `clerk.tsx` with
      `GuestGate`/`requireGuestAuth`, `tokens.css`, kit, `Base.astro`, `Nav.astro`). If absent → pause,
      flag in the Graphiti episode, do NOT scaffold.
- [ ] Read `PHASE-1-WORKER-BACKEND.md` **§A** — the authoritative `snake_case` shapes your `avavisionApi.ts`
      types must match. Read `Specs/web-client/PHASE-A-MARKETPLACE.md` + `PHASE-E-AGENT.md` for parity.
- [ ] Confirmed you do NOT edit the shared foundation; you create a **local** `avavisionApi.ts` (the
      `apiClient.ts` is read-only) and document the two MASTER-§4 deviations.
- [ ] Noted that the live preview pane imports Phase 5's engine at
      `web/src/islands/vision/session/visionEngineWeb.ts` (placeholder if Phase 5 not merged).

## Idempotency on the client
Guard publish/create/book/call buttons against double-submit (disable + spinner while in flight); the
server keys escrow by `order_id` (PHASE-1 §B) but the UI must not fire duplicates. Treat `AGENT_BUSY`
(409) as a normal availability state.

## DEPENDENCY (read first)
This phase requires the **web-client Phase 0 foundation** to be present in `web/` (it produces
`web/src/lib/apiClient.ts`, `web/src/lib/clerk.tsx` with `GuestGate`/`requireGuestAuth`,
`web/src/styles/tokens.css`, the shared kit in `web/src/components/`, `web/src/layouts/Base.astro`,
and `web/src/components/Nav.astro`). If `web/` does not yet exist, **do not scaffold it** — pause and
flag in your Graphiti episode that you are blocked on web-client Phase 0. The two build kits share the
**same `web/` tree and the same `group_id="proj_avaflutterapp"`**; you are simply adding the AvaVision
feature to the existing web client, exactly like web-client Phase E added the AvaVoice agent call.

## You own (create ONLY these — disjoint from every other phase, app and web)
- `web/src/pages/vision/index.astro` — AvaVision marketplace (server shell + island)
- `web/src/pages/vision/agent/[id].astro` — public agent page (server-rendered, ungated)
- `web/src/pages/vision/studio.astro` — create/edit a vision agent (island)
- `web/src/islands/vision/` — your React islands: `MarketplaceGrid.tsx`, `TemplatePicker.tsx`,
  `AgentForm.tsx`, `VisionCard.tsx`, plus `avavisionApi.ts` (the AvaVision fetch module, see below)
- `Specs/avavision-build/glue/PHASE-4-GLUE.md` — your glue note

**Do NOT build the live session page** — web-client-style ownership: the session is Phase 5
(`web/src/pages/vision/session/[id].astro` + `web/src/islands/vision/session/`). Link to it by path
string only. **Do NOT touch the shared foundation** (`web/src/lib/**`, `web/src/components/**`,
`astro.config.mjs`, `tailwind.config.*`, `tokens.css`, `Base.astro`, `Nav.astro`) — those are Phase 0
(create) / Phase Z (wire) per the web-client rules.

## Read first (READ ONLY)
- `Specs/web-client/MASTER-PROMPT.md` — the web house rules (own-your-dir, gating model §4b, `zine`
  look §5, route map §6, "never invent an endpoint" §4). Obey them.
- `Specs/web-client/PHASE-0-FOUNDATION.md` — the exact apiClient signature, the `GuestGate` /
  `requireGuestAuth` contract, and the shared kit components + their props (`Button`, `Card`,
  `ListingTile`, `Avatar`, `Pill`, `Sheet/Modal`, `Spinner`). Reuse them; do not re-create them.
- `Specs/web-client/PHASE-A-MARKETPLACE.md` — copy its marketplace/grid + card patterns for parity.
- `Specs/web-client/PHASE-E-AGENT.md` — the AvaVoice agent page is the sibling of your agent page;
  mirror its "public shell, gate at the action" structure.
- `worker/src/routes/avavision.ts` (Phase 1) — confirm request/response shapes; READ ONLY.
- `Specs/avavision-templates.json` — the catalog the studio is built around.

## Two deviations from the web-client MASTER you MUST document (don't silently break the rules)
1. **New endpoints.** AvaVision endpoints (`/api/avavision/*`) are **not** in web-client MASTER §4
   (that list predates AvaVision). They are real (built in AvaVision Phase 1). Because the foundation's
   shared `apiClient.ts` is **read-only** for you, create a **local** `web/src/islands/vision/avavisionApi.ts`
   that wraps `fetch` exactly like `lib/apiClient.ts` (same `API_BASE`, same `Authorization: Bearer`
   pattern, same `ApiError`) for the `/api/avavision/*` routes. In your glue note, ask Phase Z (or the
   web-client maintainer) to (a) add `/api/avavision/*` to MASTER §4 and (b) optionally promote
   `avavisionApi.ts` helpers into `lib/apiClient.ts`. Do **not** edit `lib/apiClient.ts` yourself.
2. **(For Phase 5, noted here for awareness)** the vision overlay needs MediaPipe/TF.js — a client-side
   dependency beyond the web-client's `hls.js`-only rule (§7). Your studio's **live preview pane**
   reuses Phase 5's `visionEngineWeb.ts`; you don't add the dependency yourself. Just know the preview
   is engine-backed by Phase 5.

## Build steps
1. `avavisionApi.ts` — typed wrappers for `templates(platform='web')`, `voices`, `marketplace(q)`,
   `mine`, `createAgent`, `getAgent`, `update`, `publish`, `uploadFile`, `book`, `callNow`,
   `availability`, `stats`. (Session/snapshot wrappers belong to Phase 5; export shared types only.)
2. **Marketplace** (`vision/index.astro` + `MarketplaceGrid`) — static shell + lazy island
   (`client:visible`). `VisionCard` = the kit `ListingTile` + capability/overlay/platform badges +
   score label + Call-Now/Agent-Busy (poll `availability`). Cards link to `/vision/agent/<id>`.
3. **Public agent page** (`vision/agent/[id].astro`) — **PUBLIC, ungated, server-rendered** for instant
   context + good link preview (mirror Phase E step 1). A "Talk now / Book" CTA that routes to
   `/vision/session/<id>` (Phase 5). The gate fires at the action inside the session page, not here.
4. **Studio** (`vision/studio.astro` + `TemplatePicker` + `AgentForm`) — template-first, identical flow
   to the app (master §6 / Phase 2): Category grid → Use-Case cards → prefilled form (capability,
   overlay toggle+style, scoring, score label, starter prompt, suggested rate, platform badges) → edit
   name/role/voice/rate/payer/length → vision options (snapshot on/off + cap, save-snapshots off) →
   publish. Gate publish behind `requireGuestAuth()` (creator must be authed). Include a **live preview
   pane** that imports Phase 5's web vision engine from its canonical location,
   `web/src/islands/vision/session/visionEngineWeb.ts` (Phase 5 owns it there, so ownership stays
   disjoint — do not create your own copy). If Phase 5 isn't merged yet, render a placeholder card and
   note the dependency in your glue note.
5. Styling: kit + `zine` tokens only, hard shadows, Fredoka/Nunito/Space Mono (all from the foundation).
   Fast: static HTML + lazy islands.

## Glue note (`Specs/avavision-build/glue/PHASE-4-GLUE.md`)
- Confirm you depended on web-client Phase 0 (list which foundation pieces you imported).
- The **Vision nav link** to add to `web/src/components/Nav.astro` (`Vision` → `/vision`) — for Phase Z.
- The request to add `/api/avavision/*` to web-client MASTER §4 and (optional) promote `avavisionApi.ts`.
- The dependency on Phase 5's `visionEngineWeb.ts` (preview pane) + the route strings you cross-linked.
- Build result (`cd web && npm run build`).

## Acceptance
- [ ] Builds inside the existing `web/`; no scaffold created; foundation kit/apiClient/GuestGate reused.
- [ ] Marketplace, public agent page, template-first studio render with `zine` styling.
- [ ] No session page created (Phase 5 owns it); no shared foundation file edited.
- [ ] Endpoint + nav + engine dependencies documented in the glue note.
- [ ] `cd web && npm run build` green for your pages. Graphiti episode written. **No commit.**
