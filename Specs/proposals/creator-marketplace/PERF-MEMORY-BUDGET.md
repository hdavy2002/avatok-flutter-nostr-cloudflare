# Performance & Memory Budget (applies to EVERY phase)

**Status: BINDING.** Read with `00-UNIVERSAL-PROPOSAL.md`. A phase is not done if
it violates this file. Goal: many apps, one small fast binary — smooth and
realtime on low-end Android.

## 0. Why many apps does NOT mean heavy
Every "app" is a route in ONE Flutter binary: one engine, one heap. An app that
isn't open costs ~0 RAM; its Dart code is AOT-compiled and tree-shaken (KBs).
Memory/size problems come from 5 specific sources — each is capped below.

## 1. ONE native media stack (the biggest size/memory win)
WebRTC native libs are ~15–25 MB EACH and hold large heaps. We allow exactly ONE
`libwebrtc` in the binary, shared by everything:

| Use case | Stack | Engine |
|---|---|---|
| 1:1 calls (AvaTok, AvaConsult 1:1) | `flutter_webrtc` + CallRoom DO | shared libwebrtc |
| AvaConsult group 1:10/1:20 | **Cloudflare Realtime SFU via its HTTPS API + `flutter_webrtc` directly** — do NOT bundle the RealtimeKit/Dyte SDK (saves a 2nd WebRTC engine) | shared libwebrtc |
| AvaLive publish (creator) | WHIP over `flutter_webrtc` | shared libwebrtc |
| AvaTalk group conf ≤25 | `livekit_client` (built ON `flutter_webrtc`) | shared libwebrtc |
| AvaLive playback (viewer) | LL-HLS via `video_player`/media3 (ExoPlayer ships with Android) | no extra lib |

Rules: max ONE active RTC session + ONE active video controller at any time
(navigating away disposes; PiP keeps audio only). Dispose every controller in
`dispose()` — CI grep for undisposed controllers.

## 2. App size
- CI builds **split-per-ABI APKs / app bundle** (no fat APK), R8 + resource
  shrinking, `--tree-shake-icons` (subset icon font, no full icon packs).
- Heavy, rarely-used SDKs load lazily: Stripe Identity (KYC is once-ever),
  LiveKit conference UI → Dart `deferred as` imports now; Play Feature Delivery
  later if needed.
- No bundled images for marketplace content — everything via CF
  `/cdn-cgi/image/format=avif,quality=60,width=N` (already the rule).
- Charts (AvaStorage bars/donut, AvaVerse mini-charts) = small **CustomPainter**
  widgets, NOT a charting dependency.
- CI gate: APK size diff printed per PR; +2 MB without justification = fail.

## 3. Runtime memory caps
- **ImageCache capped:** `PaintingBinding.imageCache.maximumSizeBytes = 48 MB`
  (set in main). Always decode at display size: `cacheWidth/cacheHeight` on every
  `Image` (the `Avatar`/media widgets enforce this centrally).
- **Screens own their memory:** every feature screen builds its state on push and
  releases on pop (close = dispose stores, cancel streams). No per-app global
  singletons holding data; long-lived singletons are limited to: SyncHub,
  AccountScope, drift DB, FCM glue.
- **Lists never load whole datasets:** `ListView.builder` + keyset pagination
  (50/page) everywhere — wallet ledger, library grid, explore rails, inbox,
  reviews. `itemExtent`/`prototypeItem` where rows are uniform.
- **One SQLite (drift) DB per account**, tables per feature; queries indexed and
  windowed (`LIMIT`), never `SELECT *` into memory. SQLite page cache default
  (~2 MB) — do not raise.
- **AvaChat/AvaBrain: zero on-device ML.** Whisper, embeddings, vector search,
  LLM — all server-side. The phone renders text.
- Media caches (avatar cache, per-account DM media dir) get an **LRU cap**
  (256 MB default, user-tunable in AvaStorage settings) with background sweep —
  cached files are re-downloadable; quota files in R2 are never touched.

## 4. Realtime without battery/RAM cost
- **ONE WebSocket for the whole platform** (SyncHub → InboxDO): chat, inbox,
  storage-graph live updates, presence, booking/system events all multiplex on it.
  Adding an app NEVER adds a socket.
- Backgrounded app: socket closes (DO hibernates server-side, costs us nothing),
  FCM data pushes take over; on resume, cursor-based delta sync. No polling
  loops anywhere — cron-style client timers are banned.
- Live counters (viewers, joined_count) update via throttled events (≥2 s
  coalescing), not per-event spam.

## 5. Smoothness (perceived speed)
- Local-first: every screen paints from drift cache instantly, network refreshes
  silently (already the platform pattern — keep it for ALL new apps).
- Heavy JSON parse (>50 items) off the UI thread (`compute`/isolate). One reused
  background isolate for sync; do not spawn per-feature isolates.
- `const` constructors, `RepaintBoundary` around video tiles + animating charts.

## 6. Budgets & enforcement (added to every phase's acceptance criteria)
| Metric (mid-range Android, release build) | Budget |
|---|---|
| Cold start → first frame | < 2.0 s |
| Steady-state RSS, chat open | < 220 MB |
| RSS after opening 5 apps then returning home | within +30 MB of baseline (proves release-on-close) |
| Any screen scroll | no frame > 32 ms (spot-check DevTools) |
| APK (arm64, per-ABI) | < 60 MB target, hard fail > 80 MB |
| 1:1 call / group conf RSS | < 400 MB during, returns to baseline after |

Verification per phase: `adb shell dumpsys meminfo` before/after the open-5-apps
loop + DevTools timeline on the phase's main screen. Log results in
STATUS_REPORT.md. PostHog already captures cold-start; add `screen_frame_jank`
sampling later (flag).

## 7. Phase-specific callouts
- **P2 wallet:** ledger is paginated server-side; never sync full history locally.
- **P4 storage:** graphs repaint from a 6-row summary, not from files_index rows.
- **P6 explore:** rail images AVIF at exact cell size; off-screen rails lazy-build.
- **P7/P10 video:** see §1; viewer chat overlay reuses message list widgets.
- **P8 verse:** renders from the single cached snapshot row (<5 KB), charts painted.
- **P9 avachat:** streaming text only; source-chip media loads on tap.
