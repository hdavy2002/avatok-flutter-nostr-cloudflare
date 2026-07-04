# Call Background + PiP Manual Test Matrix

**Date:** 2026-07-04 · **Tester:** Agent F (QA verification) · **Device:** Android 13+ physical device
**Target:** Full manual verification of Waves 1–2 call backgrounding, minimize, reconnect, and Gemini Live parity.

---

## Test Environment Setup

- **Device:** Android 13+ (API 33+; ideally both 13 and 15 for coverage)
- **App:** avaTOK staging APK or debug build from Wave 2 commits
- **Test user:** hdavy2005@gmail.com (or a peer to call)
- **Peer user:** A second account on a desktop/laptop/second device (can be the same account in a browser or another physical device)
- **Network:** WiFi + cellular available for blip tests; airplane mode toggle available

### Pre-Test Checklist

1. Clear app cache / reinstall fresh (`adb shell pm clear ai.avatok.avavoiceaudio`)
2. Verify PostHog is connected (check user hdavy2005@gmail.com in PostHog dashboard 139917)
3. Enable airplane mode toggle, WiFi toggle, and USB debugging on for live logs: `adb logcat -s "AvaVoiceAudio|CallSession|CallRoom"`
4. Open the PostHog events page for user email so telemetry is visible in real-time (filter by user, sort by recent)

---

## Test Suite

### T-1: Audio Call Backgrounded (Pre-Connect)
**Scenario:** Outgoing audio call, backgrounded WHILE STILL RINGING (no P2P connection yet).

**Steps:**
1. Start an outgoing audio call to the peer (red dial button)
2. See "Ringing…" + ringback playing
3. Press the Home button (app goes to background)
4. Wait 2 seconds
5. Return to the app (tap the ongoing-call notification, or use recents)

**Expected Results:**
- Notification visible while backgrounded (title shows peer name, with running chronometer AFTER connect)
- Call STILL RINGS or CONNECTS (audio continues if it connected during background stint)
- Returning to the app resumes the full call screen
- Peer receives the call and can answer

**Telemetry to verify (PostHog):**
- `call_session_extracted` (once, at dial)
- `call_fgs_started` {at: "dial", is_video: false}
- `call_backgrounded` {connected: false} (at Home button)
- `call_restored` (on return)
- NOT yet `call_bg_survived` (not connected yet)

**Pass/Fail:** ✓ / ✗

---

### T-2: Audio Call Backgrounded (Post-Connect)
**Scenario:** Outgoing audio call, backgrounded AFTER P2P connects.

**Steps:**
1. Outgoing audio call to the peer
2. Peer answers; call goes `connected` (both sides show media flowing, both hear each other)
3. Press Home (app backgrounded)
4. Wait 3 seconds (call continues, audio two-way)
5. Return to the app

**Expected Results:**
- Notification visible with running chronometer (started from the moment peer answered)
- Audio CONTINUES both ways while backgrounded (peer can talk to you, you hear them; if you have earpiece active, mic works)
- Android green microphone indicator visible in status bar (OS native, not app-drawn)
- No reconnect needed (the call stays `connected` the whole time)
- Returning shows the full call screen, timer continues from where it was

**Telemetry to verify (PostHog):**
- `call_session_extracted`
- `call_fgs_started` {at: "dial"}
- `call_backgrounded` {connected: true}
- `call_restored`
- `call_bg_survived` {video: false, elapsed_s: ≥3} (fired on resume, proves it survived)

**Pass/Fail:** ✓ / ✗

---

### T-3: Video Call Backgrounded (Post-Connect)
**Scenario:** Outgoing video call, backgrounded after P2P connects.

**Steps:**
1. Outgoing video call
2. Peer answers; video is visible (both remote video showing + local self-preview)
3. Press Home (app backgrounded)
4. Wait 3 seconds
5. Return to the app (tap notification or recents)

**Expected Results:**
- Notification visible, chronometer running
- Audio continues (full duplex, both hear each other)
- Returning shows the full video call screen, video streams resume/re-attach instantly
- Local and remote video renderers still alive (not disposed during background)

**Telemetry to verify (PostHog):**
- `call_session_extracted`
- `call_fgs_started` {at: "dial", is_video: true}
- `call_backgrounded` {connected: true, video: true}
- `call_restored` {video: true}
- `call_bg_survived` {video: true}

**Pass/Fail:** ✓ / ✗

---

