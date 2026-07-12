# Spike — AvaDial telecom layer (Android default dialer + call screening)

**Date:** 2026-07-12 · **Owner:** Humphrey · **Author:** build agent (Phase 2b)
**Status:** de-risking spike for `Specs/PLAN-2026-07-12-home-ava-tok-services-shell.md` §4.
**Ships dark** behind the `avaDialer` remote flag (default false). Nothing in this
spike is on a user path until the flag is flipped in KV (staging first).

> **Cannot-compile disclaimer.** All builds run in GitHub Actions; this agent
> cannot compile or run on a device. Every API name / behaviour below is written
> against SDK knowledge and MUST be re-verified in CI + on real hardware. Items
> flagged **[verify in CI/device testing]** are the highest-risk unknowns.

---

## 0. Reality check (why this is a native product)

- `app/android/.../MainActivity.kt` has ZERO telecom code today. There is no
  `InCallService`, no `ConnectionService`, no `CallScreeningService`, no
  call-log / contacts provider access. `avaphone/` is AvaTOK↔AvaTOK **in-network**
  VoIP only (see `ava_phone_screen.dart` header) and never touches the SIM.
- Therefore Phase 2b is a from-scratch Android telecom integration. The Flutter
  side is a thin bridge; the product lives in Kotlin services the OS binds to.
- Package: `ai.avatok.avatok_call` (staging suffix `.staging`). New native code
  lives in `ai.avatok.avadial`.

---

## 1. Default-dialer role (`RoleManager.ROLE_DIALER`) — request / rollback lifecycle

**API:** `android.app.role.RoleManager` (API 29+). We only support the modern
role API; the pre-29 `TelecomManager.ACTION_CHANGE_DEFAULT_DIALER` path is out of
scope (min-SDK is well above 21 for this app — **[verify minSdk in build.gradle]**).

### Request
1. `val rm = getSystemService(RoleManager::class.java)`.
2. Guard: `rm.isRoleAvailable(RoleManager.ROLE_DIALER)` — false on tablets / devices
   with no telephony. If unavailable, AvaDial stays dialpad+contacts only.
3. Already held? `rm.isRoleHeld(RoleManager.ROLE_DIALER)` → skip the prompt.
4. `val intent = rm.createRequestRoleIntent(RoleManager.ROLE_DIALER)` then
   `activity.startActivityForResult(intent, REQ_DIALER)`. The role request REQUIRES
   an Activity context (cannot be launched from a Service/plugin without one) — this
   is why the plugin is `ActivityAware` and defers the request until an
   `ActivityPluginBinding` is attached.
5. Result in `onActivityResult(REQ_DIALER, resultCode, _)`:
   `RESULT_OK` = granted, anything else = denied. Report `{granted:bool}` to Flutter
   over `avatok/avadial` (`onRoleResult`). Emit analytics
   `avadial_role_granted` / `avadial_role_denied`.

### Rollback / loss of role
- The user can revoke us at any time via Settings → Default apps → Phone app; there
  is **no callback** for this. We must re-check `isRoleHeld(...)` on every AvaDial
  resume and downgrade the UI (grey out Logs/Block write actions, show the
  "Make Ava your phone app" banner again). **[verify: no revoke broadcast exists]**
- We NEVER programmatically strip our own role; the OS owns that. "Rollback" for us
  means: detect we lost it, stop writing to `BlockedNumberContract` / `CALL_LOG`, and
  fall back to `CallScreeningService`-only behaviour.
- Uninstall automatically returns the role to the previous default dialer (OS
  behaviour). Nothing to do.

**Emergency-call rule (non-negotiable, plan §4):** we NEVER intercept or re-route
emergency numbers. When AvaDial is the default dialer, the platform still routes
`tel:112/911/...` through the system emergency flow; our `InCallService` must not
block or delay it. All *outgoing* calls we place go through
`TelecomManager.placeCall(uri, extras)` — we never fabricate our own connection for
PSTN — so the platform's emergency handling is always in force. Document + add a
device test that an emergency number dials via the system UI even with the role held.
**[verify on device — do NOT test-dial a real emergency number; use the emulator's
emergency-number allowlist / carrier test number]**.

Docs:
- https://developer.android.com/reference/android/app/role/RoleManager
- https://developer.android.com/reference/android/app/role/RoleManager#ROLE_DIALER
- https://developer.android.com/guide/topics/connectivity/telecom/selfManaged (contrast: self-managed is for our OWN VoIP, NOT what we want for PSTN)

---

## 2. `InCallService` + `Call` callbacks — in-call lifecycle

Holding `ROLE_DIALER` makes the OS bind our declared `InCallService` for every PSTN
call and hand us the in-call UI responsibility.

