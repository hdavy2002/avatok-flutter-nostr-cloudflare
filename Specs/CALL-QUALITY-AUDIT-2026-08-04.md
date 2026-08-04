# Call Quality Deep Audit — 2026-08-04

**Complaint:** tiger showoff (s.rgoavilla@gmail.com) called hdavy2002@gmail.com while on mobile data and moving. Voice kept breaking, sounded very distant, and twice there was **no voice at all while the call stayed up**.

**Verdict up front:** the dropouts were not random signal loss and not DTX. They were WiFi↔cellular handovers on his phone that the recovery system tried to survive and couldn't — and after ~50 seconds of dead air the app killed the call itself. The "distant" sound is an untuned jitter buffer running at 200–745 ms of delay on a lossy cellular path.

---

## The calls examined

Both users on build **10503**. Both legs relayed via Cloudflare TURN (his candidate `prflx`, yours `relay`, UDP).

| Call | Time (UTC) | Direction | Duration | Outcome |
|---|---|---|---|---|
| avatok-e23e3117 | 07:59–08:01 | he → you | ~2 min | ended normally (his complaint call) |
| avatok-999a650b | 08:06–08:14 | you → him | ~8 min | **killed: `relay_migration_timeout`** |
| avatok-10d4696b | 08:14–08:17 | you → him | ~3 min | **dead audio, you hung up** |

## Finding 1 — Network handover kills audio, and recovery fails (the two "no voice" moments)

At **08:13:39** and **08:17:18** his phone hopped WiFi→cell. Telemetry on his leg the same second: 0 bytes received, 100% concealment, last packet 4–15 s old.

The recovery machinery (`callIceRecoveryV2` + `callRelayMigrationV1` — **both confirmed ON in prod KV**) fired exactly as designed and still lost:

1. `call_recovery_started (transport_disconnected)` → ICE-restart attempt → **30 s deadline expired** (`call_recovery_failed`)
2. Escalation to relay migration → new relay-only PC + offer → **20 s deadline expired**
3. `call_ended reason=relay_migration_timeout` — the app terminated a call both humans were still holding, after ~50 s of silence.

### Why recovery loses on a moving phone

- **Network flap, no re-gather.** His network went wifi→cell→wifi→cell within ~40 s. Each recovery/migration attempt gathers ICE candidates on one interface; the next flap invalidates them mid-handshake. Nothing aborts and restarts the attempt on the new interface — it just burns its full deadline.
- **One migration per call, ever.** `_migrationAttempted` caps relay migration at one terminal attempt (plan §7.4.8). On a train that's a guarantee of death: the first attempt lands during the flap, fails, and the second failure is terminal.
- **Recovery signals arrive late.** His signaling WS was down ~17 s during the handover (`call_ws_reconnected` 08:13:50 vs recovery start 08:13:33). The DO buffers frames and replays them on reconnect — correct — but the replay ate most of the 30 s recovery budget.
- **Offerer election can pick the wrong peer.** The DO picks "original offerer unless away." A peer mid-handover in reconnect-grace may still be elected offerer — the one endpoint least able to complete a handshake.
- **Worst-case ladder = ~60 s dead air.** 10 s stall detection + 30 s ICE deadline + 20 s migration deadline, then self-termination.

## Finding 2 — "Distant / breaking" voice: jitter buffer and loss bursts

Your inbound leg during the healthy stretches:

- Jitter-buffer delay **200–745 ms**, sitting above 600 ms for a full minute of call 10d4696b. That is the "he sounds far away / underwater" symptom.
- Loss/concealment bursts: 33% loss interval at 08:15:02, 13.7% concealment at 08:00:09; his side hit 22% concealment. Concealed audio is synthesized audio — smeared and robotic.
- The client sets **no jitter-buffer bounds** (no `audioJitterBufferMaxPackets`, no fast-accelerate), so on flappy cellular the buffer balloons and never drains.

## Finding 3 — DTX is fixed; not a factor here

`[CALL-AUDIT-DTX-1]` (commit 443af535, 2026-08-03) is in build 10503. Telemetry confirms: continuous ~50 packets/s on healthy intervals even during silence — DTX is off. The old "quiet becomes nothing at all" failure mode is gone.

## Finding 4 — Opus bitrate regression on the 1:1 path

CALLFIX-17 (2026-07-03) decided **56 kbps**. The shared tuner (`app/lib/core/audio_tuning.dart`) still says 56000, but `call_session.dart._tuneOpusSdp` — the copy the 1:1 path actually uses — caps at **40000**. Less bitrate = less FEC headroom exactly where it's needed.

---

## Fix plan (v2 — agreed direction, pending final discussion)

### P0 — survive the handover (client: `call_session.dart`; server: `call_room.ts`)

