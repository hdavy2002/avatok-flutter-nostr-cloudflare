# PHASE 5 — Web (avatok.ai): the live Vision Session + web vision engine. Runs in parallel.

> Carry `MASTER-PROMPT.md`. You build the browser split-screen vision session **inside the existing
> public web client** (`Specs/web-client/`), mirroring web-client **Phase E** (the AvaVoice agent
> call) and adding camera + on-device overlay + score + the "Analyze my form" snapshot. You also own
> the **web vision engine** module Phase 4's studio preview consumes. **No commit.**

## Pre-flight checklist (do BEFORE writing code)
- [ ] Confirmed the **web-client Phase 0 foundation** is in `web/` (else pause + flag; do NOT scaffold).
- [ ] Read `PHASE-1-WORKER-BACKEND.md` **§A** (`sessions/start|heartbeat|stop|snapshot`, all `snake_case`)
      and **§B** (idempotency — `stop` idempotent, snapshot `429 SNAPSHOT_CAP_REACHED` no-charge).
- [ ] Read `Specs/web-client/PHASE-E-AGENT.md` as the primary template (ephemeral token → browser opens
      Gemini Live WS → Web Audio two-way → frame sender → heartbeat/stop). Mirror, do NOT cross-import
      Phase E's `islands/agent/` files.
- [ ] Confirmed the §7 deviation you must document: MediaPipe JS Tasks + TF.js MoveNet, lazy-loaded only
      on vision pages; pin exact CDN/package versions.
- [ ] Confirmed `visionEngineWeb.ts` lives at `web/src/islands/vision/session/visionEngineWeb.ts` (Phase 4
      imports it from there).

## Idempotency & lifecycle safety
- **`stop` on `beforeunload`/unmount may fire twice** — fire-and-forget; server is idempotent (§B); never
  re-settle or block the UI.
- **Heartbeat** stops the instant state leaves `live`; a beat returning `{ended:true}` → `ended`, not error.
- **"Analyze"** button disabled while in flight and at the cap; `429` rendered as a calm fair-use notice.
- Guard the **Start** button against double-submit; `AGENT_BUSY` (409) is a normal state. Map all fields
  from §A's `snake_case` keys.

## DEPENDENCY (read first)
Requires the **web-client Phase 0 foundation** in `web/` (apiClient, `lib/clerk.tsx` with
`GuestGate`/`requireGuestAuth`, `tokens.css`, shared kit, `Base.astro`). Do **not** scaffold `web/`.
If it is missing, pause and flag it in your Graphiti episode (blocked on web-client Phase 0). Same
`web/` tree, same `group_id="proj_avaflutterapp"`. You are adding the AvaVision session the same way
Phase E added the AvaVoice agent call.

## You own (create ONLY these — disjoint from every other phase)
- `web/src/pages/vision/session/[id].astro` — the session page shell (server-rendered agent context)
- `web/src/islands/vision/session/SessionRoom.tsx` — the React island (split-screen, lifecycle, snapshot)
- `web/src/islands/vision/session/GeminiLiveClient.ts` — Gemini Live WS client (voice + 1fps video)
- `web/src/islands/vision/session/AudioPipeline.ts` — Web Audio mic-up / agent-down
- `web/src/islands/vision/session/visionEngineWeb.ts` — **the web vision engine** (camera + MediaPipe
  JS Tasks + TF.js MoveNet + overlay-on-canvas + geometry scoring). Phase 4's preview imports this.
- `web/src/islands/vision/session/SnapshotSheet.tsx` — "Analyze my form" result sheet
- `Specs/avavision-build/glue/PHASE-5-GLUE.md` — your glue note

**Do NOT touch the shared foundation** (`web/src/lib/**`, `web/src/components/**`, `Nav.astro`,
`Base.astro`, config, tailwind, tokens) or Phase 4's files. Import the foundation read-only. **Do NOT
cross-import from web-client Phase E's `islands/agent/`** — copy the Gemini Live + audio pattern into
your own files (mirror, don't share), exactly as the AvaVision app phases mirror AvaVoice.

## Read first (READ ONLY — your blueprints)
- `Specs/web-client/PHASE-E-AGENT.md` — **your primary template.** The AvaVision session = the Phase E
  agent call (ephemeral token from the Worker → browser opens the Gemini Live WS directly → Web Audio
  two-way → `VisionSender` for camera frames → heartbeat/stop) **plus** the on-device overlay + score +
  snapshot. Copy its `GeminiLiveClient`/`AudioPipeline`/`VisionSender` approach.
- `Specs/web-client/MASTER-PROMPT.md` — house rules. NOTE §7 ("no heavy media SDK beyond `hls.js`"):
  AvaVision **must** add MediaPipe JS Tasks + TF.js MoveNet for the free on-device overlay. This is a
  deliberate, product-intrinsic exception (on-device, free, lazy-loaded only on vision pages). Call it
  out explicitly in your glue note as an approved AvaVision-specific deviation; keep the bundles
  lazy-loaded so non-vision pages are unaffected.
- `Specs/web-client/PHASE-0-FOUNDATION.md` — `GuestGate`/`requireGuestAuth`, apiClient pattern, kit.
- `worker/src/routes/avavision.ts` (Phase 1) — confirm `sessions/start|heartbeat|stop|snapshot` shapes;
  reuse `app/lib/core/avavision_api.dart` / `app/lib/features/avavision/session/` (Phase 3) as the
  reference for the exact Gemini setup message + video-frame format. READ ONLY.
- `app/lib/core/ui/zine.dart` — tokens (use the CSS-var versions from `tokens.css`).

## Endpoints (via a local fetch wrapper, like Phase 4's `avavisionApi.ts`)
`POST /api/avavision/sessions/start` (→ ephemeral token + sessionId + model + vision fields),
`POST /api/avavision/sessions/heartbeat`, `POST /api/avavision/sessions/stop`,
`POST /api/avavision/snapshot`. Reuse Phase 4's `avavisionApi.ts` if merged (import from
`web/src/islands/vision/avavisionApi.ts`); else add the session/snapshot wrappers locally and note it
for Phase Z to dedupe. Never invent a URL.