### T-4: In-App Navigation During Audio Call (No Minimize)
**Scenario:** Audio call is live. Navigate to chat list, send a message, return to call, WITHOUT minimizing.

**Steps:**
1. Audio call `connected`
2. Tap the green **ongoing call pill** at the top (or swipe down to see it)
3. Open a chat thread (tap a message, open chat)
4. Type and send a message while the call is active
5. Return to the call (tap the pill, or back gesture)

**Expected Results:**
- Green pill visible on every screen (chat, chat thread, settings, etc.)
- Pill shows elapsed time (chronometer ticking)
- Audio never drops (both sides hear each other the whole time)
- Message sends successfully
- Returning to call view shows uninterrupted session

**Telemetry to verify (PostHog):**
- `call_session_extracted`
- `call_restored` (if you navigated away and back to call_screen)
- No `call_minimized` event (you didn't tap the minimize button)

**Pass/Fail:** ✓ / ✗

---

### T-5: In-App Navigation During Video Call with PiP Minimize
**Scenario:** Video call live. Minimize via back gesture, see PiP, navigate, return.

**Steps:**
1. Video call `connected`, full screen showing remote video + self-preview
2. Press Back (or tap the ⌄ minimize header button)
3. See the video **draggable PiP thumbnail** (remote video showing in a floating card)
4. Open Chat → open a message thread → send a message
5. Tap the PiP thumbnail to return to full screen

**Expected Results:**
- Back gesture minimizes (does NOT hang up); PiP appears immediately
- PiP thumbnail is draggable: drag to snap against the screen edges
- PiP shows remote video; tap to return to full screen
- Audio continues while PiP is shown; peer hears you
- Returning to full screen resumes uninterrupted

**Telemetry to verify (PostHog):**
- `call_session_extracted`
- `call_minimized` {video: true} (fired when back was pressed)
- `call_pip_dragged` {video: true, position: 'left|right|top|bottom'} (if you dragged it)
- `call_restored` {video: true} (when you tapped PiP to return)

**Pass/Fail:** ✓ / ✗

---

### T-6: Airplane Mode 5-Second Blip (Recovers)
**Scenario:** Call is connected. Toggle airplane mode for 5 seconds. Call should reconnect automatically.

**Steps:**
1. Audio or video call `connected`, both hear/see each other
2. Enable airplane mode (Settings → Airplane Mode toggle on)
3. Wait 5 seconds (see "Reconnecting…" appear on screen briefly)
4. Disable airplane mode (toggle off)
5. Wait 10 seconds for reconnect to complete

**Expected Results:**
- Network drops immediately → phase goes to `reconnecting` (UI shows "Reconnecting…")
- After ≤5 s, call re-establishes (ICE restart, peer-away grace period expires but no peer-left fired yet)
- Media resumes flowing
- "Reconnecting…" overlay clears
- Both sides hear/see each other again

**Telemetry to verify (PostHog):**
- `call_reconnect_start` (when WS dropped)
- `call_reconnect_ok` {attempt: 1, elapsed_ms: ~3500} (after ICE restart succeeds)
- `call_peer_away` (optional, if grace-period timer fired at peer side)
- `call_peer_rejoined` (if peer-away was fired, rejoin cancels it)

**Pass/Fail:** ✓ / ✗

---

### T-7: Airplane Mode 40-Second Blip (Clean Peer-Left)
**Scenario:** Call is connected. Toggle airplane mode for 40 seconds (exceeds the 30 s grace period). Peer should see `peer-left` cleanly.

**Steps:**
1. Audio call `connected`
2. Enable airplane mode
3. Wait 35 seconds (grace period will expire on the DO side)
4. Disable airplane mode (toggle off)
5. Check the peer's screen (if you have it visible)

**Expected Results:**
- First 30 seconds: "Reconnecting…" shown locally
- At ~31–35 s: local hangup fires (reconnect gives up) OR peer receives `peer-left` and shows "Call ended"
- Peer's side: no phantom-busy, call is cleanly ended with a reason
- Returning to calling history shows the call with proper duration

**Telemetry to verify (PostHog) — local device:**
- `call_reconnect_start`
- `call_reconnect_fail` {elapsed_ms: ~30000, attempts: 7} (after 30 s timeout)
- `call_fgs_stopped` {reason: 'reconnect_failed'}

**Telemetry — peer device (if visible):**
- `call_peer_away` (at first WS drop)
- `call_peer_left` (at 30 s expiry, no rejoin)
- `call_fgs_stopped` {reason: 'peer-left'}

**Pass/Fail:** ✓ / ✗

---

### T-8: Hangup from Notification
**Scenario:** Call is backgrounded. User taps "Hang up" action on the notification.

**Steps:**
1. Audio call `connected`, backgrounded (Home button)
2. Swipe notification panel down
3. See the ongoing-call notification (title = peer name, chronometer visible)
4. Tap the **"Hang up"** action/button on the notification

**Expected Results:**
- Call ends immediately
- Notification disappears
- FGS stops
- Calling history shows the call with correct duration
- If peer is still on the call, they see `peer-left` / "Call ended"

**Telemetry to verify (PostHog):**
- `call_notification_hangup` {call_id: ...} (fired by native, pre-callback)
- `call_fgs_stopped` {reason: 'hangup' or 'notification_hangup'}
- Calling history entry

**Pass/Fail:** ✓ / ✗

---

### T-9: Notification Tap Return to Call
**Scenario:** Call is backgrounded. User taps the notification BODY (not an action).

**Steps:**
1. Audio call `connected`, backgrounded
2. Tap the ongoing-call notification (tap the title/body area, NOT the "Hang up" button)

**Expected Results:**
- App comes to foreground (or launches if killed)
- Call screen opens, showing the active call (still `connected` or reconnecting)
- If the call was still connected, no interruption (media continues)
- Audio flows normally

**Telemetry to verify (PostHog):**
- `call_notification_tap` {call_id: ...} (fired by native, pre-callback)
- `call_restored` (if the app was backgrounded and the view re-syncs)

**Pass/Fail:** ✓ / ✗

---

### T-10: Account Switch Mid-Call
**Scenario:** Call is active. Switch to a different account (e.g., parent ↔ child on same device).

**Steps:**
1. Audio call `connected` on account A
2. Open Settings → Account Switcher (or swipe left on the home tab)
3. Select account B
4. Confirm the switch (the app re-initializes for account B)

**Expected Results:**
- Call on account A is cleanly hung up (`hangup('account-switch')`)
- Account B's home screen opens (no stale call state)
- Calling history shows account A's call with correct end time
- No crashes, no phantom-busy state left behind

**Telemetry to verify (PostHog) — account A:**
- `call_fgs_stopped` {reason: 'account-switch'}
- Call logging

**Pass/Fail:** ✓ / ✗

---

### T-11: Second Incoming Call While Minimized (Busy Auto-Reply Fires)
**Scenario:** First call is minimized (PiP shown). A second incoming call arrives. The app should auto-reply busy to the second caller.

**Steps:**
1. Start a call with peer A, get to `connected` with video PiP (minimized)
2. From a different device/account, have peer B call the same user
3. Watch the app behavior

**Expected Results:**
- Second incoming call notification appears (or push received)
- The push handler detects `gLiveCallScreens > 0` (phantom-busy protection)
- Second caller (peer B) hears "User is busy" or sees declined status
- First call (peer A) continues uninterrupted
- No second call screen is pushed/shown

**Telemetry to verify (PostHog):**
- `call_busy_reply` or similar phantom-busy event (if telemetry is added)
- First call's timeline unaffected

**Pass/Fail:** ✓ / ✗

---

### T-12: Screen Off for 5 Minutes (FGS Survives)
**Scenario:** Call is backgrounded. Lock the screen and leave it locked for 5 minutes. Call should survive (on Android, FGS + WS keep it alive).

**Steps:**
1. Audio call `connected`, app backgrounded (Home button)
2. Lock the screen (Power button, or auto-lock after 30 s)
3. Wait 5 minutes (call continues behind locked screen)
4. Tap the notification or unlock the device
5. Return to the app

**Expected Results:**
- Notification remains visible (chronometer ticking)
- Audio continues (peer can hear mic input)
- Returning to the app shows the full call, timer continues from the elapsed time
- No automatic hang-up from OS doze / battery optimization

**Telemetry to verify (PostHog):**
- `call_backgrounded` (when Home was pressed)
- `call_restored` (when you returned)
- `call_bg_survived` (if connected when you went background and still connected on return)

**Pass/Fail:** ✓ / ✗

---

### T-13: Gemini Live Voice Call Backgrounded
**Scenario:** Start a Gemini Live voice call (AvaChat → tap Ava's voice icon). Background the app. Call should survive.

**Steps:**
1. Go to AvaChat (Home → Chat tab)
2. Open the Ava thread (or create one)
3. Tap the green voice icon (Gemini Live call initiates)
4. Say "Hi Ava" (call connects to Gemini Live backend)
5. Press Home (app backgrounds)
6. Wait 5 seconds
7. Return to the app (tap notification or recents)

**Expected Results:**
- Notification visible ("Ava" or "Voice call")
- Audio continues two-way (you hear Ava's responses)
- Returning to the app shows the active Gemini Live screen
- Conversation history shows the exchange

**Telemetry to verify (PostHog):**
- `glive_minimized` (if you minimized during the call)
- `glive_restored` (on return)
- `glive_bg_survived` (if you backgrounded while connected)

**Pass/Fail:** ✓ / ✗

---

### T-14: Gemini Live Voice Call with In-App Navigation
**Scenario:** Gemini Live call active. Minimize and navigate to chat list / settings. Return via the audio pill.

**Steps:**
1. Gemini Live voice call active
2. Swipe or press Back to minimize (audio pill shows)
3. Navigate to Chat list or Settings
4. Tap the green audio pill to return to Ava

**Expected Results:**
- Audio pill visible on all screens
- Conversation flows normally while minimized
- Returning to the Ava screen resumes uninterrupted
- Transcript/history shows the full exchange

**Telemetry to verify (PostHog):**
- `glive_minimized` {at_ms: ...}
- `glive_restored` {at_ms: ...}

**Pass/Fail:** ✓ / ✗

---

## Summary Checklist

| Test | Status | Notes |
|------|--------|-------|
| T-1: Audio pre-connect bg | ? | |
| T-2: Audio post-connect bg | ? | |
| T-3: Video post-connect bg | ? | |
| T-4: In-app nav audio (no minimize) | ? | |
| T-5: In-app nav video + PiP minimize | ? | |
| T-6: Airplane 5s (reconnect) | ? | |
| T-7: Airplane 40s (peer-left) | ? | |
| T-8: Hangup from notification | ? | |
| T-9: Notification tap return | ? | |
| T-10: Account switch mid-call | ? | |
| T-11: 2nd incoming while minimized (busy) | ? | |
| T-12: Screen off 5 min | ? | |
| T-13: Gemini Live bg | ? | |
| T-14: Gemini Live nav | ? | |

---

## Known Issues / Divergences

**DIVERGENCE #1: Gemini Live session not in CallSessionManager**
- Agent E's `LiveVoiceController` is self-sufficient and registers its own notification callbacks
- The shared audio pill (Agent C) only observes `CallSessionManager.active` (P2P calls)
- A Gemini Live call's audio pill is NOT yet in the shared overlay (this is noted as a Wave 2+ follow-up in the task brief)
- **No fix required for this wave — documented for follow-up**

**DIVERGENCE #2: Notification callbacks NOT wired in P2P CallSession**
- `NativeVoiceAudio.instance.onNotificationHangup` and `onNotificationTapReturnToCall` are registered per-session in `LiveVoiceController`, but NOT in `CallSession`
- Per the API spec (`Specs/CALL-SESSION-API.md` "WS-B integration" §5), they should be registered in `CallSessionManager` (constructor or early init) once so both P2P and Gemini Live can coexist safely
- **This is a BLOCKING BUG for notification callbacks on P2P calls** — WS-A needs to wire these before production
- Workaround: register them in the manager's constructor

---

## Regression Tests

After each major change (e.g., post-Wave 2 fixes), re-run:
- **T-2** (audio background post-connect) — the most critical flow
- **T-5** (video PiP + in-app nav) — PiP stability
- **T-6** (reconnect 5 s) — WS recovery
- **T-8** (notification hangup) — FGS lifecycle

---

## Notes for Reviewer

1. **PostHog dashboard:** Create an annotation at the start of testing with test date + commit hash + note "Wave 2 QA manual tests (F)".
2. **Device logs:** Capture `adb logcat` snippets for key transitions (bg→fg, reconnect_start→ok, etc.) as attachments to the PostHog annotation.
3. **Known Phantom-Busy Protections (do NOT regress):**
   - `gLiveCallScreens` counter = number of active call screens + sessions
   - A push handler checks `callIsGenuinelyActive()` before pushing a second call
   - On account switch, `clearCallState()` zeros the counter
4. **Telemetry Verification:** Use PostHog's filter for user email + time range + event name to confirm each step fires the right events.

