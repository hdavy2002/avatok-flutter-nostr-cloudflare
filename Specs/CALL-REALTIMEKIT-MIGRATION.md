# [CALL-RTK-1] RealtimeKit migration — WhatsApp-like calls without hand-tuning

**Status:** Draft for owner approval · **Date:** 2026-08-08 · **Author:** investigation session 2026-08-08
**Decision being asked:** replace the hand-rolled WebRTC media/reliability layer with Cloudflare
RealtimeKit (`realtimekit_core`), keeping the CallRoom DO ring/receptionist layer unchanged.

---

## 1. Why (the problem)

The call experience is not WhatsApp-smooth because we are hand-building what a media SDK is
supposed to provide. The evidence from the last month:

- ~2,500 lines of `call_session.dart` are a reliability program (CALL-SURVIVE recovery ladder,
  relay migration, RED redundancy, QoS adaptation, playout watchdogs) that ships dark behind
  ~15 flags and keeps failing in new ways: the recovery stopwatch bug made recovery 0%
  successful by construction; the SFU path bypasses the survive ladder entirely
  (`callSfuV1=true` → WiFi↔cell handover ends the call in 133 ms); RED unconditionally doubles
  cellular audio bandwidth while the congestion detector compares against the un-padded target;
  the keepalive pong never came back for months because the DO auto-response didn't match.
- Every fix costs a 40–80 min CI round trip (no local toolchain), a two-phone test, and a prod
  flag flip. Four fixes shipped on 2026-08-07/08 and three did nothing.
- `call_session.dart` is 8,622 lines. The call domain is ~43,000 client lines + ~17,500 worker
  lines. Most of the client half exists to compensate for driving the raw Cloudflare Calls SFU
  and raw P2P by hand.

RealtimeKit is the former Dyte team's SDK, acquired by Cloudflare, running on the **same
Cloudflare Realtime SFU we already use**. It internalises exactly the parts we keep getting
wrong: reconnection, WiFi↔cell handover, audio device/route handling, congestion/quality
adaptation, active-speaker, media health. Same Cloudflare account, same bill.

## 2. What we adopt and what we keep (the line)

**Adopt (RealtimeKit owns):** media transport, peer connections, reconnection and network
handover, congestion/quality adaptation, mute state, active speaker, media stats.
We use **`realtimekit_core` (headless)** — NOT the prebuilt `realtimekit_ui` widget — under our
existing `CallScreen`. The prebuilt UI would fight `CallAudioController`/CallKit for the audio
route and doesn't look like AvaTOK.

**Keep (ours, unchanged):** the entire ring lifecycle. RealtimeKit is meeting-join based — it
has no concept of ringing, presence, busy/no-answer, glare, or incoming calls. The CallRoom DO
(~10k worker lines: ring policy, ring counters, glare pair-key rooms, state machine, away
grace, receptionist admit/claim, no-answer policy), CallKit/FCM ring delivery, branded
incoming UI, ringback player, busy/no-answer outcome menus, and Ava receptionist handoff all
survive as-is. Only the media leg swaps: today "answer" → P2P offer or raw SFU transport;
after this spec "answer" → both sides join a RealtimeKit meeting.

**Retire once proven (the prize, ~7,400+ client lines):**

- `call_sfu_transport.dart` (524), `call_sfu_api.dart` (199), `worker/src/routes/call_sfu.ts` (451)
- `cloudflare_conference_controller.dart` + api + telemetry (~2,900)
- The P2P reliability ladder inside `call_session.dart` (~2,500): recovery, relay migration,
  RED experiment, QoS adapt, media watchdogs — and their ~15 dark flags and numeric tunables.
- The `/sfu-seat*` registry endpoints in the CallRoom DO.

## 3. Architecture

### 3.1 Server (worker)

