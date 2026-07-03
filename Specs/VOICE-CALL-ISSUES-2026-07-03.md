# Voice Call Issues — JD ↔ Davy test session (2026-07-03)

Investigation of call problems between `jdfilmdirector@gmail.com` (JD) and `hdavy2002@gmail.com` (Davy).
Telemetry source: PostHog events 2026-07-03 11:39–11:46 UTC (plus 06-30 → 07-02 history).
Code source: `app/lib/features/avatok/call_screen.dart`, `app/lib/core/audio_tuning.dart`, `worker/src/routes/*`.

---

## 1. What actually happened (telemetry timeline, 2026-07-03)

| Time (UTC) | Call ID | What happened |
|---|---|---|
| 11:39:11 | `f1bec0a0` | JD dialed Davy. **No `call_place_ok`, no `call_push_sent`** — the push to Davy never went out. JD hung up after 29s. Davy never rang. |
| 11:40:40 | `b87ebc96` | Same again — JD dialed, no push sent, hung up after 11s. |
| 11:41:36 | `015179f9` | JD dialed again. Push sent 11:41:38 → Davy's FCM received it 11:41:48 (**10s push delay**). Davy accepted 11:41:51, `call_connected` both sides 11:41:53–54. **But 5s later JD's client got `remote-ended-push`** and Davy's side died with `rtc-disconnected` at 11:42:16 — meanwhile the **receptionist had already spun up at 11:42:00 and hijacked the call**. This is the call where "I said hello and Ava took my call." |
| 11:42:02–11:42:55 | `015179f9` (Ava session) | Davy talked to Ava. Session shows `ava_recept_idle_nudge` 11:42:31 ("she came online again and asked me a question"), `ava_recept_wrap_cue` 11:42:42, ended `ended_remote` at 11:42:55 — the **60s soft cap** ended it, not Ava. This is "she would not sign off... waiting for her one min to finish." |
| 11:42:23 | `de09edbd` | JD called Davy back **while Davy was still in the Ava session** → Davy's device sent `call_incoming_autobusy` → **receptionist answered JD instantly** (`ava_recept_first_audio` 8s after dial). This is "Ava was supposed to pick up after 6 rings but she picked up right away." |
| 11:43:05 | `cb4af47c` | Davy → JD. Push→ring_ack 3.5s, JD accepted at +10s, connected at +12s. **This is JD's "no ring, only notification"** — his device got the FCM but the full ring UI/sound didn't fire (see §3). |
| 11:43:36 → 11:45:36 | `0c93fe6e`, `69f269b1`, `2d1c4faf`, `0bc12ea5` | Four successful calls, dial→connected 7–10s each. One `call_relay_fallback` (TURN) earlier in the day at 16:36 on 07-01. |

Also notable from 07-01/07-02: repeated `push_no_device` for JD (his push token was missing/stale for a period), several `call_ended reason=timeout-ringing` + `ava_recept_skipped reason=unavailable`, and `call_no_device` bursts from Davy at 17:58–18:00 on 07-01.

---

## 2. Root causes, issue by issue

### Issue A — Ava picked up immediately instead of after ~6 rings
Two separate mechanisms:
1. **Auto-busy path bypasses ring count entirely.** When the callee device is already in a call/Ava session, the client sends `call_incoming_autobusy` and the receptionist takes over with **zero ring delay**. That's what happened on `de09edbd` (Davy was still stuck in the Ava session from the hijacked call).
2. Configured ring count is **5 rings** (KV `receptionistRings`), not 6 — minor, but worth aligning with expectation.

**Fix direction:** when a call gets auto-busied, either (a) still play N rings to the caller before Ava answers, or (b) at minimum have Ava open with "Davy is on another call" so it doesn't feel like an instant intercept.

### Issue B — Ava wouldn't sign off after "no message"
**Ava has no way to hang up.** There is no end-call tool/function exposed to the model. The session ends only via: 10s idle timeout, 60s soft cap (`SESSION_CLOSE_MS`), or 90s hard cap (`HARD_CAP_MS`). So after "OK, I'll let him know," the session stayed open; the idle-nudge fired at ~30s and re-prompted Davy ("she came online again"), and the wrap-cue + soft cap finally closed it at ~60s. Exactly matches the telemetry (`idle_nudge` → `wrap_cue` → `ended_remote`).

**Fix direction:**
- Add an `end_call` tool the model can invoke, with prompt instruction: "once the caller confirms they're done (e.g. 'no message', 'tell him to call me'), say a single goodbye line and call `end_call`."
- Suppress the idle nudge once a closing line has been spoken.
- Keep the 60/90s caps as backstops only.

### Issue C — Callee got a notification but no ring
The push arrives (`fcm_bg_received`) and a banner shows, but the audible ring / full-screen incoming-call UI depends on: notification channel importance, full-screen intent permission (Android 14+ requires `USE_FULL_SCREEN_INTENT` grant), DND/audio mode, and battery optimization. `call_ring_ack` exists so the server can verify the device actually rang — on `cb4af47c` the ack came from the CALLER side only.
Also: JD's first two dials (`f1bec0a0`, `b87ebc96`) **never even sent a push** (no `call_place_ok` / `call_push_sent`) — likely stale route/socket on JD's freshly foregrounded app; his 3rd attempt logged `call_dial_suppressed reason=already_dialing` then went through.