1. **No self-termination while anyone can still recover.** Delete the `relay_migration_timeout` / `recovery_timeout_no_playout` call-kill paths. A failed attempt puts the call in `reconnecting` and schedules the next attempt. **One terminal condition remains:** the call ends only when the peer's signaling is confirmed gone (DO dead-peer detection) or a user hangs up — prevents permanent "reconnecting" zombies when the far app has died.
2. **Retry ladder instead of one-shot.** Remove the one-migration-per-call cap (client `_migrationAttempted` + DO `migrationUsed`). Up to ~5 attempts with exponential backoff (2/4/8/16/30 s) so retries don't flood a recovering network; each attempt = ICE restart first, relay migration as escalation. A network-change abort (item 3) resets the backoff — a fresh interface deserves an immediate attempt.
3. **Abort + re-gather on network change (client-side).** The `Connectivity()` listener in `call_session.dart` (the DO cannot see network type) aborts any in-flight recovery/migration the moment the interface changes and immediately starts a fresh attempt on the new interface — no more burning a 30 s deadline on dead candidates.
4. **Shorter deadlines + faster detection.** Stall detection 10 s → **5 s** (no inbound RTP for 5 s triggers recovery); ICE-restart attempt 30 s → **12 s**; relay-migration attempt 20 s → **8 s**. Combined with retries, target is handover recovery in ~5 s, not 50.
5. **DO elects the CONNECTED peer as recovery offerer.** `handleRecoveryRequest` in `worker/src/do/call_room.ts` must treat a peer in reconnect-grace as away — never elect the endpoint that is mid-handover.

### P1 — clarity on bad networks (client)

6. **Bound the jitter buffer.** Static bounds first: `audioJitterBufferMaxPackets: 50` + `audioJitterBufferFastAccelerate: true` in the PC config — caps the 745 ms "distant voice" delay at ~200 ms and drains fast when the network recovers. `jitterBufferTarget` on the receiver (150–200 ms) as a second lever **if** flutter_webrtc exposes it — verify API availability during implementation, don't assume.
7. **Adaptive buffer target (stretch, behind flag).** If `jitterBufferTarget` is available: low target (~80–100 ms) when loss/jitter are quiet, raise toward 200 ms during bursts, never above the static cap. Static bounds ship first; adaptive is an add-on, not a blocker.
8. **Unify Opus at 56 kbps.** Delete the 40 k copy in `call_session.dart`; both 1:1 and conference use the shared `audio_tuning.dart` tuner (56000, `useinbandfec=1`, `usedtx=0`, `stereo=0`). Higher bitrate = more FEC headroom without starving primary audio.
9. **Cellular → relay-only leg (client-side).** On cellular, the device's own PC uses `iceTransportPolicy: 'relay'` so its leg terminates at the Cloudflare TURN edge — a handover then only has to re-reach TURN, not re-negotiate a peer-reflexive path. Behind its own flag (slight latency cost on good cellular).
10. **NS / AGC / high-pass — ALREADY ON, verify only.** `avaMicConstraints()` and the 1:1 inline constraints already set `echoCancellation`, `noiseSuppression`, `autoGainControl`, `googHighpassFilter` (Flutter goes through getUserMedia constraints; there is no APM C++ surface to configure). Work item: confirm the 1:1 path's inline constraints match the shared helper, then delete the duplicate so it's defined once.
10a. **User-facing quality indicator.** The client already computes net stats every 5 s (`_publishNetStats`). Surface them: green/yellow/red dot on the call UI from the estimated-MOS score (item 12b); on red, a one-line "Poor network — try WiFi" hint. Turns "the app is broken" into "his network is bad."
10b. **Cellular↔cellular special case.** When BOTH peers report cellular (each side already knows its own class and can signal it), apply the conservative preset on both legs: relay-only ICE, 40 kbps, higher initial jitter-buffer target. Uses the same levers as items 6/9/12 — just a preset, not new machinery.

### P2 — observability + adaptation (client)

