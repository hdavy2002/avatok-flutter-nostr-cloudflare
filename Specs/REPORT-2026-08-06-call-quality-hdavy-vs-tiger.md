# Call quality post-mortem — 2026-08-06 afternoon, hdavy2002 ↔ Tiger Showoff

**Participants**
- `hdavy2002@gmail.com` — motorola edge 70 fusion, Dehradun, JIO SIM
- `s.rgoavilla@gmail.com` ("Tiger Showoff") — moto g45 5G, Mumbai

**Window** 11:45:26 – 12:16:31 UTC (17:15 – 17:46 IST). Both devices on AvaTOK 0.1.18,
**build 10519** (media events stamped 10518 mid-session; same release train).

**Evidence** PostHog project 139917 — `call_media_health`, `call_media_flow_state`,
`call_network_handover`, `call_sfu_fallback`, `call_qos_bitrate_changed`,
`call_audio_red_negotiated`, `rtc_error`. Live prod flags read cache-busted from
`https://api.avatok.ai/api/config`. Code read at `app/lib/core/calls/call_session.dart`,
`app/lib/core/calls/call_sfu_transport.dart`, `app/lib/core/audio_tuning.dart`.

---

## 1. What actually happened — seven calls, not one

The session was **seven separate call sessions in 31 minutes**, not one call that kept
cutting. That is why it felt like being "cut off many times".

| # | call_id | Direction | Connected | Duration | Outcome |
|---|---------|-----------|-----------|----------|---------|
| 1 | `avatok-f52e60f1` | Tiger → Davy | yes | ~38 s | died on Davy's **WiFi → cellular** flip |
| 2 | `avatok-8ed2b95f` | Davy → Tiger | never | ~16 s | SFU `setRemoteDescription … state: closed` → `connect-timeout-fast` |
| 3 | `avatok-174c6bfa` | Tiger → Davy | never | ~3 s | glare, superseded — never rang on Davy's phone |
| 4 | `avatok-597ba662` | Davy → Tiger | yes | 4 m 15 s | died 133 ms after Davy's **cellular → WiFi** flip |
| 5 | `avatok-ccf9df71` | Davy → Tiger | never | ~13 s | busy — Tiger's client still held the dead call #4 |
| 6 | `avatok-701e404b` | Davy → Tiger | never | ~16 s | same `state: closed` SDP failure as #2 |
| 7 | `avatok-c7cdc3ea` | Tiger → Davy | yes | **22 m 06 s** | clean, deliberate hangup |

Once both phones settled on WiFi (call 7), the call ran for 22 minutes and was
**media-clean**: MOS 4.37–4.39 on both sides, 0.0 % packet loss on 175 of 177
five-second samples, jitter 2–5 ms. That is a good call by any standard.

So: the app is not broadly broken. It broke in two specific, reproducible ways.

---

## 2. The handover silence — confirmed, and it is a code bug

**This is the highest-confidence finding, and it explains both dropped calls.**

Davy's phone flipped interface twice during the session, and both flips killed a live call:

```
11:46:32.755  hdavy  call_reconnect_start      avatok-f52e60f1  wifi
11:46:34.365  hdavy  call_ended  reason=ended  avatok-f52e60f1  cell   ← 1.6 s later
11:46:34.895  hdavy  call_network_handover     avatok-f52e60f1  cell   ← fired AFTER the hangup
11:46:37.952  tiger  call_media_stalled        avatok-f52e60f1
11:46:38.099  tiger  call_ended  reason=ended                          ← 3.7 s of silence on Tiger's side
```

```
11:51:59.478  hdavy  call_network_handover     avatok-597ba662  wifi
11:51:59.611  hdavy  call_ended  reason=ended                          ← 133 ms later
11:52:00.289  tiger  call_peer_away
11:52:08.848  tiger  call_media_stalled                                ← 8.5 s of silence
11:52:09.294  tiger  call_ended  reason=ended
```

