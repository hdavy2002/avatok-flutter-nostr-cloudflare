# Call audit — build 10612 fails 100% of calls (`unknown factoryId null`)

**Date:** 2026-08-21 · **Environment:** production · **Severity:** P0, live
**Testers pulled:** hdavy2002@gmail.com, hdavy2027@gmail.com
**Verdict:** the owner was right — this is an **app regression**, not the emulator.

---

## 1. The headline

Build **10612** cannot place or answer a single call. Every attempt dies ~120–200 ms
after `call_started` with:

```
$exception_message = "Unable to getUserMedia: getUserMedia(): unknown factoryId null"
stage              = get_user_media_failed
```

| build | call_started | call_connected | getUserMedia failures |
|------:|-------------:|---------------:|----------------------:|
| 10593 | 11 | 7 | 0 |
| 10595 | 6 | 3 | 0 |
| 10597 | 2 | 0 | 0 |
| 10603 | 3 | 1 | 0 |
| **10612** | **9** | **0** | **9** |

Zero occurrences of this exception exist anywhere in the last 14 days on any build
other than 10612. First seen `2026-08-21T10:47:16Z`.

## 2. It is not the emulator

The same exception fired on a **real handset**:

| timestamp (UTC) | who | `$is_emulator` | device |
|---|---|---|---|
| 11:07:17.255 | hdavy2027@gmail.com | `True` | sdk_gphone64_arm64 |
| **11:07:24.955** | **hdavy2002@gmail.com** | **`False`** | **motorola edge 70 fusion** |

Two devices, two people, one build, identical message. Ship-gate rule 2 satisfied.

The emulator *did* separately have a broken audio HAL
(`ranchu: pcm_writei failed … I/O error`) — that was real and is now fixed (the
emulator had been reparented to `launchd` with no macOS mic entitlement to inherit;
it now runs as a child of Terminal.app). But it was a **second, independent** fault.
The Motorola proves it was never the cause.

## 3. Root cause

Commit **`9a4a7267` — "[STREAM-LANE-1] One WebRTC engine: swap flutter_webrtc for
GetStream's drop-in fork stream_webrtc_flutter"** (2026-08-21).

