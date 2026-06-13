# PHASE-4 GLUE — Web (avatok.ai): AvaVision Studio + Marketplace

**Date:** 2026-06-13 · **Phase:** 4 (Web Studio + Marketplace) · **Status:** complete, **NOT committed**
**Builds on:** web-client Phase 0 foundation (present) · **No shared file edited.**

---

## 1. Files I created (all under my owned paths — disjoint from every other phase)

Pages (`web/src/pages/vision/`):
- `index.astro` — AvaVision marketplace (SSR shell + `MarketplaceGrid` island, `client:visible`).
- `agent/[id].astro` — PUBLIC, ungated, server-rendered agent page (mirrors Phase E `/agent/[id]`).
- `studio.astro` — create/edit a vision agent (SSR shell + `StudioFlow` island, `client:load`).

Islands (`web/src/islands/vision/`):
- `avavisionApi.ts` — the local AvaVision fetch module (typed wrappers + shared types). **Deviation #1, below.**
- `MarketplaceGrid.tsx` — search + responsive `VisionCard` grid + background availability poll.
- `VisionCard.tsx` — kit poster + capability/overlay/snapshot badges + score label + Call-Now/Busy chip.
- `AgentCta.tsx` — the public agent page's action island (language picker + Talk now / Book; routes to
  the Phase-5 session route; gate fires there, not here).
- `TemplatePicker.tsx` — step 1: Category grid → Use-Case cards (reads `GET /api/avavision/templates?platform=web`).
- `AgentForm.tsx` — step 2: prefilled editor (name/role/voice/rate/payer/length + vision options:
  overlay toggle+style, scoring, score label, starter prompt, snapshot on/off + cap, save-snapshots OFF
  by default, platform badges, enforced safety) + **live preview pane** + gated publish.
- `StudioFlow.tsx` — tiny step controller (TemplatePicker → AgentForm); one client island so the
  step transition keeps state on the client.

Glue:
- `Specs/avavision-build/glue/PHASE-4-GLUE.md` (this file).

**No session page created** — `web/src/pages/vision/session/[id].astro` + `web/src/islands/vision/session/**`
are Phase 5's (they are present in this tree — Phase 5 landed concurrently). I cross-link them by path
string only and import the engine read-only (see §3).

**No shared foundation file edited:** `web/src/lib/**`, `web/src/components/**`, `web/src/layouts/Base.astro`,
`web/src/components/Nav.astro`, `astro.config.mjs`, `tailwind.config.*`, `tokens.css` are untouched.
I reused: `lib/apiClient.ts` (`request`/`ApiError`), `lib/config.ts` (`API_BASE`/`cfImage`),
`lib/clerk.tsx` (`ClerkIsland`/`requireGuestAuth`), and the kit (`Button`, `Field`, `Pill`, `Avatar`,
`Spinner`, `Modal`/`Sheet` available).

---

## 2. SHARED-FILE CHANGES FOR PHASE Z (copy-paste)

### 2a. Nav link — `web/src/components/Nav.astro`
Add to the `links` array (currently empty, Phase Z populates):
```js
{ href: '/vision', label: 'Vision' },
```

### 2b. web-client MASTER §4 — register the AvaVision endpoints
The web-client MASTER §4 endpoint allowlist predates AvaVision. Add the `/api/avavision/*` routes used
here (all real, built in AvaVision Phase 1 / `worker/src/routes/avavision.ts`):
```
GET  /api/avavision/templates?platform=android|ios|web
GET  /api/avavision/voices
GET  /api/avavision/marketplace?q=
GET  /api/avavision/agents/mine
POST /api/avavision/agents              · GET|PUT|DELETE /api/avavision/agents/:id
POST /api/avavision/agents/:id/publish  · POST /api/avavision/agents/:id/unpublish
POST /api/avavision/agents/:id/files?name=  · DELETE /api/avavision/agents/:id/files/:fid
GET  /api/avavision/agents/:id/availability
GET  /api/avavision/agents/:id/stats
POST /api/avavision/bookings · POST /api/avavision/calls/now
(session lifecycle endpoints are owned/used by Phase 5)
```

### 2c. (OPTIONAL) promote `avavisionApi.ts` helpers into `lib/apiClient.ts`
Once §4 lists `/api/avavision/*`, Phase Z may move the `avavisionApi.ts` named helpers into the shared
`lib/apiClient.ts` (alongside `getExplore`/`getListing`). Not required — the local module is self-contained.