**Manifest:** service `exported=true`, `permission=android.permission.BIND_INCALL_SERVICE`,
`intent-filter android.telecom.InCallService`, and
`meta-data android.telecom.IN_CALL_SERVICE_UI = true` (we render the UI). We do NOT
set `IN_CALL_SERVICE_RINGING` unless we want to own the ringtone — Phase 2b leaves
ringing to the system to reduce risk. **[verify: whether we must own ringing to show
the full-screen incoming UI reliably across OEMs]**

**Lifecycle (`AvaInCallService`):**
- `onCallAdded(call: Call)` → register a `Call.Callback`, cache the `Call`, read
  `call.details.handle` (`tel:` Uri) for the number, then notify Flutter
  (`onCallAdded {id, number, state, direction}`). For an incoming call
  (`state == Call.STATE_RINGING`), launch the full-screen incoming activity
  (`MainActivity` with `route=avadial/incoming` extra + a full-screen-intent
  notification as the OEM-safe fallback).
- `Call.Callback.onStateChanged(call, state)` → map `Call.STATE_*`
  (RINGING/DIALING/ACTIVE/HOLDING/DISCONNECTED) → notify Flutter (`onCallState`).
- `onCallRemoved(call)` → unregister the callback, drop from cache, notify Flutter
  (`onCallRemoved {id}`), tear down the incoming activity/notification.

**Actions exposed to Flutter (method calls on `avatok/avadial`):**
- `answer` → `call.answer(VideoProfile.STATE_AUDIO_ONLY)`
- `reject` → `call.reject(false, null)` (or `call.disconnect()` once active)
- `disconnect` → `call.disconnect()`
- `mute` → `InCallService.setMuted(bool)`
- `speaker` → `setAudioRoute(CallAudioState.ROUTE_SPEAKER / ROUTE_EARPIECE)`
  **[verify: `setAudioRoute` deprecated on API 34 in favour of
  `requestBondedBluetoothDevice`/`CallEndpoint` — check target SDK]**

We hold at most a handful of live `Call`s; group/conference PSTN is out of scope.

Docs:
- https://developer.android.com/reference/android/telecom/InCallService
- https://developer.android.com/reference/android/telecom/Call
- https://developer.android.com/reference/android/telecom/Call.Callback
- https://developer.android.com/guide/topics/connectivity/telecom/incallservice

---

## 3. `CallScreeningService` — screening WITHOUT full dialer role

Key fact that shapes the product: **`CallScreeningService` does NOT require the
dialer role.** It is granted via its OWN role `RoleManager.ROLE_CALL_SCREENING`
(the "Caller ID & spam app" slot), which is separately requestable. So even a user
who declines "make Ava your phone app" can still get the spam shield — we request
`ROLE_CALL_SCREENING` independently (plan §4.2).

**Manifest:** service `exported=true`,
`permission=android.permission.BIND_SCREENING_SERVICE`,
`intent-filter android.telecom.CallScreeningService`.

**`onScreenCall(callDetails)`** — HARD LATENCY BUDGET. The OS holds the call while we
decide; a slow response degrades to letting the call ring. So:
- **No network call here, ever.** We read a local snapshot file only (see §5).
- Look up the incoming number → E.164 → SHA-256 hash → check the snapshot map.
- `respondToCall(details, CallResponse.Builder()...)`:
  - Known spammer over the reject threshold → `.setDisallowCall(true)
    .setRejectCall(true).setSkipCallLog(false).setSkipNotification(false)` (or, per
    product/config, allow-with-label rather than hard reject — Phase 2b default is
    **label, not auto-reject**, to avoid false-positive missed calls;
    hard-reject is a later, config-gated step). **[verify OEM behaviour of
    setSkipNotification]**
  - Otherwise `.setDisallowCall(false)` (allow) and let the call proceed; the
    red/green/blue paint happens in the InCallService UI, not here.