The swap was made to resolve a genuine `libjingle_peerconnection_so.so` duplicate at
`mergeReleaseNativeLibs` (run #608), on the stated premise that
`stream_webrtc_flutter` is *"literally `library flutter_webrtc;` with the same Dart
exports"*.

**The Dart surface matches. The native contract does not.**

- `flutter_webrtc` 0.12.x has **no concept of `factoryId`** — verified: `grep -rn
  "factoryId"` across the whole package returns nothing.
- `stream_webrtc_flutter` 3.x is multi-factory: native `getUserMedia` resolves a
  `PeerConnectionFactory` **by `factoryId`**, and a factory only exists once
  something has created one — in practice, `StreamVideo(...)` initialising.

All 16 Dart files were migrated (`package:flutter_webrtc` → 0 hits,
`package:stream_webrtc_flutter` → 16), **including the legacy Cloudflare call lane**
`core/calls/call_session.dart`. That lane calls
`navigator.mediaDevices.getUserMedia` directly and never creates a Stream factory.
So `factoryId` arrives as `null`, native finds nothing, and it throws.

Telemetry confirms these calls ran the legacy lane, not the Stream lane:

```
call_started → properties.provider = "cloudflare"   (all 9 failures, both roles)
```

…even though prod KV has `streamCallsEnabled = true` and `streamCallPilotPercent = 100`.
The gate at `features/avatok/place_1to1_call.dart:68` does delegate to
`StreamCallService`, but `features/avatok/chat_thread/calls.dart` (and the other
`CallScreen(` mount sites) has **no such gate** and pushes the legacy CallScreen
directly. The failing calls were placed from a chat thread.

APK check (pulled from the device, `base.apk`, 215 MB): the dex contains only
`io/getstream/webrtc/flutter/…`, no `cloudwebrtc` classes. Confirms exactly one
engine ships and it is the Stream fork.

## 4. Why the screen vanishes

`core/calls/call_session.dart:4539–4555`

```dart
} catch (e, st) {
  Analytics.error(code: e is TimeoutException ? 'media_timeout' : 'media_denied', …);
  _mediaDeniedNotice?.call();          // → the snackbar
  _endWith('ended', reason: 'media-denied');   // → pops the call screen
  return;
}
```

`_mediaDeniedNotice` is wired at `features/avatok/call_screen.dart:706-710` to the
literal string **"Microphone permission is needed to make a call"**, and
`_endWith('ended', …)` tears the screen down. Hence: outgoing screen disappears on
dial, incoming screen disappears on accept, snackbar both times.

**The message is a misdiagnosis.** The `catch` treats *every* `getUserMedia` failure
as a permission denial. Android had granted `RECORD_AUDIO` the whole time
(`dumpsys package … RECORD_AUDIO: granted=true`, appop `allow`). This copy cost three
rounds of chasing OS permissions and emulator audio that were never the problem.

## 5. Exposure

- **4 distinct people** are already on 10612.
- Prod KV `latestAppBuild = 10612`, so **every remaining Closed Alpha tester is being
  prompted to update into the broken build.**

## 6. Recommended actions

| # | Action | Note |
|---|--------|------|
| 1 | Roll `latestAppBuild` back to **10603** | stops new testers updating into a build with a 100% call failure rate. Production write — needs the owner's explicit go-ahead. |
| 2 | Fix the engine mismatch | either (a) create/obtain a Stream `PeerConnectionFactory` before the legacy lane's `getUserMedia`, or (b) revert `9a4a7267` and solve the `.so` collision with a packaging rule (`pickFirst`) instead of a package swap. (b) is the smaller, safer change. |
| 3 | Gate every `CallScreen(` mount site on `streamCallsEnabled` | 8 sites bypass the gate today; only `place_1to1_call.dart` honours it. |
| 4 | Split the failure copy | `media_denied` must not be the label for a `getUserMedia` throw. Report a real permission denial separately from an engine/hardware failure. |
| 5 | Refresh `app/pubspec.lock` | last touched 2026-08-19 (`5d28a893`); still pins `flutter_webrtc` and has no `stream_webrtc_flutter` or `stream_video*` entries. CI runs plain `flutter pub get` so it re-resolves and the build is unaffected — but the lock is lying about what ships. |

## 7. Reconciliation with the second audit (Stream-lane theory)

A parallel review concluded the cause is the **Stream lane's** lifecycle —
`stream_call_service.dart:54` mounting the call screen only after `call.join()`, and
`:95` doing the same on accept. Those are accurate readings of the code, but they are
**not what failed here, because that code never ran.**

Decisive evidence — every Stream-lane call event, whole project, last 3 days:

| event | count |
|---|---:|
| `stream_lane_client_connected` | 10 |
| `stream_lane_call_placed` | **0** |
| `stream_lane_call_accepted` | **0** |
| `stream_lane_call_connected` | **0** |
| `stream_lane_call_failed` | **0** |
| `stream_lane_call_ended` | **0** |

`StreamCallService.place1to1` emits `stream_lane_call_placed` as its **first**
statement (`stream_call_service.dart:40`), before any `join()`. Zero occurrences means
it was never entered. Meanwhile `call_started` — emitted only from
`core/call_telemetry.dart:451`, the legacy lane — fired 9 times with
`provider = "cloudflare"`. The second audit's own observation that "PostHog contains
no new `stream_lane_*` events" is the proof that the Stream lane was not involved.

Timing makes it sharper. On the emulator, `stream_lane_client_connected` landed at
`11:00:04.382Z` — **1.1 s after** the call had already failed at `11:00:03.257Z`. The
same inversion repeats across all five attempts. `StreamLane.init` is still connecting
while the legacy lane has already dialled, failed and popped. It also means a
connected Stream *client* is not a created `PeerConnectionFactory` — the fork creates
one when a call joins, and no call ever joined.

**Findings from that audit that are real and worth fixing** (just not this bug):

- `streamCallsEnabled` and `streamCallPilotEnabled` are **both true in prod**, which
  `remote_config.dart:164-170` explicitly says must never happen. Confirmed against
  live KV.
- `StreamLane.init` sets `_initStarted` before checking for an account id, with no
  retry (`stream_lane.dart:65`).
- Incoming/per-call subscriptions are not retained and cancelled.
- Background recovery picks the first stored Stream account on a shared device
  (`stream_push_glue.dart:156`) — collides with the per-account scoping rule.
- The Stream lane has no mic/camera preflight or Settings recovery.

Two more real users, `dorawise.39974@gmail.com` and `darylnorman.96036@gmail.com`,
are also on 10612.

## 8. Evidence index

- PostHog project 139917 (EU), events `rtc_error`, `$exception`, `call_started`,
  `call_ended`, window `2026-08-21 10:45–11:10 UTC`.
- `app/lib/core/calls/call_session.dart:4534-4555`
- `app/lib/features/avatok/call_screen.dart:706-710`
- `app/lib/features/avatok/place_1to1_call.dart:68-71`
- `app/lib/features/avatok/chat_thread/calls.dart:87-95`
- `app/android/app/build.gradle.kts:107-143`
- git `9a4a7267`, `185ec6e4`, `5d28a893`
