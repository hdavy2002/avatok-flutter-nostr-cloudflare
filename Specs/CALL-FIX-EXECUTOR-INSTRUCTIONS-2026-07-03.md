# CALL EXPERIENCE FIX — EXECUTOR INSTRUCTIONS (2026-07-03)

**Audience:** an AI coding agent executing these fixes. Follow EXACTLY. Do not improvise, do not refactor unrelated code, do not "improve" things not listed here.
**Goal:** WhatsApp-smooth 1:1 calling in AvaTOK.
**Companion doc:** `Specs/VOICE-CALL-ISSUES-2026-07-03.md` (diagnosis + telemetry evidence).

---

## 0. HARD RULES — READ FIRST, VIOLATIONS ARE FAILURES

1. **NEVER `git push`.** Commit locally only. A pre-push hook blocks pushes; do NOT override it, do NOT use `--no-verify`, do NOT touch the hook. More fixes are coming before the merge build.
2. **All commits go through the wrapper, with explicit paths:**
   ```bash
   python3 scripts/git_safe_commit.py "[ISSUE-ID] short description" path/to/file1 path/to/file2
   ```
   Never run `git add` / `git commit` directly. Never use the no-paths form. Never use `flock`.
3. **One issue per commit.** Commit message starts with the issue ID from this doc (e.g. `[CALLFIX-1]`).
4. **No local builds.** Do NOT run `flutter build`, `flutter analyze`, `npm build`, etc. They will fail. Builds run in GitHub Actions after the final merge (not by you).
5. **Read every file before editing it.** Line numbers in this doc are approximate — locate by the code excerpt/symbol name, not by line number alone.
6. **Per-account scoping is mandatory** for any new local storage: use `scopedKey(...)` / `readScoped(...)` from `app/lib/core/account_storage.dart`. Never add a raw global key.
7. **Do not re-introduce Nostr anything** (npub, relays, NIP-*). Nostr is deprecated.
8. **If a step is impossible** (file moved, symbol renamed, logic already changed), do NOT guess. Skip it, and record it in the final report (§ FINAL REPORT) with what you found instead.
9. **After each fix, add telemetry** (PostHog `Analytics.capture` on client / existing telemetry helper on worker) as specified per issue, and leave existing telemetry in place.
10. Worker deploys: do NOT deploy. Code + commit only. The owner deploys.

---

## PHASE 1 — CRASH/NOISE BUGS (silent experience-killers)

### [CALLFIX-1] Remove dead Nostr `npub` column query (249 crashes/week)
- **Symptom:** `SqliteException(1): no such column: "npub"` — fires repeatedly on real devices.
- **Do:** `grep -rn "npub" app/lib/` . Find the drift/SQL query that still selects or filters on `npub`. Remove the `npub` reference (and the column from the drift table class if declared there but missing from the real DB). If a drift table schema changes, bump `schemaVersion` and add a migration step that is a no-op for existing DBs (do NOT drop user data; use `onUpgrade` guard).
- **Verify:** `grep -rn "npub" app/lib/` returns nothing (except comments). No other query references it.
- **Telemetry:** none needed (crash disappears).
- **Commit:** `[CALLFIX-1] Remove dead Nostr npub column reference from local DB queries` + the changed files.

### [CALLFIX-2] Stop Ably presence retry loop when transport=inbox (455 errors/week)
- **Symptom:** `AblyException: Unable to enter presence channel...` loops; `/api/ably/token` still called (gets 401). Ably was disabled 2026-07-01 via Worker secret `MSG_TRANSPORT=inbox`; `/api/config` returns `messagingProvider: "inbox"`.
- **Do:** Find the Ably client bootstrap in `app/lib` (search `AblyRealtime`, `ably`, `presence`). Before ANY Ably connect/attach/presence-enter/token-mint, check the remote config value (`messagingProvider` from `/api/config`, already parsed in RemoteConfig or similar). If it is not `ably`, return early — no client creation, no token calls, no presence. Add the same guard to any retry/reconnect timer so it doesn't re-arm.
- **Verify:** with provider=inbox, no code path can reach `/api/ably/token` or `presence.enter`.
- **Telemetry:** capture `ably_transport_skipped` `{provider: <value>}` once per app start when skipped.
- **Commit:** `[CALLFIX-2] Gate all Ably connect/presence/token paths behind messagingProvider config`.