New route file `worker/src/routes/call_rtk.ts`, modelled on the existing prototype
`calls/src/index.ts` (which already mints RealtimeKit tokens — port it, don't rewrite it):

- `POST /api/callrtk/:room/join` — authenticated; verifies the caller is an admitted
  participant of that CallRoom (same `ownsSession`-style check as `call_sfu.ts:110`); creates
  or reuses the RealtimeKit meeting for the room (meeting id cached on the CallRoom DO, not in
  a separate KV); calls RealtimeKit "Add Participant" with the right preset; returns
  `{ authToken, meetingId }`. The org API key lives only in the Worker
  (`CF_RTK_ORG_ID` / `CF_RTK_API_KEY` secrets — staging and prod each get their own, set via
  `scripts/cf.sh`, never bare wrangler).
- Presets created once in the RealtimeKit dashboard:
  `avatok_1to1_audio` (audio-only meeting type — bills at $0.0005/min at GA),
  `avatok_1to1_video`, `avatok_group` (≤25, matches the conference cap rule).
- The CallRoom DO gains one small field (`rtkMeetingId`) and one internal endpoint to
  set/clear it. Nothing else in the DO changes.

### 3.2 Client (app)

- Implement the **existing, unwired seam**: `app/lib/core/calls/rtc/rtc_provider.dart`
  (341-line skeleton, built for exactly this). New file
  `app/lib/core/calls/rtc/realtimekit_provider.dart` wrapping `realtimekit_core`.
- Wire point: the same decision point where `callSfuV1` currently forks
  (`call_session.dart` welcome handler, ~L6020). Order of precedence:
  `callRealtimeKitV1` → RTK meeting join; else `callSfuV1` → legacy raw-SFU; else P2P.
  The `sfu-start`/`sfu-abort` signaling frames are reused as `rtk-start`/`rtk-abort` with the
  same fallback semantics: if RTK join fails within deadline, abort to P2P — a bad flag flip
  can never strand a call.
- Audio route: RealtimeKit is configured to NOT manage the audio session;
  `CallAudioController`/`NativeVoiceAudio` remain the single route owner (this is the one
  integration risk to prove in Phase 1 — see §6 risks).
- Group conference: `RealtimeKitRtcProvider` also backs the group path, replacing
  `cloudflare_conference_controller.dart`. The `avaconsult/` prototype
  (`realtimekit_ui ^0.4.0` + `calls/` token Worker) is the working reference.
- Add-to-call escalation gets dramatically simpler: 1:1 and group are both RTK meetings, so
  escalation becomes "invite third person to the same meeting" — the make-before-break
  migration coordinator (532 lines) eventually retires too (Phase 4, not before).

### 3.3 Flags (declared properly — fake-flag rule)

All declared in `PlatformConfig` **and** `DEFAULTS` in `worker/src/routes/config.ts` in the
same change, proven flippable with `ALLOW_PROD=1 scripts/flags.sh set <key>=false` + cache-busted
`/api/config` read before the client build ships:

| Flag | Default | Meaning |
|---|---|---|
| `callRealtimeKitV1` | `false` | 1:1 media via RTK meeting join |
| `groupRealtimeKitV1` | `false` | group conference via RTK |
| `callRtkJoinDeadlineSec` | `10` (numericKeys) | RTK join deadline before abort-to-P2P |

Server-side, `/api/callrtk/*` hard-refuses (503) when the flag is off — same pattern as
`call_sfu.ts:137`.

## 4. Feature interactions (each one has an explicit answer)

- **Receptionist (Ava):** Phase 1–2 keep receptionist calls on the legacy path — when the ring
  outcome routes to Ava, media stays on today's P2P/reception-room pipe. Phase 4 evaluates Ava
  joining the RTK meeting as a participant. Nothing about ring-count/handoff timing changes.
- **In-call translation:** `CallTranslationAudioPlugin.java` taps flutter_webrtc's
  decoded-playback callback; RealtimeKit bundles its own WebRTC, so the tap doesn't exist.
  `callTranslationEnabled` is default-false today. Rule: if translation is armed for a call,
  that call uses the legacy path (client-side check, same fork point). Translation-on-RTK is
  Phase 4+ (candidates: RTK raw-RTP export into a Worker, or RTK audio callbacks if exposed).
- **Call recording:** current pipeline is client-side native capture — unaffected in
  principle, but `LegTap`/`CallRecorderPlugin.kt` must be re-verified against RTK's audio
  path on a device before `callRecordingEnabled` and `callRealtimeKitV1` are ever on together.
  RTK's server-side recording export ($0.010/min, $0.003 audio-only) is a future option that
  would retire the whole client pipeline (3,230 lines + 2,300 Kotlin) — separate decision,
  costs real money.
- **Mute / hold / DTMF / recording-indicator frames:** stay on the CallRoom WS exactly as
  today (they're signaling, not media). RTK mute is driven by our existing mute control.
- **Billing:** human A/V calls are permanently free (DO already rejects `/billing-arm`) — RTK
  changes nothing. GA cost is ours, not the user's: a 1-hour 1:1 audio call = 2 participants
  × 60 min × $0.0005 = $0.06 (~₹5.8). Beta = $0 today.
- **Conference caps:** ≤25 rule unchanged; enforced by preset max + existing worker checks.

## 5. Rollout phases (each gated by the ship gate, `tool/check_ship_readiness.py`)

**Phase 0 — prereqs (no app change):** enable RealtimeKit on the Cloudflare account; create
the three presets; set staging + prod secrets via `cf.sh`; port `calls/src/index.ts` into
`worker/src/routes/call_rtk.ts`; declare the three flags; typecheck (`npx tsc --noEmit`),
commit, deploy staging worker. Prove the flags flip.

**Phase 1 — group conference pilot (lowest risk, existing prototype):** wire
`RealtimeKitRtcProvider` into the group path behind `groupRealtimeKitV1`, staging first.
Success assertions (written into `tool/ship_manifest.json` BEFORE the build):
`group_call_joined` with `provider=realtimekit` and `join_ms < 3000`; a 10-minute 3-person
call with zero `call_ended reason∈{error,timeout}`; audio route ownership verified (speaker
press sticks — the boot-media race must not regress). Two-sided rule: ≥3 distinct persons on
the new `$app_build`.

**Phase 2 — 1:1 dark launch:** wire the fork point behind `callRealtimeKitV1`; ship a build to
the internal track; flip the flag for a small cohort (owner + one tester) in prod.
Success assertions: `call_connected provider=realtimekit`; **the WhatsApp test** —
WiFi→cellular switch mid-call and the call survives (event `call_network_handover
outcome=survived`, the exact failure CALL-SURVIVE never fixed); reconnect-after-airplane-mode
≤ deadline; `rtk-abort` fallback fires correctly when forced. Both phones on the new build
(rule 2), success VALUES read from PostHog (rule 3), before the word "shipped" is used.

**Phase 3 — default-on + deletion:** flip `callRealtimeKitV1` default true; after two weeks
clean, delete the raw-SFU transport, the reliability ladder, their flags (KV overrides pruned
via `scripts/flags.sh prune`), and the `/sfu-seat*` DO surface. Deletion is the point — the
ladder must not linger half-dead.

**Phase 4 — consolidation (separate owner decisions):** Ava-in-meeting, translation-on-RTK,
server-side recording export, retire the escalation migration coordinator, evaluate
`realtimekit_ui` for AvaConsult proper.

## 6. Risks and mitigations

- **Beta, no SLA.** Mitigation: the abort-to-P2P fallback stays wired until Phase 3; nothing
  is deleted while RTK is the only path for fewer than two clean weeks.
- **Audio-route double ownership** (the known killer — boot-media vs Speaker press). Proven in
  Phase 1 on a device before any 1:1 exposure; if RTK cannot fully yield the audio session on
  Android, this spec stops at Phase 1 and we reassess.
- **CallKit/foreground-service interplay:** ring delivery is untouched, but joining an RTK
  meeting from a CallKit-answered background state must be tested explicitly (the synthetic
  native-decline bug taught us this surface bites).
- **SDK is young** (`realtimekit_ui` 0.4.x line): pin exact versions; no local toolchain means
  a bad transitive dep is a 40–80 min CI discovery — keep the first integration diff minimal.
- **GA pricing lands someday:** ~$0.06/audio-hour per 1:1 call is acceptable; recording export
  is the only materially priced item and is explicitly deferred.
- **Package size / minSdk:** requirements (minSdk 24, compileSdk 36, iOS 13) already met.

## 7. What this spec deliberately does NOT do

No change to: ring policy or counts, receptionist behaviour, presence heartbeat, busy/no-answer
menus, CallKit ring delivery, branded incoming UI, wallet/tokens, recording defaults,
translation defaults, the ≤25 conference rule, or the free-calls rule. No re-introduction of
Nostr. No new `push:` triggers. No local toolchain.

## 8. Open questions for the owner

1. Approve the line in §2 (RTK = media only; our DO keeps the ring)?
2. Phase 1 on staging first, or straight to prod internal track behind the flag?
3. Is server-side recording export (paid) worth pursuing in Phase 4, or keep client-side?
