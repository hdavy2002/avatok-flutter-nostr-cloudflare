# Deep Investigation — Call + Messaging Failures (Sat ⇄ davy), 2026-07-05

Reported by owner (hdavy2002) after test session with Sat (s.rgoavilla@gmail.com, device "fogos").
Evidence: PostHog events 2026-07-03 → 2026-07-04 evening (both users) cross-checked against code.

## TL;DR — five distinct bugs, one common aggravator

Sat's device has chronically flaky connectivity (constant `hub_reconnect` / `inbox_resume_reconnect`
/ `party_reconnect` spam all evening) plus repeatedly invalidated FCM tokens
(`push_token_pruned` 404, `push_no_device reason=all_tokens_pruned`). That amplifies every bug
below, but each bug is real and reproducible in code.

---

## 1. "He called me and I heard no ring"

**Telemetry:** Sat's outbound calls at 18:20:38 (`avatok-536eaa7a`), 18:25:13 (`avatok-c85ed3b7`),
18:37:26 (`avatok-2810780b`) show `call_started` on Sat's side but **NO `call_place_ok`, NO
`call_push_sent`, NO `call_incoming_received` on davy's side**. Each ends `timeout-ringing` with
`ava_recept_skipped reason=unavailable`. The invite POST never reached the server — Sat's network
was down mid-dial (his hub was reconnecting at 18:20:35, 3s before the dial).

**Bug:** the caller UI plays ringback and "rings" for the full timeout even when the **place-call
POST failed** — the user gets no "couldn't reach server, check connection" error, and the callee
obviously never rings. Additionally, when the POST does succeed, delivery depends on FCM;
`push_no_device all_tokens_pruned` (hdavy2005, 18:41:55) means zero valid tokens → silent no-ring.
Push registration on davy's side also failed intermittently (`push_register_failed` 400 at 13:20 and
14:32 on 07-04, 401 at 01:29).

**Fix direction:**
- Fail fast in the dial UI when `POST /call/place` fails (distinct "network error" state, retry button) instead of fake-ringing to timeout.
- Server: when fan-out results in 0 delivered tokens (`push_no_device`), return that to the caller and surface "X can't be reached right now" immediately + trigger receptionist server-side instead of `ava_recept_skipped unavailable`.
- Client: aggressive FCM re-register on `push_token_pruned` push-back (token invalidation loop is recurring — see FIS_AUTH_ERROR memory from 06-29).

## 2. "Ava is taking your call → user is busy" + live calls suddenly dying

**Telemetry smoking gun (2 occurrences):**
- 07-04 18:49 `avatok-cdcc815d`: Sat accepts (18:49:11), both `call_connected` (18:49:16). Then Sat's app runs `call_session_extracted` + `call_started` **AGAIN for the same call** at 18:49:19 → the duplicate session joins the CallRoom as a 3rd peer → 2-peer cap busy-rejects it → Sat's client gets `call_busy_received`, sends `call_cancel_sent`, `ava_recept_skipped start_failed`, `call_ended busy` — **and this teardown kills the genuine live call**: davy `call_ended remote-ended-push` 18:49:26, Sat `rtc-disconnected` 18:49:43.
- Same pattern 07-03 18:26 (`avatok-23692246`): duplicate `call_started` on Sat at 18:26:19, `call_busy_received` 18:26:20, `call_ended busy` while davy stayed on the call.

**Mechanism:** the dedup guards in `push_service.dart` (~824-841: `gActiveCallId` check +
`_seenIncoming` window) only protect the **push** entry path. The duplicate session is created via
the **accept/foreground-service/restore path** (`call_backgrounded` → `call_fgs_started` →
second `call_session_extracted` in `call_session.dart:203`) — e.g. accepting from the full-screen
incoming UI AND the notification/FGS restore both constructing a CallSession. The second session
legitimately gets "busy" from the CallRoom's 2-peer cap, and the busy handler treats it as "callee
is busy" → cancels the WHOLE call and pings the receptionist, which then `start_failed`s because
the callId was already answered (`call_answered` KV flag). Caller sees "Ava is taking your call"
then "user is busy"; Ava never answers.

Separate benign case: 07-03 18:38:25 `call_incoming_autobusy` was true call-glare (both dialed each
other simultaneously) — CALL-GLARE-1 handling exists but davy still heard busy.