11. **Structured handover logging**: one event per interface transition (`from`, `to`, `call_id`, active recovery attempt id) from the client connectivity listener — correlates handovers to recovery attempts in one query.
12. **QoS adaptation — with the congestion correction.** The draft rule "loss >10% → raise bitrate to 80 kbps" is backwards for cellular: most cellular loss is congestion-induced, and raising bitrate into congestion makes loss worse. Correct rule: on sustained loss, keep FEC and **step bitrate DOWN** (56 → 40 → 32 kbps); step back up only when loss clears and RTT/jitter are stable (random-loss signature). Feed it WebRTC's own bandwidth estimate (`availableOutgoingBitrate` from candidate-pair stats — already computed by GCC, free to read): when estimate < current bitrate × 1.5, step down pre-emptively **before** loss starts. Implemented client-side via sender `setParameters(maxBitrate)`, thresholds as remote-config numbers.
12b. **Estimated MOS from existing stats (replaces the dropped PESQ idea).** Compute an E-model-style score client-side from numbers `call_media_health` already carries (loss, jitter, concealment, RTT) — one arithmetic line per 5 s tick, no audio analysis, no CPU cost. Attach `est_mos` to the existing event and emit a `call_quality_poor` marker when it dips below 3.0. Not ITU-calibrated — it's a **trend metric** to prove the fixes moved the needle, not an absolute quality claim.
13. **Adaptive FEC / RED (experimental, P2, own flag).** Opus in-band FEC ramps its own overhead with the encoder's loss estimate — feed it accurate loss via RTCP and it largely self-tunes. Audio RED (RFC 2198 redundancy) is worth an experiment on the relay path during loss bursts, **if** the negotiated SDP supports it on both Android builds — verify support first; this is an optimization, not a launch blocker.

### P3 — context, not code (external factors)

14. **Inter-network/carrier quality**: outside app control; the telemetry already carries `$network_carrier`, so carrier-pair quality queries are possible today with no new code. A user-facing "poor network" indicator can reuse the existing playout-health classes.
15. **Network-type presets (5G/4G/3G)**: fold into item 12's remote-config thresholds rather than a separate mechanism — same lever, per-network defaults.

### Testing before promotion

- Emulator + `tc netem`-style flap simulation: multiple WiFi↔cell transitions inside 30 s; assert audio resumes and the call never self-terminates.
- Real-device moving test (the tiger scenario) on a staging build with actual cellular handovers.
- A/B on lossy network: 40 k vs 56 k Opus at 5% / 10% / 20% loss; verify the QoS down-shift engages above the loss threshold.
- Jitter test: simulate 50–300 ms jitter; verify buffer delay stays ≤ ~200 ms.
- PostHog watch after rollout: `call_ended` reason mix (expect `relay_migration_timeout` → ~0), recovery success rate, jitter-buffer interval averages.

### Reviewed and REJECTED (so nobody re-proposes them blind)

- **TURN region selection / quality-weighted routing** — Cloudflare TURN is anycast: the network already routes each peer to its nearest edge; there is no region list for the client or DO to choose from. Nothing to build.
- **`goog*` congestion-control knobs (`googCubic`/`googReno`/`googInitialBitrate`…)** — Chrome-era constraint strings, removed from modern libwebrtc; setting them is a silent no-op. The real levers are `setParameters(maxBitrate)` and the Opus fmtp line, both already in the plan (items 8/12).
- **50/50 A/B split of recovery logic** — our behavior flags are global KV (no per-user bucketing; owner decision on rollout is Play internal track, not % ramps). Measure instead by **before/after build comparison** in PostHog: `call_ended` reason mix, recovery durations, `est_mos` — segmented by `$app_build`, which telemetry already carries.
- **Pre-emptive adaptation from radio signal strength (RSSI/RSRP)** — not reliably exposed to Flutter without extra plugins/permissions, and GCC's bandwidth estimate (item 12) already reflects a degrading radio sooner and more portably. Redundant signal, real cost.
- **iOS CallKit background-wake verification** — production is Android-only today (Play internal track); parked in the backlog for when iOS ships.
- **"VAD timeout → force PLC comfort noise"** — PLC already generates concealment/comfort noise natively during gaps; the actionable half of that idea (faster stall detection) is adopted as the 5 s trigger in P0 item 4.

### Success criteria (measure 7 days after each rollout)

- `relay_migration_timeout` call-ends: **~0** (currently the dominant handover outcome).
- Handover recovery time: **< 5 s** p50 (currently ~50 s then death).
- Jitter-buffer interval delay: **< 200 ms** at p95 (currently peaking 745 ms).
- `est_mos` > 3.5 for calls with < 15% loss; `call_quality_poor` rate trending down.
- "Distant voice" complaints from testers: gone or clearly reduced.

### Rollout gates (owner decides each step)

1. Implement on **staging** → staging worker deploy → staging build → moving-vehicle test.
2. Promote code to `main` (code + nothing else, per promotion rule) → prod worker deploy (typecheck, clean tree, committed first).
3. Client fixes reach phones only via an owner-requested build ("ship it").
4. New behavior behind the existing flags where possible (`callIceRecoveryV2` stays the master switch; deadline/retry values become remote-config numbers so they're tunable without a build).

---

*Sources: PostHog project 139917 (`call_media_health`, `call_recovery_*`, `call_media_stalled`, `call_ended` for the three call ids above); `app/lib/core/calls/call_session.dart`, `app/lib/core/audio_tuning.dart`, `worker/src/do/call_room.ts`; prod `/api/config` (cache-busted).*
