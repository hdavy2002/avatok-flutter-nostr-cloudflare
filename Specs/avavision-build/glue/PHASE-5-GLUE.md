# PHASE 5 GLUE NOTE — Web (avatok.ai): live Vision Session + web vision engine

**Status:** code complete, uncommitted (per MASTER rule 2/8c — only Phase Z commits).
**group_id:** `proj_avaflutterapp`.

## Dependency on web-client Phase 0 (confirmed present)
The web-client Phase 0 foundation is in `web/` and was reused **read-only**:
- `web/src/lib/clerk.tsx` → `ClerkIsland`, `useAuthToken` (the `auth.require()` GuestGate flow).
- `web/src/lib/apiClient.ts` → `request`, `ApiError`.
- `web/src/lib/config.ts` → `API_BASE`, `cfImage`.
- `web/src/components/` → `Avatar`, `Button`, `Spinner`, `Pill`, `Sheet`.
- `web/src/layouts/Base.astro` → page shell + OG meta.
- `web/src/styles/tokens.css` → zine CSS vars (hard shadows, accent colors).

Primary template mirrored: web-client **Phase E** (`web/src/islands/agent/` — `AgentCall.tsx`,
`GeminiLiveClient.ts`, `AudioPipeline.ts`, `VisionSender.ts`, `api.ts`). Per MASTER rule 4 the
Gemini Live + Web Audio pattern was **copied** into the vision feature, NOT cross-imported.