### [CALLFIX-3] Fix malformed inbox WebSocket URL `https://api.avatok.ai:0/...` (30 errors/week)
- **Do:** Find where the inbox/hub WebSocket URL is built (search `"/api/inbox"` in `app/lib`). The port becomes `0` when a `Uri` is rebuilt with `port: uri.port` while the original had no explicit port, or via `Uri.replace` on a failed-lookup URI. Fix by building the URL from the configured base string directly (e.g. `Uri.parse(kApiBase).replace(scheme: 'wss', path: '/api/inbox', queryParameters: {...})`) and never copying `.port` unless `uri.hasPort`.
- **Also:** the scheme in the error is `https` not `wss` — ensure the WS URL uses `wss`.
- **Verify:** unit-style reasoning in code comments; log the final URL once at debug level.
- **Commit:** `[CALLFIX-3] Fix inbox WS URL construction (port 0 / https scheme)`.

### [CALLFIX-4] Fix `bool is not num?` cast (29 errors/week)
- **Do:** `grep -rn "as num?" app/lib/` and find the parse site that can receive a JSON `true/false` (most likely remote config / feature flags / receptionist config parsing). Replace brittle casts with a tolerant helper:
  ```dart
  num? asNum(dynamic v) => v is num ? v : (v is bool ? (v ? 1 : 0) : num.tryParse('$v'));
  ```
  Apply at the failing site(s) only (don't blanket-replace the whole codebase).
- **Commit:** `[CALLFIX-4] Tolerant numeric parsing where server may send bool`.

### [CALLFIX-5] Secure-storage BadPaddingException recovery (7 errors/week, user locked out until reinstall)
- **Do:** Find `flutter_secure_storage` reads (search `FlutterSecureStorage` in `app/lib`). Wrap reads in try/catch for `PlatformException`; on cipher errors (`BadPaddingException` in message): capture telemetry `secure_storage_corrupt` `{key_hint}`, delete ONLY the affected key (never `deleteAll` — other accounts share the device), return null so callers regenerate. Respect per-account scoping.
- **Commit:** `[CALLFIX-5] Recover from corrupt secure-storage entries instead of failing forever`.

### [CALLFIX-6] Client backoff on `/api/profile` 422 and `/api/team` 503 (272 wasted calls/week)
- **Do:** Find the client callers of `/api/profile` (422 = validation reject) and `/api/team` (503 = feature off). For 4xx validation errors: do NOT auto-retry; capture `api_error` once (already done) and stop the loop (find what re-triggers the call — likely a sync/refresh timer re-firing on failure). For 503: exponential backoff with cap (e.g. 30s→1m→5m→30m) and reset on success. Also inspect the worker route `worker/src/routes/` for `/api/profile` — include the failing field name in the 422 body if not already, so future telemetry says WHY.
- **Commit:** `[CALLFIX-6] Backoff + no-retry-on-422 for profile/team API calls`.

---

## PHASE 2 — RECEPTIONIST (Ava) BEHAVIOR

### [CALLFIX-7] Give Ava an `end_call` tool so she can sign off
- **Where:** receptionist session pipeline in `worker/src/routes/` (receptionist / Gemini Live relay; constants `SESSION_CLOSE_MS`=60000, `HARD_CAP_MS`=90000 nearby).
- **Do:**
  1. Register a function/tool named `end_call` (no args) in the Gemini Live session setup (`tools` in the setup message) AND in the CF fallback pipeline if it supports tool calls.
  2. On tool invocation: let the current TTS/audio finish flushing (~1.5s grace), then close the session with reason `ended_by_agent` (there is already an `ava_recept_ended_by_agent` event name — emit it).
  3. Append to the system prompt (find the receptionist prompt string): "When the caller indicates they are finished (says no message, says goodbye, gives their message and confirms nothing else), say ONE short closing line and immediately call end_call. Never ask another question after the caller says they are done."
  4. Suppress the idle-nudge once a closing line has been generated (set a flag when `end_call` intent detected or after wrap cue).
  5. Keep 60s/90s caps unchanged as backstops.
- **Telemetry:** emit `ava_recept_ended_by_agent` `{call_id, elapsed_ms}`.
- **Commit:** `[CALLFIX-7] Add end_call tool + prompt rule so receptionist hangs up when caller is done`.

### [CALLFIX-8] Accept must cancel receptionist takeover (the hijack race)
- **Evidence:** call `avatok-015179f9` 2026-07-03: callee accepted, `call_connected` fired both sides, receptionist STILL started 7s later and hijacked; callee leg died `rtc-disconnected`.
- **Do (server-side, authoritative):** In the worker where the receptionist takeover is scheduled/triggered for a call_id (after ring timeout or busy), record call state in the CallRoom DO (or wherever call signaling state lives). When the callee's `accept` signal arrives, set `answered=true` for that call_id. The receptionist start path MUST check `answered` and abort if true. Also: if receptionist has ALREADY started when accept arrives, prefer the human — terminate the receptionist session and let the P2P call proceed.
- **Do (client-side, defense):** in the caller's client, if `call_connected` has fired, ignore any subsequent receptionist-start signal for the same call_id (extend the existing `ava_recept_signal_suppressed` logic to cover post-connected state).
- **Telemetry:** `ava_recept_aborted_answered` `{call_id, stage: scheduled|running}`.
- **Commit:** `[CALLFIX-8] Cancel receptionist takeover when callee answers (server + client guards)`.

### [CALLFIX-9] Auto-busy should not instant-answer
- **Do:** In the auto-busy path (callee device busy → `call_incoming_autobusy` → receptionist), add a short caller-side ring window (2 rings ≈ 6–8s) before Ava answers, OR have Ava's first line be: "<Name> is on another call right now — would you like to leave a message?" (pass a `busy=true` hint into the session prompt). Implement the prompt hint at minimum; the delay is optional if complex.
- **Commit:** `[CALLFIX-9] Busy-aware receptionist greeting (and optional ring delay) on autobusy`.

### [CALLFIX-10] Align ring count with product expectation
- **Do:** KV `receptionistRings` currently 5. Confirm where it's read in worker; set default to 6 in code (KV can still override). Document in code comment.
- **Commit:** `[CALLFIX-10] Default receptionist pickup to 6 rings`.

---

## PHASE 3 — CALL SETUP: RING RELIABILITY + SPEED

### [CALLFIX-11] Dial must fail loudly when the push was never sent
- **Evidence:** JD's dials `f1bec0a0`, `b87ebc96` (2026-07-03 11:39–11:40) played ringback but NO `call_place_ok`/`call_push_sent` ever happened — callee never knew. Caller thinks it's ringing; it is not.
- **Do (client):** In the dial flow (call_screen `_start()` / place-call API call), if the place-call HTTP request fails or the signaling socket isn't open within 3s, stop ringback and show "Couldn't reach <name> — retry" with a retry button. Do NOT keep playing ringback without server confirmation. Capture `call_place_failed` `{stage, error}`.
- **Do (server):** ensure the place-call route returns a definitive success only AFTER the push was handed to FCM (or returns the `push_no_device` condition to the caller so the client can show "unavailable" immediately instead of ringing 35s).
- **Commit:** `[CALLFIX-11] Fail fast + retry UI when call push cannot be sent`.

### [CALLFIX-12] Callee ring diagnostics + full-screen intent check
- **Do:**
  1. On app start (once per day), check: notification permission, Calls channel enabled + importance, `canUseFullScreenIntent()` (Android 14+), DND status. Capture `ring_capability` `{notif, channel_ok, fsi_ok, dnd}`.
  2. If full-screen intent is not granted, show a one-time in-app banner deep-linking to the system setting (`Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT`).
  3. When an incoming call push is processed, after showing CallKit UI, emit `call_ring_ack` with `ok:true/false` + `reason` (already partially exists — extend with the reason field).
- **Commit:** `[CALLFIX-12] Ring capability diagnostics + full-screen-intent prompt`.

### [CALLFIX-13] Pre-warm the PeerConnection to cut 2–4s of setup
- **Current:** PC + offer are created only after the callee joins the room (call_screen ~line 677); ICE pool 2; relay fallback timer 7s.
- **Do:**
  1. CALLER: create the RTCPeerConnection and `getUserMedia` immediately when dialing starts (already partly true for gUM) and start ICE gathering with `iceCandidatePoolSize: 4`. Keep the existing offer-on-welcome flow, but the PC must already exist with candidates pooled.
  2. CALLEE: when the incoming-call UI is shown (before accept), fetch ICE servers (`IceCache.get()`) and create the PC + gUM so accept only does SDP exchange. If declined, dispose cleanly.
  3. Reduce relay fallback timer 7s → 4s (call_screen `_relayFallbackTimer`).
  4. Ensure trickle ICE is used both directions (candidates sent as gathered, not waiting for gathering complete). Verify the signaling handler forwards `candidate` frames immediately.
- **Caution:** dispose pre-warmed resources on decline/cancel/timeout — no mic left open (privacy!). Mic indicator must never appear while ringing on callee side unless accepted → if `getUserMedia` before accept triggers the OS mic indicator, then only pre-create the PC (no gUM) on callee side.
- **Telemetry:** extend `call_connected` with `prewarmed: true/false` and keep `setup_ms`.
- **Commit:** `[CALLFIX-13] Pre-warm PeerConnection/ICE; relay fallback 7s->4s`.

### [CALLFIX-14] Glare (both users dial each other simultaneously)
- **Do (server):** in the place-call route / CallRoom DO: if a call between A→B is being placed while a live ringing call B→A exists (same pair, both unanswered), treat it as an implicit accept: cancel the second dial and auto-join the second dialer into the first call (or simply reject the second with reason `glare` and have the client auto-accept the ringing incoming call).
- **Do (client):** if user taps Call while an incoming call from the same peer is ringing → accept the incoming call instead of dialing (`call_glare_autoaccept` telemetry).
- **Commit:** `[CALLFIX-14] Glare handling: simultaneous mutual dial resolves to one call`.

### [CALLFIX-15] Debounce accept + dedupe telemetry double-fires
- **Do:** `call_incoming_accepted` and `call_started` fire 2–3× per call (bg isolate + fg handler + recover path). Add a per-call_id "already processed" set (persisted in-memory + a scoped pref with the last 20 call_ids) checked by ALL paths that log accept/start or open the CallScreen (`push_service.dart` accept handler, `_recoverAcceptedCall`, fg listener). Only the first wins; later calls return silently.
- **Commit:** `[CALLFIX-15] Idempotent accept/start handling per call_id`.

---

## PHASE 4 — IN-CALL AUDIO QUALITY (the noise problem)

### [CALLFIX-16] Platform DSP on the P2P path (biggest noise win, do first)
- **Current:** `AvaVoiceAudioPlugin.kt` attaches `AcousticEchoCanceler`/`NoiseSuppressor`/`AutomaticGainControl` ONLY on the native Gemini path. P2P WebRTC calls rely on software flags that flutter_webrtc does not reliably apply on Android.
- **Do:**
  1. At P2P call start (after `getUserMedia`), call `Helper.setAndroidAudioConfiguration(...)` (flutter_webrtc ≥0.9: `AndroidAudioConfiguration(manageAudioFocus: true, androidAudioMode: AndroidAudioMode.inCommunication, androidAudioFocusMode: AndroidAudioFocusMode.gain, androidAudioStreamType: AndroidAudioStreamType.voiceCall, androidAudioAttributesUsageType: AndroidAudioAttributesUsageType.voiceCommunication, forceHandleAudioRouting: true)`). Check the installed flutter_webrtc version's exact API in `app/pubspec.lock` and adapt.
  2. Keep existing constraint flags (both W3C + goog*) as-is.
  3. On call end, restore audio mode to normal.
- **Commit:** `[CALLFIX-16] Communication-mode audio config on P2P calls (hardware AEC/NS path)`.

### [CALLFIX-17] Opus tuning for noisy environments
- **File:** `app/lib/core/audio_tuning.dart` (`want` map).
- **Do:** change `usedtx` `'1'` → `'0'` (DTX chops word tails and makes background noise pump); raise `maxaveragebitrate` `'40000'` → `'56000'`. Keep `useinbandfec: '1'`, `stereo: '0'`.
- **Commit:** `[CALLFIX-17] Opus: disable DTX, raise voice bitrate to 56kbps`.

### [CALLFIX-18] Audio routing: Bluetooth SCO, wired headset, auto-switch
- **Do (in `AvaVoiceAudioPlugin.kt` + a small Dart API):**
  1. Use `AudioManager` routing: on call start, if a BT headset is connected (`BluetoothProfile.HEADSET`), start SCO (`am.startBluetoothSco(); am.isBluetoothScoOn = true`) — on API 31+ prefer `am.setCommunicationDevice(...)` with the BLE/SCO device.
  2. Register a receiver for `AudioManager.ACTION_HEADSET_PLUG` and `BluetoothHeadset` connection changes during a call: route to the newly connected device automatically; when disconnected, fall back earpiece (not speaker).
  3. Expose `getCurrentRoute()` / `setRoute(earpiece|speaker|bluetooth|headset)` methods over the existing MethodChannel; add a simple route-picker to the in-call UI next to the speaker toggle (long-press speaker button → sheet listing routes).
  4. Clean everything up on call end (`stopBluetoothSco`, unregister receivers, `clearCommunicationDevice`).
- **Telemetry:** `call_audio_route` `{route, auto}` on every route change.
- **Commit:** `[CALLFIX-18] Bluetooth/wired headset routing with auto-switch during calls`.

### [CALLFIX-19] Proximity sensor + audio focus
- **Do:**
  1. Proximity: use the `proximity_sensor` pub package (or a 20-line MethodChannel in the existing plugin) to turn the screen off when near ear during an audio call with earpiece route; disable when speaker/BT route or video call.
  2. Audio focus is handled by [CALLFIX-16]'s `manageAudioFocus: true` — verify music pauses on call start and resumes after; if flutter_webrtc's flag doesn't cover it in the installed version, request/abandon focus in `AvaVoiceAudioPlugin.kt` (`AudioFocusRequest` with `AUDIOFOCUS_GAIN_TRANSIENT`, usage VOICE_COMMUNICATION).
- **Commit:** `[CALLFIX-19] Proximity screen-off + audio focus during calls`.

---

## PHASE 5 — CALL SURVIVAL & SYSTEM INTEGRATION

### [CALLFIX-20] Foreground service for ongoing calls (call must survive backgrounding)
- **Current:** `FOREGROUND_SERVICE_PHONE_CALL` permission is declared but NO service exists — Android can kill a backgrounded call.
- **Do:**
  1. Add a `CallForegroundService` (Kotlin) with `android:foregroundServiceType="phoneCall|microphone"` declared in `AndroidManifest.xml`.
  2. Start it when a call connects; show an ongoing-call notification (chronometer, hang-up action via PendingIntent → MethodChannel back to Dart `_hangUp()`; tap → reopen CallScreen).
  3. Stop it on call end. Handle the service being started when the notification permission is missing (fallback silently).
- **Commit:** `[CALLFIX-20] Foreground phoneCall service + ongoing-call notification`.

### [CALLFIX-21] Missed-call notification: one-tap Call back
- **File:** `push_service.dart` `_showMissedCallNotif`.
- **Do:** add a "Call back" action button to the missed-call notification whose payload routes to the dial flow for that peer (payload `callback:<peerId>`), handled in the notification-tap dispatcher.
- **Commit:** `[CALLFIX-21] Call-back action on missed-call notification`.

### [CALLFIX-22] Pre-connect signaling retry
- **Current:** if the signaling socket drops BEFORE media connects, the call dies (`socket-lost` before connect); reconnect logic only runs post-connect.
- **Do:** in call_screen, extend `_reconnectSignaling()` usage to the pre-connect phase: during `ringing`/`connecting`, on socket loss retry up to 3× with 1s/2s/4s backoff before declaring `socket-lost`. Keep the existing post-connect behavior.
- **Commit:** `[CALLFIX-22] Retry signaling socket during ring/connect phase`.

### [CALLFIX-23] Cellular call interruption (GSM call comes in during VoIP call)
- **Do:** listen to telephony state (`TelephonyManager`/`PhoneStateListener` via a tiny MethodChannel or the `phone_state` package — check licensing; prefer MethodChannel in existing plugin). When a cellular call goes OFFHOOK during a VoIP call: auto-mute mic and pause outgoing audio, show "On hold — cellular call" banner; resume when idle. If implementation is heavy, minimum: auto-mute + banner.
- **Commit:** `[CALLFIX-23] Handle cellular call interruption during VoIP call`.

---

## EXECUTION ORDER & SCOPE CONTROL

Work strictly in this order: Phase 1 → 2 → 3 → 4 → 5. Within a phase, the CALLFIX numbers are the order.
If you run out of time/context, STOP at a phase boundary and write the report — do not half-implement an item. Each CALLFIX is one commit; if an item needs both app + worker changes, still one commit including both, with all paths listed in the wrapper call.

**Do NOT touch:** the 2-peer cap on CallRoom DO, LiveKit conference code, Nostr archive, billing/wallet code, the pre-push hook, `.github/workflows`.

---

## FINAL REPORT (mandatory)

When done (or stopped), create `Specs/CALL-FIX-EXECUTION-REPORT-<date>.md` containing, per CALLFIX ID:
1. **Status:** done / skipped / partial (+ why).
2. **Files changed** and commit hash (`git log --oneline`).
3. **What you actually found** at each site if it differed from these instructions (exact file:line).
4. **Risk notes:** anything you were unsure about, any behavior you might have changed unintentionally, anything needing a human/device test.
5. **Test plan:** for each fix, the exact manual test (2 phones) that proves it works — written for the owner (Davy + JD) to run.
6. A list of NEW issues you noticed while working but did not fix (with file:line).

Then: add a Graphiti memory episode (`group_id="proj_avaflutterapp"`) summarizing what was done, and a PostHog project annotation listing the CALLFIX IDs completed. Do NOT push to git.