**Fix direction (highest priority):**
- Make session creation idempotent per callId at the CallSession/registry level (a global `activeSessions[callId]` check inside `CallSession.start()` / screen mount — not just in the push handler). A second construction for the same room must attach to the existing session, never dial the DO again.
- Busy handling: a `busy` received by a session whose callId matches an already-connected session must be ignored (it's self-inflicted), never propagate cancel/ended to the peer.
- Receptionist: when `start_failed` occurs, caller UI must not show "Ava is taking your call" first — sequence the UI on receptionist session-started ack, not on intent.

## 3. Mid-call disconnects and "lock-ups" at ~10s / 2:43

**Telemetry:**
- `avatok-ea5aef79` (07-04 18:50): connected 18:50:21, `call_reconnect_start` (Sat) 18:52:06 (~1:45 in) simultaneous with `hub_reconnect`+`party_reconnect` (his whole network dropped), `call_reconnect_fail` 18:52:36 (30s budget exhausted) → `reconnect_failed`; davy side `rtc-failed` 18:53:02.
- `avatok-c7579ce4` (07-04 18:45): connected 18:45:32; Sat's `call_progress` heartbeats STOP after 18:47:02 (media dead ~1:30 in) but the call screen stayed up; davy re-extracted the session mid-call at 18:48:06 (duplicate-session bug again) and finally hung up 18:48:15 — **exactly 2:43 after connect**. This is the owner's "locks up at 2.43 min" call: media froze ~90s in, UI stayed frozen for another minute+.

**Mechanism (code):** `call_session.dart` has no media-flow watchdog — RTC state can stay
"connected" (or silently die) while no audio flows; the only detection is ICE state change or the
30s reconnect budget. 15s WS ping (`call_session.dart:690`) + reconnect ladder explains the
10s-ish early deaths (ICE fails right after connect on bad NAT/network before TURN fallback).

**Fix direction:** add a media watchdog (poll `getStats` audio bytesReceived every 5s; 2 stale polls
→ show "reconnecting", trigger ICE restart; 4 → end with clear reason). Log a `call_media_stalled`
telemetry event. Surface network-quality indicator to users.

## 4. Hangup / minimize / back buttons dead during a call

**Code findings (`call_screen.dart`, `call_session.dart`, `zine_widgets.dart`):**
- Hangup: `_hangup()` → `endByUser()` (`call_session.dart:1004`) → `await hangup()` → `_teardown()` which `await _pc?.close()` (line 1223) and `await _ws?.sink.close()` (line 1224) **with no timeouts**. When RTC/WS are in the half-dead state of bug #3, these awaits can hang indefinitely → `onRequestPop` never fires → screen never closes. Matches "button does nothing, must force-exit".
- Back: `PopScope(canPop:false)` (`call_screen.dart:404`) routes back → `_minimize()` → `Navigator.maybePop()`; if a hung `endByUser()` teardown is mid-flight or the route is already popping, this silently no-ops. `ZinePressable` (`zine_widgets.dart:54-56`) keeps `pressedColor: Zine.lime` while `_down=true` — if the gesture's `onTapUp` is starved, the button stays **green** — exactly what the owner saw.
- Minimize: same `Navigator.maybePop()` no-op under the same conditions.

**Fix direction:** wrap `_pc.close()` / `_ws.sink.close()` in `.timeout(3-5s, onTimeout: (){})`;
call `onRequestPop` BEFORE the slow teardown (pop the UI instantly, tear down in background);
re-entrancy guard on PopScope; force `_down=false` on dispose in ZinePressable.

## 5. Sat's sent messages disappearing from his own thread

**Code findings:**
- `dm.dart send()` (54-62): optimistic drift insert (try/catch **swallows failures**) + fire-and-forget `unawaited(_post(...))`. **No outbox, no retry.** On HTTP/network failure only a `sendStatus ok:false` stream event fires → message marked `.failed`.
- `chat_thread.dart _persistNow()` line 1275: `if (m.uploading || m.failed) continue;` — **failed messages are deliberately excluded from the warm cache**. Reopen → gone.
- Server side is correct (sender echo to own InboxDO exists, `messaging.ts:307`), but if the POST never reached the server there is nothing to sync back.

**Timeline fit:** Sat's device was reconnecting constantly all evening — his sends failed silently,
looked sent while thread open (optimistic row), then vanished on reopen. Recipient never notified
because message never reached the server (and his FCM tokens were pruned anyway).

**Fix direction:** real outbox — persist queued sends (drift table `outbox`), retry with backoff on
reconnect (`hub_reconnect` is the natural trigger), show explicit "not sent — tap to retry" state,
and NEVER drop a failed message from persistence.

---

## Priority order

1. **Duplicate CallSession per callId** (bug 2) — actively kills good calls and produces the fake busy/Ava sequence.
2. **Teardown timeouts + pop-first hangup** (bug 4) — unusable UX, trivial fix.
3. **Outbox for messages** (bug 5) — silent data loss.
4. **Dial-time failure surfacing + push_no_device handling** (bug 1).
5. **Media watchdog** (bug 3) — turns "mystery lockups" into visible reconnects.

## Key telemetry references

- Failed no-ring dials: `avatok-536eaa7a`, `avatok-c85ed3b7`, `avatok-2810780b` (07-04 18:20–18:38)
- Duplicate-session busy kills: `avatok-cdcc815d` (07-04 18:49), `avatok-23692246` (07-03 18:26)
- Reconnect death: `avatok-ea5aef79` (07-04 18:52)
- 2:43 freeze: `avatok-c7579ce4` (07-04 18:45–18:48)
- Token loss: `push_no_device all_tokens_pruned` hdavy2005 07-04 18:41:55; `push_register_failed` 400/401 hdavy2002 07-04