Across the entire session there is **not one** `call_recovery_started`,
`call_recovery_offer`, `call_recovery_failed`, `call_recovery_exhausted` or
`call_relay_migration_*` event. The whole `[CALL-SURVIVE-1]` survival ladder — the
2/4/8/16/30 s backoff, 5 attempts, relay migration, the 30 s `callRecoveryDeadlineSec`
that is live in prod KV — **never ran a single time**.

### Why it never ran

`callSfuV1` is `true` in production (verified live). Every 1:1 call in this session shows
`media_path = sfu`. And `_requestRecovery()` short-circuits before any of the survival
machinery:

```dart
// call_session.dart:3994
Future<void> _requestRecovery(RecoveryReason why) async {
  if (_sfuActive) {
    await _reconnectSfu();   // one shot, terminal on failure
    return;
  }
```

`_reconnectSfu()` (`:4947`) closes the old peer connection **first** (`:4954-4956`), then
tears down and rebuilds the whole Cloudflare SFU session (`transport.reconnect()` =
`dispose(); connect();`). On failure it calls `_endWith('ended', reason:
'sfu-reconnect-failed')` at `:4978`. No retry, no migration, no ladder.

### And it ends the call even when it is trying to save it

Closing that old PC fires the PC's own `onConnectionState` → `Closed` handler at
`call_session.dart:3840`, whose only guard is `if (_ended || !_connected) return;`.
`_connected` is never cleared during a reconnect and there is **no PC-generation check**
(one exists on `onTrack` at `:4814`, but not here). So the deliberate teardown re-enters
`_endWith('ended')` on the live session and hangs up the call we were mid-rescue on.

That produces exactly the observed shape — audio stops the instant the interface flips,
then `call_ended` with the innocuous reason `ended` (which is why this has been reading
as a normal hangup in dashboards, not as a failure).

### Three further defects on the same path

1. **No make-before-break.** Even a *successful* SFU reconnect closes the old PC before
   the new session pulls audio, then polls `_awaitPeerAudio()` for up to 6 s
   (`call_sfu_transport.dart:152`). Best case that is several seconds of dead air.
2. **The peer is never told the track names changed.** SFU track names are
   `'audio-$sid'` (`call_sfu_transport.dart:140`) and `reconnect()` mints a new `sid`.
   Nothing signals the peer to re-pull. A "successful" handover therefore leaves
   **one-way audio permanently** — you hear them, they hear nothing — with no error
   event anywhere. (Same class of bug as the group-call track-name trap fixed 2026-08-03.)
3. **Mid-call SFU collapse cannot fall back to P2P at all.** Both `sfu-abort` handling
   (`:5232`) and `_startP2pOffer` (`:5246`) are guarded by `!_connected`. Once connected,
   an SFU failure can only end the call.

### Asymmetric teardown poisons the redial

Davy's client ended call 4 at 11:51:59.611; Tiger's only ended at 11:52:09.294 — **9.7 s
later**. Davy redialled at 11:52:05 and hit `call_same_caller_retry_suppressed
reason=already_in_call` → `call_busy_received`. Call 5 was a direct casualty of call 4's
teardown, not an independent failure. The identical pattern repeats at 12:16:22 after
the good call.

---

## 3. Sound "coming and going" — two distinct causes

The 22-minute call was media-clean, so the intermittent audio was **not** packet loss.
Two things account for it:

### (a) Android audio focus stolen and never returned — Tiger's side

```
12:03:04.707  tiger  call_audio_focus_lost
12:03:10.707  tiger  call_audio_focus_hold_released  reason=watchdog_no_regain
12:03:33.121  tiger  call_restored     ← no preceding call_minimized
12:03:40.577  tiger  call_restored
```

Focus was taken by another app, the 6 s watchdog gave up waiting, and focus was **never
regained** — `call_media_flow_state` stayed `rtp_flowing` throughout, so RTP kept
arriving while nothing was audible. The same signature appeared in call 4 at
11:49:49.810. This is a ~30 s hole of one-way silence with no transport fault, and today
there is **no recovery path at all** once `watchdog_no_regain` fires.

### (b) A brief symmetric RTP dip at the video upgrade