## Files created (Phase-5-owned only — no shared file edited)
- `web/src/pages/vision/session/[id].astro` — public, ungated session page shell; SSR agent card +
  OG tags from the PUBLIC marketplace read; mounts `SessionRoom` as `client:only="react"` (camera/WS
  can't SSR). Gate fires at start, not on load. Route string: **`/vision/session/<id>`**.
- `web/src/islands/vision/session/SessionRoom.tsx` — the split-screen island: camera `<video>` +
  overlay `<canvas>` + transparent score badge; agent-avatar thumbnail; countdown + status stickers;
  camera-consent gate (explicit checkbox) before `getUserMedia`; persistent "can see you" indicator;
  language picker at dial-time; lifecycle start→heartbeat→stop (stop on `pagehide`/unmount, idempotent,
  `sendBeacon`); "Analyze my form" → snapshot → `SnapshotSheet`, disabled in-flight + at the cap.
- `web/src/islands/vision/session/GeminiLiveClient.ts` — Gemini Live WS client (voice + 1-fps LOW
  video), mirrors Phase E + adds `sendSystemCue()` (pushes `[SYSTEM: <label> <score> …]` and
  `[SYSTEM: N minutes remaining]` text events via `clientContent` `turnComplete:false`, MASTER §5).
- `web/src/islands/vision/session/AudioPipeline.ts` — Web Audio mic-up (16 kHz PCM16, AudioWorklet +
  ScriptProcessor fallback) / agent-down (24 kHz jitter-buffered). Verbatim mirror of Phase E.
- `web/src/islands/vision/session/visionEngineWeb.ts` — **the web vision engine** (camera + lazy
  MediaPipe Tasks / TF.js MoveNet + canvas overlay in zine accents + geometry scoring). Exposes
  `start(videoEl, canvasEl)`, `stop()`, `onScore(cb)`, `grabLowResFrame()` (~640px JPEG for Live),
  `grabHiResFrame()` (full-res for snapshot), plus `dataUrlToArrayBuffer`/`dataUrlToBase64` helpers.
- `web/src/islands/vision/session/SnapshotSheet.tsx` — "Analyze my form" result sheet (annotated image
  + score + breakdown; 429 cap shown as a calm no-charge fair-use notice).
- `web/src/islands/vision/session/avavisionApi.ts` — local fetch wrappers (see dedupe note below).

## avavisionApi.ts — local, for Phase Z dedupe
Phase 4's canonical wrapper `web/src/islands/vision/avavisionApi.ts` had **not landed** when Phase 5 was
built, so the session/snapshot wrappers + the public `getMarketplace`/`getAgent` reads + the
`VisionAgent`/`VisionTicket` types + the capability/overlay/scoring enums live locally at
**`web/src/islands/vision/session/avavisionApi.ts`**. **Phase Z action:** when Phase 4's
`vision/avavisionApi.ts` exists, hoist the shared agent/marketplace/session/enums there and repoint
both Phase 4 (studio/preview) and Phase 5 (`session/*`) imports to it; delete the Phase-5 local copy.
Every URL used is a documented §4 route — none invented:
`/api/avavision/marketplace`, `/agents/:id`, `/calls/now`, `/sessions/start|heartbeat|stop`, `/snapshot`.

## APPROVED §7 DEVIATION — on-device media SDKs (lazy, free, on-device)
The web-client house rule is "no heavy media SDK beyond hls.js". AvaVision adds, as a deliberate
product-intrinsic exception, the **free on-device** overlay engines. They are **lazy-loaded from a
pinned CDN only when a session/preview actually starts** (dynamic `import()` of a variable URL, nothing
at module scope), so non-vision pages and the shared bundle are unaffected. They are never bundled into
`package.json` (no shared-file edit). Pinned versions:
- `@mediapipe/tasks-vision@0.10.18` (ESM via `https://esm.sh`; WASM fileset via
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm`).
- `@tensorflow/tfjs-core@4.22.0`, `@tensorflow/tfjs-backend-webgl@4.22.0`,
  `@tensorflow/tfjs-converter@4.22.0`, `@tensorflow-models/pose-detection@2.1.3` (ESM via `esm.sh`).
- Model assets: Google-hosted `storage.googleapis.com/mediapipe-models/*` (pose/hand/face/face_detect/
  gesture/object/image_class/segmentation); MoveNet SinglePose Lightning via pose-detection default.
**Phase Z note:** if you prefer vendored deps over CDN, add the five packages to `web/package.json` and
swap the CDN URLs in `visionEngineWeb.ts` `CDN`/`MODEL` consts for bare specifiers — the rest is unchanged.

## Engine policy (MASTER §7) — as implemented
`pose` → MoveNet (TF.js, 17 kpts, default); template `engine_upgrade_android_web=mediapipe_pose` → MediaPipe
PoseLandmarker (33 pts). `hand`/`gesture`/`face_landmark`/`face_detect`/`object`/`image_class`/
`segmentation` → MediaPipe Tasks. `holistic` → PoseLandmarker (closest free web engine; flagged). `gemini_only`
→ no on-device model (Live + snapshot only). Scoring: `geometry`/`hybrid` emit an on-device
stability/visibility+symmetry proxy (technique-only, MASTER rule 10 — never appearance);
`gemini_qualitative` emits no local number (model judges); `none` shows no badge.

## SHARED-FILE changes needed (Phase Z applies — I did NOT touch these)
- **Nav** (`web/src/components/Nav.astro`): add a `Vision` link (coordinate with Phase 4's marketplace
  route; the session page is reached via marketplace cards / shared links, so a top-nav entry is optional).
- **`worker/src/routes/config.ts`**: `avavisionEnabled` kill-switch (Phase 1's glue owns this; noted for
  completeness — the web client only reads the §4 routes).
- No `wrangler.toml`, `index.ts`, app-registry, or sidebar changes required from Phase 5.

## Cross-phase contracts relied on
- **Phase 1 (`worker/src/routes/avavision.ts`)** had NOT landed at build time. Built against the
  documented MASTER §4 contract (all `snake_case`): `sessions/start` returns `{ token, token_expires_at,
  session_id, model, capability, overlay_style, scoring_mode, score_label, agentic_snapshot_enabled,
  free_snapshots_per_session, limit_minutes }` + mirrored avavoice keys `voice, language, beat_every_sec`.
  `snapshot` returns `{ annotated_image, score, breakdown }`; `429` = `SNAPSHOT_CAP_REACHED` (no charge);
  `stop` idempotent. **Phase Z / Phase 1:** verify these exact keys; the mapping is centralized in
  `avavisionApi.ts` if any drift.
- **Phase 4** owns `web/src/pages/vision/marketplace|studio` + `vision/avavisionApi.ts`; Phase 4's studio
  preview imports `start/stop` + overlay from this phase's `visionEngineWeb.ts` (one engine, no dup).

## Build / test results
- `cd web && ./node_modules/.bin/tsc --noEmit` → **0 errors in all Phase-5 files** (strict +
  `verbatimModuleSyntax`). The only project error is pre-existing and unrelated: `tailwind.config.ts(6,14)
  Cannot find name 'require'` (missing `@types/node`, not a Phase-5 file).
- Full `astro build` could **not** complete in the build sandbox: `node_modules/.vite` is owned by the
  macOS host and the Linux sandbox cannot unlink/rewrite it (`EPERM`). This is an environment artifact,
  not a code issue. **Phase Z should run `npm run build` on the host** to produce the final bundle; the
  page mirrors the proven Phase E `agent/[id].astro` 1:1 in structure.