- Best-effort: if the app process is alive, also forward `onScreeningVerdict
  {bucket}` to Flutter for analytics. If the process is dead, screening still works
  from the file alone (that's the whole point of the local snapshot).

Docs:
- https://developer.android.com/reference/android/telecom/CallScreeningService
- https://developer.android.com/reference/android/telecom/CallScreeningService.CallResponse
- https://developer.android.com/reference/android/app/role/RoleManager#ROLE_CALL_SCREENING

---

## 4. `BlockedNumberContract` — constraints

- Reading/writing `BlockedNumberContract` is restricted to the **default dialer,
  the default SMS app, or a carrier/system app** (`canCurrentUserBlockNumbers()`
  gates it). A normal app CANNOT write it. So AvaDial's block list has two layers:
  1. **Ava metadata (always available):** our own account-scoped labels + report
     history in scoped storage (`block_list.dart` → `DiskCache`, per-account).
  2. **System block (only when default dialer):** write-through to
     `BlockedNumberContract.BlockedNumbers` via a channel call, guarded by
     `BlockedNumberContract.canCurrentUserBlockNumbers(context)`.
- If we later become default dialer, we reconcile: push Ava-metadata blocks into the
  system table (idempotent). If we lose the role, the system entries remain but we
  can no longer edit them — surface that honestly in the UI.
- `WRITE_CALL_LOG` / call-log re-insert (restore-to-system, plan §4.7) is likewise
  default-dialer-gated. Out of scope for 2b beyond the boundary note.

Docs:
- https://developer.android.com/reference/android/provider/BlockedNumberContract
- https://developer.android.com/reference/android/provider/BlockedNumberContract#canCurrentUserBlockNumbers(android.content.Context)

---

## 5. Screening-file handshake (Flutter ⇄ CallScreeningService)

The screening service may run when the Flutter engine is dead, and has a hard
latency budget, so it must decide from a **local file with no Dart round-trip**.

**Design:**
- **Location:** `<filesDir>/avadial/spam_snapshot.json`, where `<filesDir>` is
  `context.getFilesDir()`. On the Flutter side this is
  `getApplicationSupportDirectory()` (path_provider maps ApplicationSupport →
  `context.getFilesDir()` on Android). **[verify in CI that these resolve to the
  same directory on the target path_provider version]**
- **Writer (Flutter, `avadial_channel.dart` → `writeScreeningSnapshot`):** Flutter
  owns the spam data (it fetches the §4.4 bloom filter / top-N list from the worker,
  which is NOT part of 2b). It serialises a compact map and writes the file
  **atomically** (write to `spam_snapshot.json.tmp`, then rename) so the service
  never reads a half-written file.
- **Format (v1):**
  ```json
  {
    "v": 1,
    "updated": 1720800000,
    "reject_threshold": 90,
    "warn_threshold": 70,
    "scores": { "<sha256(e164)>": 96, "<sha256(e164)>": 74 }
  }
  ```
  Numbers are stored as **SHA-256 hashes of the E.164 string**, never raw — so a
  leaked snapshot reveals no phone numbers, matching the analytics no-raw-number
  rule. The service hashes the incoming number the same way and does an exact-match
  KV lookup (phone lookup is exact-match, not semantic — plan §4.4).
- **Reader (Kotlin, `AvaCallScreeningService`):** parse once per `onScreenCall`
  (file is small — a few hundred KB even for ~10k hot numbers; the full bloom
  filter stays on the Flutter side and only the resolved hot-list is materialised
  here). Missing/corrupt file → treat as "no verdict" → allow the call (fail-open,
  never fail-closed on screening). **[verify parse latency budget on low-end devices;
  if the map grows, switch to a mmap'd bloom filter file]**
- **Concurrency:** single writer (Flutter), single reader (service). Atomic rename
  is the only synchronisation needed; no lock file.

The identical hashing must be used on both sides. Kotlin: SHA-256 of the UTF-8
E.164 string, lowercase hex. Dart: same (documented in `avadial_channel.dart`).

---

## 6. Permissions matrix (Android 10 → 16)

| Capability | Permission / gate | Notes |
|---|---|---|
| Place PSTN call | `CALL_PHONE` (runtime) | Or hand to system dialer via `ACTION_CALL`/`placeCall`. |
| Read call log | `READ_CALL_LOG` (runtime, "restricted") | Granted implicitly while default dialer; Play flags the permission → must justify via Permissions Declaration. |
| Read contacts | `READ_CONTACTS` (runtime) | Needed for GREEN (in-contacts) paint + Contacts tab. |
| Write contacts | `WRITE_CONTACTS` (runtime) | For contact create/edit (later). |
| Answer/reject via API | `ANSWER_PHONE_CALLS` (runtime) | For programmatic answer outside InCallService. |
| Phone state | `READ_PHONE_STATE` (runtime) | Line type / call state. |
| Own-call management | `MANAGE_OWN_CALLS` | Already declared (used by in-network VoIP). NOT required to be default dialer. |
| Post notifications | `POST_NOTIFICATIONS` (runtime, API 33+) | Full-screen incoming-call notification. |
| Full-screen intent | `USE_FULL_SCREEN_INTENT` | Already declared. API 34+: auto-granted only for calling/alarm apps; **[verify grant for AvaDial category]**. |
| Bind InCallService | `BIND_INCALL_SERVICE` (system) | On the service, not requested at runtime. |
| Bind screening | `BIND_SCREENING_SERVICE` (system) | On the service. |
| Block numbers | `BlockedNumberContract` (default-dialer/SMS gate) | No manifest permission; capability gate. |

Version deltas to verify on device:
- **Android 10 (29):** RoleManager baseline. OK.
- **Android 11 (30):** package-visibility — add `<queries>` for `tel:` / dialer
  intents so we can resolve them. **[verify our `<queries>` covers ACTION_DIAL]**
- **Android 12 (31):** exported must be explicit on every component (done).
- **Android 13 (33):** `POST_NOTIFICATIONS` runtime prompt; nearby-device perms
  split. Notification for incoming call now needs the runtime grant.
- **Android 14 (34):** full-screen-intent permission tightened to calling/alarm
  categories; `setAudioRoute` deprecation (§2); foreground-service-type
  enforcement (we already declare `phoneCall|microphone|camera`).
- **Android 15/16 (35/36):** **[verify — unreleased/behavioural changes unknown at
  authoring time; run the full matrix in CI on the newest emulator image]**.

---

## 7. OEM caveats

- **Samsung / Xiaomi / Huawei / Oppo (see existing badge-permission block in the
  manifest — these OEMs are already targeted):** aggressive battery management can
  kill background services and suppress full-screen intents. Mitigations: the
  incoming-call full-screen intent + a high-importance notification channel as the
  fallback (never rely on launching an Activity from the background alone), and the
  existing `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` prompt. **[verify full-screen
  incoming UI actually appears from a cold/backgrounded state on each OEM]**
- **MIUI (Xiaomi):** requires the extra "Display pop-up windows while running in the
  background" auto-start permission for reliable full-screen calls — cannot be
  granted programmatically; surface a one-time guide. **[verify]**
- **Default-app slots differ per OEM skin** (some bury the "Phone app" / "Caller ID
  & spam app" settings) — the role request Intent still works, but our fallback
  guidance copy must not assume stock paths.

---

## 8. Fallback UX when NOT default dialer

- Dialpad still works (place calls via `placeCall` / system dialer).
- Contacts + Logs: Contacts works with `READ_CONTACTS`; **Logs requires
  `READ_CALL_LOG`** which Play restricts unless we're the default dialer — so with
  the role declined, Logs shows a "Make Ava your phone app to see your call history"
  state (or falls back to the runtime `READ_CALL_LOG` grant where Play policy /
  device allows — **[verify Play Console Permissions Declaration outcome]**).
- Spam shield: still active via `ROLE_CALL_SCREENING` (requested independently), so
  the red/green/blue verdict + post-call "was this spam?" flywheel work without the
  full dialer role.
- Block list: Ava-metadata layer works; system-level blocking greyed out with an
  explainer until the dialer role is granted.

---

## 9. Test matrix (MUST be device-tested in CI — cannot be validated by this agent)

Run each row on: Pixel emulator (stock) 10/11/12/13/14/15, + at least one physical
Samsung and one Xiaomi.

1. Request `ROLE_DIALER` → grant → `isRoleHeld` true; deny → banner reappears.
2. Request `ROLE_CALL_SCREENING` independently (dialer declined) → screening fires.
3. Incoming known-spam number → snapshot hit → screening verdict + RED screen.
4. Incoming contact number → GREEN screen with name+avatar (READ_CONTACTS).
5. Incoming unknown → BLUE screen; post-call "was this spam?" prompt.
6. Full-screen incoming UI from cold/backgrounded state on each OEM (battery mgmt).
7. Answer / reject / mute / speaker each map to the right `Call` action.
8. `onCallRemoved` tears down the activity + notification (no ghost Recents card —
   see the existing DUPTASK note in the manifest).
9. Emergency number dials via SYSTEM flow with the role held (do NOT dial a real
   emergency line — use emulator allowlist / carrier test number).
10. Screening snapshot missing/corrupt → fail-open (call allowed).
11. Snapshot atomic write under concurrent screen calls → no partial-read crash.
12. Lose the dialer role at runtime → BlockedNumberContract writes stop, UI
    downgrades, no crash.
13. `BlockedNumberContract.canCurrentUserBlockNumbers` true only while default
    dialer; write-through succeeds; entries persist.
14. path_provider `getApplicationSupportDirectory()` == `context.getFilesDir()`
    (the handshake path assumption).
15. Play Console pre-launch: `READ_CALL_LOG` / `READ_CONTACTS` Permissions
    Declaration accepted for the "Phone/Caller ID" use case.
16. Account switch clears in-memory OS-derived data (contacts/logs) — no parent's
    call history visible under a child account.

---

## 10. What 2b builds vs defers

**Builds now (dark):** role helper (both roles), InCallService skeleton +
call-event bridge + in-call actions, CallScreeningService reading the local
snapshot, device contacts/call-log LIVE reads over the channel, block-list Ava
metadata + system write-through, red/green/blue PSTN screens, onboarding role hook.
The community spam pool / bloom-filter fetch (§4.4) is the WORKER's job (Phase 2a)
and is NOT in this app change — `avadial_channel.dart` just writes whatever snapshot
Flutter is handed.

**Defers:** SMS role (Phase 3), iOS Live Caller ID Lookup, call-log re-insert /
restore-to-system, hard auto-reject policy, conference PSTN (never — 1:1 only).