```
11:54:11.236  hdavy  call_sfu_video_upgraded
11:54:26.214  tiger  rtp_flowing → rtp_observed
11:54:26.691  hdavy  rtp_flowing → rtp_observed
11:54:31.223/691    both back to rtp_flowing        ← ~5 s degraded, both sides
```

Plus two isolated concealment spikes on Davy's side: 29.5 % at 12:03:36 (jitter 22 ms)
and 18.3 % at 12:08:36 with a **986 ms** inter-packet gap — Tiger saw the same event
with a 527 ms gap. That is a single ~1 s network hiccup on the shared path, symmetric,
recovered by itself. Two blips in 22 minutes; not the main complaint.

The earlier calls carry the real degradation. Call 4 (Davy on cellular) fired
`call_quality_poor` at 11:51:44.488 — and **`call_quality_recovered` never fires
anywhere in the session**.

---

## 4. RED — yes, it is measurably eating bandwidth, on cellular specifically

`callAudioRedExperimentV1 = true` in prod (verified live). RED is applied
**unconditionally** — `audio_tuning.dart` has no loss, RTT or interface predicate; the
only gate is the flag plus local RFC-2198 capability. Distance is 1, i.e. one redundant
block per packet, and the sender cap is padded to match:

```dart
// audio_tuning.dart:59
int avaAudioSenderCapBps(int opusTargetBps, {required bool redActive}) =>
    redActive ? opusTargetBps * (kOpusRedDistance + 1) : opusTargetBps;
```

Measured from `call_media_health.audio_bytes_sent_delta` over the session:

| call | leg | network | avg send | peak send |
|------|-----|---------|----------|-----------|
| `597ba662` | **Davy** | **cell** | **55.6 kbps** | **80.5 kbps** |
| `597ba662` | Tiger | wifi | 28.2 kbps | 39.1 kbps |
| `c7cdc3ea` | Davy | wifi | 28.1 kbps | 38.9 kbps |
| `c7cdc3ea` | Tiger | wifi | 25.7 kbps | 40.3 kbps |
| `f52e60f1` | Davy | wifi | 31.3 kbps | 37.6 kbps |

All legs run 50 pps (20 ms ptime). **The cellular leg sent almost exactly double every
WiFi leg, peaking at 80.5 kbps — the RED wire cap to the byte.** And it is the only leg
that fired the QoS ladder:

```
11:48:02.954  hdavy  call_qos_bitrate_changed  max=32 wire=64  opus_red_active=true  ← downshift
11:48:27.955  hdavy  call_qos_bitrate_changed  max=40 wire=80  opus_red_active=true  ← back up
```

So on the cellular leg the congestion detector saw congestion, cut the rate, and put it
straight back — while RED kept the wire demand at 2×.

**The mis-measurement.** The congestion check at `call_session.dart:1842-1845` compares
`availableOutgoingKbps` against the **Opus target (40)**, not the **wire cap (80)**. On a
link with ~70 kbps of headroom the ladder reads "not congested" while the sender is
actually asking for 80. RED is unconditional on exactly the constrained links where
doubling the wire rate is most harmful.

**Caveat, stated honestly:** `call_audio_red_negotiated` only fires on the P2P SDP path
(`call_session.dart:2559`). The SFU publish path applies RED at
`call_sfu_transport.dart:217` with **no telemetry**, so for the SFU calls RED activity is
inferred from `opus_red_active` on `call_qos_bitrate_changed` and from the byte rates
above, not observed directly. Adding the emit on the SFU path would close that gap.

Worth knowing for context: before `[CALL-RED-1]` (2026-08-05) the RED branch was an empty
`if` body — the flag was on for days and RED was never actually on the wire. It has been
genuinely live for about one day. This session is among the first real data on it.

---

## 5. The failed connects — a separate, unrelated bug

Calls 2 and 6 failed identically, and neither involved a handover:

```
11:47:15.244  tiger  call_sfu_fallback  detail=Unable to RTCPeerConnection::setRemoteDescription:
                     WEBRTC_SET_REMOTE_DESCRIPTION_ERROR: Failed to set remote answer sdp:
                     Called in wrong state: closed
11:47:18.542  hdavy  call_offer_glare_detected
11:47:18.602  tiger  call_connect_watchdog_fired
11:47:18.604  tiger  call_ended  reason=connect-timeout-fast
```

`CallSfuTransport.connect()` checks `_disposed` at `:184` and `:231` but **not between
`publish` and `setRemoteDescription`** (`:221-227`). An in-flight `connect()` from a
previous attempt lands its `setRemoteDescription` on a PC that has already been closed
underneath it — the ownership split is racy because `dispose()` deliberately does not
close the PC (`:422-425`). Both times, the callee's 10 s `connect-timeout-fast` watchdog
then killed it.

Two cosmetic-but-misleading artefacts also showed up: Davy's client emitted
`call_connected` **333 ms after its own `call_ended`** (call 2) and
`call_transport_connected` **1.16 s after** (call 6). The state machine keeps advancing on
a dead session, which will corrupt any funnel built on these events.

---

## 6. Verdict against the three questions asked

| Question | Answer |
|----------|--------|
| "Cut off many times" | **Confirmed, two distinct causes.** Two live calls killed by interface flips (§2); four more never connected due to an SFU race + the asymmetric teardown that made redials hit busy (§5). Not one flaky call — seven sessions. |
| "Sound kept coming and going" | **Confirmed, not a network problem.** Android audio focus stolen and never regained (`watchdog_no_regain`) is the main one — RTP kept flowing the whole time. Plus a 5 s dip at the video upgrade and one ~1 s shared-path hiccup (§3). |
| "Is RED sucking up bandwidth?" | **Yes, on cellular.** The cellular leg sent 55.6 kbps average / 80.5 kbps peak against ~28 kbps on every WiFi leg — exactly 2× and exactly the RED wire cap. It is applied unconditionally, and the congestion detector measures against the un-padded target, so it under-reads congestion by half (§4). |
| "Handover to mobile data gave me silence" | **Confirmed and root-caused.** The survival ladder is bypassed entirely on the SFU path, and closing the old PC re-enters `_endWith('ended')` on the live session. Handover → hangup in 133 ms and 1.6 s, with the peer left in silence for 3.7 s and 8.5 s (§2). |

---

## 7. Recommended fixes, ranked

1. **Guard the `Closed` rung of `onConnectionState` with a PC-generation check**
   (`call_session.dart:3814-3846`, and the twin at `:4831`) so a deliberate
   `oldPc.close()` during an SFU reconnect cannot end the live call. Smallest diff,
   almost certainly the observed hangup.
2. **Give the SFU path the CALL-SURVIVE ladder.** `_requestRecovery:3994` should not
   short-circuit to a single terminal `_reconnectSfu`; `:4978` should route into
   `_scheduleSurvivalRetry` instead of `_endWith`.
3. **Re-announce track names to the peer after an SFU reconnect** — otherwise even a
   successful handover leaves one side permanently silent with no error.
4. **Make the SFU reconnect make-before-break** — don't close `oldPc` (`:4954-4956`)
   until the new session has pulled audio.
5. **Fix the RED/QoS mis-measurement** — compare available bandwidth against
   `avaAudioSenderCapBps(...)`, not the Opus target; and consider gating RED off below a
   bandwidth floor or on cellular. Flag-fixable today: `callAudioRedExperimentV1=false`
   is a one-command test of the cellular-bandwidth hypothesis.
6. **Add an audio-focus regain path** — `watchdog_no_regain` currently means permanent
   silence with the call still nominally healthy.
7. **Emit `call_audio_red_negotiated` on the SFU publish path** so RED engagement is
   observable on the path that actually carries production 1:1 calls.
8. **Stop advancing call state after `call_ended`** — the post-mortem `call_connected` /
   `call_transport_connected` emissions corrupt any funnel built on them.

Items 1–4 are code and need a CI build. Item 5 is testable immediately by flag.