## Engine policy (master §7) — LOCKED
- `pose` → **MoveNet via TF.js** (default, 17 keypoints); template may upgrade to **MediaPipe Pose JS**
  (33 pts) on web.
- `hand|gesture|face_landmark|face_detect|object|image_class|segmentation|holistic` → **MediaPipe JS
  Tasks** (web supports all).
- `gemini_only` → no on-device model; Live + snapshot only.
- All on-device in the browser, free, never streamed; the only cloud is the Live stream + snapshot.

## Build steps
1. `visionEngineWeb.ts` — given `{capability, engine, overlayStyle, scoringMode}`: `getUserMedia`
   camera; run the right model ~30fps; draw overlay on a `<canvas>` over `<video>` (`zine` accent
   colors); compute geometry score for `geometry|hybrid`. Expose `start(videoEl, canvasEl)`, `stop()`,
   `onScore(cb)`, `grabLowResFrame()` (~640px JPEG for Live), `grabHiResFrame()` (full-res for snapshot).
   Phase 4's preview uses `start/stop` + overlay only. **Lazy-load** the MediaPipe/TF.js bundles.
2. `GeminiLiveClient.ts` + `AudioPipeline.ts` — mirror Phase E: open the Live WS with the ephemeral
   token; mic PCM up (AudioWorklet) + agent audio down (jitter-buffered); send 1fps LOW frames from
   `grabLowResFrame()`; push `[SYSTEM: <label> <score> ...]` and `[SYSTEM: N minutes remaining]` text
   events (master §5); reconnect via a fresh token.
3. `SessionRoom.tsx` — the split-screen island:
   - main = `<video>` + overlay `<canvas>` + transparent **score badge**; thumbnail = agent avatar
     (kit `Avatar`); countdown + language chips (kit `Pill`).
   - **gate at start**: on "Start", `requireGuestAuth()` → `sessions/start` with the JWT (mirror Phase E
     step 2; handle Agent-Busy + hard-cap exactly as the Worker returns them).
   - lifecycle = start → 60s `heartbeat` → `stop` (stop on `beforeunload`/unmount; mirror the app's
     `call_screen` dispose-safety).
   - **camera-consent gate** before `getUserMedia`; a persistent "the agent can see you" indicator.
   - **"Analyze my form"** button (if `agentic_snapshot_enabled`) → `grabHiResFrame()` →
     `/api/avavision/snapshot` → `SnapshotSheet` shows the annotated image + breakdown; disable at the
     `free_snapshots_per_session` cap (friendly, no surprise charge).
   - language picker at connect (dial-time), same as AvaVoice.
4. `session/[id].astro` — server shell loads the agent (public read, good link preview) and mounts
   `SessionRoom` as `client:only="react"` (camera/WS can't SSR). Gate the start action, not the page.
5. Styling: kit + `zine` tokens, hard shadows, correct fonts. Keep deps minimal; MediaPipe/TF.js loaded
   only on the session + preview surfaces.

## Glue note (`Specs/avavision-build/glue/PHASE-5-GLUE.md`)
- Confirm dependence on web-client Phase 0; list foundation pieces imported.
- The **approved §7 deviation**: MediaPipe JS Tasks + TF.js MoveNet added (on-device, free, lazy) — the
  exact CDN/package versions pinned.
- Confirm `visionEngineWeb.ts` exports the surface Phase 4's preview imports (and where it lives).
- Whether you reused Phase 4's `avavisionApi.ts` or added session/snapshot wrappers locally (for Z dedupe).
- Session route string `/vision/session/<id>`; build result (`cd web && npm run build`).

## Acceptance
- [ ] Builds inside the existing `web/`; foundation reused; no scaffold, no shared-file edits.
- [ ] Session page renders split-screen, runs overlay+score, streams 1fps to Live, two-way audio smooth,
      snapshot works; camera consent + "can see you" + snapshot-cap UX present; gated at start via GuestGate.
- [ ] `visionEngineWeb.ts` reused by Phase 4's preview (one engine, no duplication).
- [ ] §7 MediaPipe/TF.js deviation documented + lazy-loaded. Graphiti episode written. **No commit.**