**Fix direction:**
- Instrument the callee ring path: emit `call_ring_ack ok=false` with a reason (channel disabled, no full-screen permission, DND) so this is diagnosable.
- On dial, verify the signaling socket is live before showing "ringing"; the two silent failed dials should have surfaced an error to JD instead of ringback.
- Check full-screen intent permission on first run and prompt the user to enable it.

### Issue D — Caller sees a "buffering circle" then connects
That spinner is the normal `ringing` phase, but it runs long because setup is slow end-to-end: push send (+2–3s) → FCM delivery (+1–10s) → human accept (+3–8s) → offer/answer + ICE (+2s). Structural findings:
- **PeerConnection/offer is only created after the callee joins the room** — no pre-warming during ring.
- ICE pool is 2; TURN relay fallback only fires after a **7s** timer.
- Ringback on the caller only starts on peer-accept in some paths, so the early phase looks like buffering.

**Fix direction (connect speed):**
- Pre-warm: create the PeerConnection and start ICE gathering (`iceCandidatePoolSize` 4) on the CALLER as soon as dialing starts, and on the CALLEE as soon as the incoming push is displayed — accept then only exchanges SDP (saves 1.5–3s).
- Use full trickle ICE both ways (parallel gathering + connectivity checks).
- Drop the relay-fallback timer 7s → 4s.
- UX: show "Ringing…" with distinct state instead of a spinner, so slow-but-normal setup doesn't read as buffering.

### Issue E — JD's mic picked up lots of background noise
Current stack: WebRTC software NS/AEC/AGC flags are set (both W3C + `goog*` legacy keys) and Opus is tuned (40kbps, FEC, DTX, mono). But:
1. **Known flutter_webrtc limitation:** audio constraints are unreliably applied on Android; the platform `NoiseSuppressor`/`AcousticEchoCanceler` effects in `AvaVoiceAudioPlugin.kt` are only attached on the **native (Gemini Live) path, not on 1:1 P2P calls** — P2P relies solely on WebRTC's software NS.
2. WebRTC's built-in NS is a classic spectral suppressor — poor with babble/street noise (exactly "noise mixed with his voice").
3. DTX can chop word tails in noisy rooms; 40kbps is tight when NS leaves residual noise.

**Fix direction (voice quality), in priority order:**
1. **Ensure hardware DSP on P2P calls:** call `Helper.setAndroidAudioConfiguration(AndroidAudioMode.inCommunication, AndroidAudioFocusMode.gain)` at call start, confirm the capture source is `VOICE_COMMUNICATION` (which enables the device's own NS/AEC chain), and attach the platform `NoiseSuppressor`/`AEC` to the WebRTC audio session ID the same way the native engine does.
2. **Add ML noise suppression:** RNNoise (BSD, tiny, runs fine on mobile CPUs) as an audio processing hook on the send path — this is the step that actually kills background noise mixed with speech. (LiveKit ships Krisp for exactly this reason.)
3. Disable DTX (`usedtx=0`) and raise `maxaveragebitrate` to 48–64kbps for 1:1 (bandwidth cost is trivial for 2 peers).
4. Keep `useinbandfec=1`; consider adaptive bitrate via RTCRtpSender parameters based on `call_progress` stats (packet loss/RTT already collectable).

---

## 3. Recommended work items (in order)

1. **[RECEPT-END-TOOL]** Add `end_call` tool + prompt rule to the receptionist pipeline; suppress idle-nudge after closing line. (Issue B — most user-visible.)
2. **[CALL-ACCEPT-RACE]** Server-side arbitration: once callee sends `accept`, cancel any pending receptionist takeover for that call_id; receptionist must check "call already answered" before starting. (Issue A/B hybrid — the hijacked call.)
3. **[RING-DIAG]** Callee ring diagnostics: `call_ring_ack ok=false reason=...`; full-screen-intent permission check; error surface when dial fails to send push. (Issue C.)
4. **[P2P-AUDIO-DSP]** Android communication-mode + platform NS/AEC on P2P path; drop DTX; raise Opus bitrate. (Issue E, quick win.)
5. **[P2P-RNNOISE]** RNNoise on send path. (Issue E, real fix.)
6. **[CALL-PREWARM]** PeerConnection pre-warm on dial + on incoming push; relay timer 7s→4s; ICE pool 4. (Issue D.)
7. **[AUTOBUSY-UX]** Auto-busy → Ava opens with "on another call" line, or honors ring delay. (Issue A.)

## Sources (external research)
- [flutter_webrtc: audio constraints not respected on Android](https://github.com/flutter-webrtc/dart-sip-ua/issues/401), [Echo canceller issues on Android](https://github.com/flutter-webrtc/flutter-webrtc/issues/1433)
- [Noise reduction in WebRTC (Gcore)](https://gcore.com/blog/noise-reduction-webrtc) — RNNoise integration pattern
- [LiveKit noise & echo cancellation](https://docs.livekit.io/transport/media/noise-cancellation/) — why ML NS (Krisp) over built-in
- [Trickle ICE (webrtcHacks)](https://webrtchacks.com/trickle-ice/) — parallel gathering cuts setup seconds
- [Cloudflare Calls architecture](https://blog.cloudflare.com/cloudflare-calls-anycast-webrtc/) — 800ms global-average setup target
- [Android WebRTC audio processing guide](https://github.com/mail2chromium/Android-Audio-Processing-Using-WebRTC)