---

## 3. DEVIATIONS FROM THE WEB-CLIENT MASTER (documented, not silent)

1. **Local fetch module instead of shared apiClient helpers.** The shared `lib/apiClient.ts` is read-only
   for this phase and its §4 list predates AvaVision, so I created `islands/vision/avavisionApi.ts` that
   wraps the shared `request`/`ApiError` (same `API_BASE`, same `Authorization: Bearer`, same `ApiError`)
   for the `/api/avavision/*` routes. The one binary path (`uploadFile`) uses a direct `fetch` (the shared
   `request` JSON-encodes bodies) but still mirrors `API_BASE` + Bearer + `ApiError`. See §2b/§2c for the
   ask to fold these into §4 / `apiClient.ts`.

2. **MediaPipe/TF.js in the preview.** The web-client house rule is "no heavy media SDK beyond hls.js".
   The studio live-preview reuses **Phase 5's** `islands/vision/session/visionEngineWeb.ts`, which lazy-loads
   MediaPipe Tasks Vision + TF.js MoveNet from a pinned CDN only when a preview starts. I do **not** add the
   dependency myself — I import Phase 5's engine read-only. Phase 5's own glue note documents the SDK pins.

---

## 4. CROSS-PHASE CONTRACTS RELIED ON

- **Phase 1 (`worker/src/routes/avavision.ts`) was NOT present in this tree at build time.** The
  request/response snake_case shapes in `avavisionApi.ts` are therefore derived from the AvaVision
  MASTER §4 contract + the verified AvaVoice baseline (mirrored 1:1 by the existing
  `web/src/islands/agent/api.ts`). Mapping keys assumed: `system_profile`, `voice_name`, `payer_mode`,
  `rate_per_hour`, `session_limit_min`, `avatar_url`, `capability`, `overlay_enabled`, `overlay_style`,
  `scoring_mode`, `score_label`, `vision_mode`, `tracked_subject`, `agentic_snapshot_enabled`,
  `free_snapshots_per_session`, `save_snapshots`, `platforms`, `active_calls`, `calls_total`, `rating_avg`,
  `avg_score`, `peak_score`, `snapshot_calls`; templates served as `{ categories: [...] }`, marketplace/mine
  as `{ agents: [...] }`, detail as `{ agent: {...} }`, voices as `{ voices: [...] }`. **If Phase 1 lands
  different keys, only the `*FromJson` mappers + `draftToBody` in `avavisionApi.ts` need adjusting.**
- **Phase 5 (web session):** present in this tree. I cross-link the session route string
  `/vision/session/<id>?lang=<code>[&mode=book]` from `AgentCta` and the agent page, and I import Phase 5's
  `VisionEngineWeb` + `engineFor` read-only from `islands/vision/session/` for the studio preview. If a future
  reorg removes those files, the preview degrades gracefully (try/catch → static placeholder) and the routes
  still resolve once Phase 5/Z finalize the session path.
- **Templates:** read from `Specs/avavision-templates.json` shape via `GET /api/avavision/templates`.
- **Enums (MASTER §6):** capability / overlay style / scoring mode / vision mode mirrored exactly.

## 5. Idempotency / safety honored
- Publish guarded against double-submit (`inFlight` ref + disabled/loading button); create-or-update keyed
  on a client-held draft id; money mutations (`book`, `callNow`) send an `Idempotency-Key` + one retry with
  the same key (mirrors AvaVoice). `AGENT_BUSY` (409) treated as a normal availability state (Busy chip).
- Safety: snapshots OFF by default, save-snapshots OFF by default, platform-enforced safety notes surfaced
  read-only at publish, geometry-scoring↔capability coherence validated client-side before publish.

## 6. Build result
`cd web && npm run build` — the repo's mounted `node_modules/.vite` cache is read-only in this sandbox, so I
verified in a writable copy (src symlinked to the same `node_modules`, Vite `cacheDir` redirected):
**`astro build` GREEN** — 151 modules transformed, all three routes registered
(`/vision`, `/vision/agent/[id]`, `/vision/studio`), islands compiled
(`avavisionApi`, `MarketplaceGrid`, `StudioFlow`, `AgentCta`), preview lazy-imports Phase 5's
`visionEngineWeb`/`SessionRoom` chunk. No new errors attributable to my files. **No commit.**
