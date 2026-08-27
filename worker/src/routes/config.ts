// Remote kill switches / server config (creator-marketplace Phase 1, audit A2).
// One JSON blob in KV (key `platform_config` — KV's sanctioned feature-flag
// use). Public read, 60 s edge cache; admin-only write. Flipping a flag
// reaches every client within ~15 min (RemoteConfig poll) with no APK release.
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";

const KEY = "platform_config";

export interface PlatformConfig {
  walletRealMoney: boolean;
  donationsEnabled: boolean;
  liveEnabled: boolean;
  consultEnabled: boolean;
  // Phase 2 commercial GetStream lane. These controls are deliberately
  // independent from Messenger and the legacy AvaLive/AvaConsult switches so
  // discovery, checkout and admission can be canaried separately.
  commercialLiveListingsEnabled: boolean;
  commercialLiveCheckoutEnabled: boolean;
  commercialLiveJoinEnabled: boolean;
  commercialConsultListingsEnabled: boolean;
  commercialConsultCheckoutEnabled: boolean;
  commercialConsultJoinEnabled: boolean;
  commercialCreatorFeePct: number;
  commercialSettlementHoldHours: number;
  commercialConsultJoinEarlyMin: number;
  commercialConsultJoinLateMin: number;
  commercialConsultExtensionEnabled: boolean;
  commercialConsultExtensionMinutes: number;
  commercialConsultExtensionRate: number;
  commercialLiveBackstageEarlyMin: number;
  commercialLiveStartGraceMin: number;
  commercialReplayEnabled: boolean;
  commercialRecordingEnabled: boolean;
  // [PIVOT-MSGR-CALL-OFF-1] Messenger 1:1 audio/video calling. The pivot
  // (Specs/PIVOT-2026-08-27-MARKETPLACE-FIRST-PAID-SESSIONS.md §4) kills it:
  // Messenger keeps simple text messaging, and all paid session media moves to
  // GetStream. Enforced client-side at the one choke point
  // routeToStreamCallIfEnabled (app/lib/features/avatok/place_1to1_call.dart).
  //
  // 🚨 This is NOT the same thing as `streamCallsEnabled`, and the two must never
  // be confused. `streamCallsEnabled` only ROUTES: turning it off does not
  // disable calling, it makes every entry point fall through to the legacy
  // Cloudflare CallScreen, which has failed 100% of calls since build 10612
  // (getUserMedia(): unknown factoryId null). Using it as a disable mechanism
  // ships BROKEN calling instead of NO calling. `streamCallsEnabled` stays true
  // because the paid consultation/livestream lane depends on the same SDK,
  // token route and push wiring.
  //
  // Default FALSE per the owner decision. It is deliberately fail-closed: a
  // config-fetch failure leaves calling off, which is the correct direction for
  // a feature being removed. Only builds that ship this key read it, so
  // declaring it does not affect clients already in the field.
  messengerCallingEnabled: boolean;
  conferenceEnabled: boolean;
  // FREE LAUNCH group AUDIO on Cloudflare Realtime SFU (Specs/FREE-LAUNCH-DIRECTION.md
  // + Specs/CF-REALTIME-SFU-GROUP-AUDIO-BUILD.md). Default OFF: the new audio-only
  // CF-SFU group path stays dormant until its worker+client build lands and is
  // CI/device-verified. While OFF, group calls keep using the existing LiveKit
  // path (kept dormant per the launch doc, NOT deleted). Flip ON in KV to cut the
  // GROUP path over to CF Realtime SFU (audio-only, 32 cap, active-speaker pull).
  groupAudioSfuEnabled: boolean;
  brainEnabled: boolean;
  // One Brain B4 (SPEC-2026-07-17 §6, B-D6) — global brake on handing a
  // `device_private` recall snippet to a CLOUD avaReason call. `brainRecall`
  // merges the device + server lanes; a device-private hit can be included in a
  // cloud model call ONLY over our-keys, no-retention transport. TRUE by default
  // (matches the client fallback, so declaring it changes nothing today). The
  // per-account "local-only answers" toggle lives under the `messages` consent
  // domain; THIS flag is the platform-wide switch — set false in KV to force
  // device-private hits to be stripped before any cloud reasoning app-wide.
  // Declared here (interface + DEFAULTS in the same change) per the fake-flag rule
  // so the brake is actually flippable.
  cloudReasoningOverPrivate: boolean;
  verseEnabled: boolean;
  // [AVA-SYNC-SKIP] Kill switch for the reconnect/resume catch-up skip. Default TRUE
  // (matches the client's own fallback default, so declaring it changes nothing today).
  // When a socket flaps (Android doze ~15x/user/day) the client re-runs a full InboxDO
  // catch-up even when its message cursor is already at the server head — 97.6% of those
  // returned 0 messages. With this ON, a reconnect/resume whose persisted cursor is
  // already at head is answered with a cheap `sync_skip` frame instead of a full replay.
  // Flip false in KV to make every client fall back to the always-full-sync behaviour.
  syncSkipEnabled: boolean;
  // Progressive Identity ladder (PROPOSAL-PROGRESSIVE-IDENTITY.md)
  identityLadderEnabled: boolean;    // master switch for requireLevel gating
  guestTierEnabled: boolean;         // L0 handle-only visitors
  workersAiLivenessEnabled: boolean; // L2 via Workers AI clip check (Rekognition fallback)
  // [M-D1 2026-07-17 / M-D11 2026-07-18] simOnlyPhoneEnabled REMOVED — phone OTP was
  // deleted app-wide 2026-07-10 (/api/id/phone/confirm is in LEGACY_GONE → 410 and the
  // handler is unrouted). Liveness only, no phone anywhere; the flag gated nothing reachable.
  // Live voice translation (Gemini 3.5 Live Translate, $3/h in Tokens).
  translationEnabled: boolean;       // master switch for /api/translate/*
  /**
   * [CALL-SFU-1] OWNER DECISION 2026-08-06 — 1:1 calls move off raw P2P onto the
   * Cloudflare Realtime SFU, the same product group conferences already use.
   *
   * WHY, in one line: with P2P a network change breaks BOTH ends at once and two
   * phones behind two NATs must re-find each other over a signalling path that may
   * itself be broken; with an SFU only the moving phone's leg breaks and it
   * reconnects to a fixed, publicly-routable address. Every mechanism that failed
   * 12/12 times on 2026-08-05 (offerer election, glare, attemptId matching, both
   * peers independently proving health) exists ONLY because there are two phones
   * to coordinate. The SFU deletes the category instead of fixing it.
   *
   * Ships FALSE. P2P stays in the build as a silent fallback, so flipping this off
   * returns every user to today's behaviour without a build.
   */
  callSfuV1: boolean;
  /**
   * [CALL-SFU-1] Restrict the SFU path to audio, pushing video back onto P2P.
   *
   * Ships FALSE — the owner chose a full migration on 2026-08-06, audio AND video.
   * It exists purely as the bandwidth escape hatch: video is ~18x the bytes of
   * audio, so the 1,000 GB Cloudflare free tier covers roughly 1,100 video
   * call-hours/month vs ~20,000 audio hours. If the bill ever surprises us, flip
   * this true from KV and video is back on P2P in a minute.
   */
  callSfuAudioOnly: boolean;
  /**
   * [CALL-PREWARM-1 2026-08-16] P1 of Specs/PLAN-CALL-INSTANT-PICKUP-2026-08-16.md.
   * Callee pre-warms its media path (ICE fetch + SFU seat join) the moment the
   * incoming-call PUSH lands, seconds before the ring UI is even shown — not on
   * accept. Accept then only publishes + pulls, instead of building the whole
   * stack from a cold start. Mic stays disabled until accept (privacy: nothing is
   * captured pre-accept); decline/timeout/cancel tears the seat down via the
   * existing /api/callsfu/:room/close route. Ships FALSE: no client build
   * implements the seam yet. Boolean → NOT in numericKeys.
   * Client mirror: RemoteConfig.callPrewarmOnRingV1.
   */
  callPrewarmOnRingV1: boolean;
  /**
   * [CALL-PREWARM-1] P2 of the same plan — caller pre-joins and PUBLISHES audio
   * to the SFU at ring start (before the callee accepts), so the callee's first
   * pull finds the track immediately instead of both sides waiting on each
   * other. Declared alongside `callPrewarmOnRingV1` now; no client code reads it
   * yet — P2 ships as its own change. Ships FALSE. Boolean → NOT in numericKeys.
   * Client mirror: RemoteConfig.callerPrejoinOnRingV1.
   */
  callerPrejoinOnRingV1: boolean;
  /**
   * [CALL-PREROLL-1 2026-08-17] Extends `callPrewarmOnRingV1` (P1) so the
   * CALLEE pre-rolls its WHOLE media path during the ring, not just the ICE
   * fetch + SFU seat join: acquire the mic (track disabled), build an
   * isolated peer connection, PUBLISH (silent — local track stays disabled)
   * and PULL the caller's audio (muted — remote track stays disabled) before
   * Accept is ever tapped. Accept then only has to flip two `enabled` flags
   * instead of running publish+pull cold, removing ~2.5-3s more of the
   * accept->voice gap on top of P1. Requires `callPrewarmOnRingV1` also being
   * true — this flag alone does nothing (`CallPrewarm` gates the extension on
   * both). Ships FALSE: no client build implements this seam yet, and
   * unmuting audio during the ring by accident is a real privacy hazard this
   * flag guards against being reachable at all. Boolean -> NOT in numericKeys.
   * Client mirror: RemoteConfig.callPrerollV1.
   */
  callPrerollV1: boolean;
  /** Server-authoritative silent transport prewarm; dark until matching client ships. */
  callSilentTransportPrewarmV1: boolean;
  /** Maximum silent prewarm window before the server promotes the call to a cold ring. */
  callSilentPrewarmDeadlineMs: number;
  /**
   * [CALL-RTK-2 2026-08-08] 1:1 media via a Cloudflare RealtimeKit meeting join.
   *
   * See Specs/CALL-REALTIMEKIT-MIGRATION.md. RealtimeKit runs on the SAME
   * Cloudflare Realtime SFU we already use, but owns the reliability layer we
   * keep hand-building and keep getting wrong (reconnection, WiFi<->cell
   * handover, congestion adaptation). Server-side this gates /api/callrtk/*,
   * which 503s `rtk_unavailable` while it is false; client-side it takes
   * precedence over `callSfuV1`, which takes precedence over P2P.
   *
   * Ships FALSE. Both legacy paths stay in the build, and the client aborts to
   * P2P if the RTK join misses `callRtkJoinDeadlineSec` — so a bad flag flip can
   * never strand a call, and flipping back is a full rollback with no rebuild.
   * Boolean → NOT in numericKeys.
   */
  callRealtimeKitV1: boolean;
  /**
   * [CALL-RTK-2 2026-08-08] Group conference via RealtimeKit.
   *
   * Separate from `callRealtimeKitV1` on purpose: the rollout (spec §5) starts
   * with groups, which are the lower-risk half — an existing prototype backs
   * them (`avaconsult/` + `calls/src/index.ts`) and there is no ring/CallKit
   * interplay to prove. One flag would have made the group pilot expose 1:1 too.
   * The ≤25 cap is unchanged and enforced independently of this flag.
   * Boolean → NOT in numericKeys.
   */
  groupRealtimeKitV1: boolean;
  /**
   * [CALL-RTK-2 2026-08-08] Seconds the client waits for a RealtimeKit join
   * before aborting back to the legacy path.
   *
   * Returned in the /api/callrtk/:room/join response so the deadline is a KV
   * flip rather than a 40-80 minute CI round trip — the recovery-stopwatch bug
   * (deadlines that made success unreachable by construction) is exactly the
   * class of mistake that must be tunable live. NUMERIC → it MUST also appear
   * in `numericKeys` below or `flags.sh set callRtkJoinDeadlineSec=15` 400s
   * `bad type`.
   */
  callRtkJoinDeadlineSec: number;
  /**
   * [CALL-DEADAIR-1 2026-08-08] Parallelise the call-setup prologue.
   *
   * Prod call avatok-17f145b5 (2026-08-07) spent ~14s between `call_started` and
   * the first audio bytes on a link measuring 5-6ms jitter and ~0% loss on BOTH
   * sides. The setup ladder was serial where it did not need to be: two renderer
   * inits, an ICE credential round trip and a network-class probe all ran one
   * after another AHEAD of `getUserMedia`, which itself sits ahead of the
   * signalling socket that is the only thing that can start the SFU ladder — and
   * inside that ladder the peer-seat poll ran strictly after our own publish
   * even though it reads a server seat and depends on nothing we do locally.
   *
   * TRUE (default) = concurrent. FALSE = the exact pre-2026-08-08 serial order,
   * so a regression is one KV flip from being undone with no app build.
   */
  callSetupParallelBootV1: boolean;
  /**
   * [CALL-DEADAIR-1] The client's 200ms first-inbound-audio probe and the
   * `call_first_audio_ms` event it emits.
   *
   * Pure observability. It exists because the only inbound-byte sampler on the
   * call path is a 5s PERIODIC armed at connect, which quantises every "how long
   * was it silent" answer to ±5s — you cannot assert a sub-1000ms success value
   * against a 5s ruler. Flippable because it is the one thing in the call path
   * that reads `getStats()` faster than every 5s.
   */
  callFirstAudioProbeV1: boolean;
  /**
   * [AVA-VM-FALLBACK-1 2026-08-08] An Ava timeout must never end the call.
   *
   * Prod call avatok-946b6090 (2026-08-07 20:52 IST): the receptionist session
   * opened (`live_session_open` 20:53:04.9), produced no audio, hit
   * `ava_live_timeout` 4.5s later, retried — and the call was ENDED at
   * 20:53:19.9 with `reason=ava-live-timeout` while the owner was trying to
   * leave a voicemail. He never spoke, nothing was recorded, and from his side
   * the app simply hung up on him.
   *
   * TRUE (default): the caller's app sends a `vm_fallback` control frame on the
   * ALREADY-OPEN receptionist socket; `ReceptionRoomCf` abandons the
   * conversational engine and runs its deterministic voicemail flow (cached
   * greeting -> beep -> record), so the message is stored and delivered by the
   * ordinary receptionist `finalize()` — one storage path, not two. FALSE:
   * pre-2026-08-08 behaviour, i.e. the call ends and the message is lost.
   *
   * Read by the CLIENT (nothing requests the fallback when it is false), so a
   * flip stops the behaviour on every device at its next config refresh, and
   * clients that predate the feature simply never send the frame.
   */
  avaVoicemailFallbackV1: boolean;
  /**
   * [CALL-AUDIO-OWNER-1 2026-08-07] ONE owner for the call audio session.
   *
   * The client side of this shipped already; the key was never declared here, so
   * it was a FAKE flag (CLAUDE.md): `putConfig` would 400 `unknown key` and the
   * client's `_b('callAudioOwnerV1', true)` fallback was its permanent value.
   * Declared now so the brake can actually be pulled from KV. Default TRUE =
   * the shipped behaviour, so adding it changes nothing today.
   * Boolean → NOT in numericKeys. Client mirror: RemoteConfig.callAudioOwnerV1.
   */
  callAudioOwnerV1: boolean;
  /**
   * [CALL-AUDIBLE-1 2026-08-17] Honest user-visible "connected" state.
   *
   * `_connected` on the client (media path established — first remote track)
   * is unchanged and stays load-bearing: it still stops ringback, starts talk
   * time, cancels the ring/connect/fail/relay timers, starts the media
   * watchdog + playout sampler, aborts the receptionist pre-warm, clears the
   * glare globals, and gates `onConnectionState`. NONE of that moves.
   *
   * This flag only gates a LATER, purely-presentational milestone
   * (`CallSession.audibleReady`): the UI shows "Connecting audio…" and hides
   * the running call timer until real inbound audio is confirmed (reusing the
   * existing `call_first_audio_ms` probe — never gated on `audioLevel`, so a
   * silent caller still reaches this state). Production telemetry showed the
   * UI declaring "Connected" 12-16s before audio actually arrived.
   *
   * FALSE (default): `audibleReady` mirrors `_connected` immediately — no UI
   * change from today. Client mirror: RemoteConfig.callAudibleStateV1.
   */
  callAudibleStateV1: boolean;
  /**
   * GetStream Video 1:1 calling pilot. Ships FALSE and is intentionally
   * independent from every Cloudflare CallRoom/SFU flag, so rollback is one
   * config flip and the existing paths remain untouched.
   */
  streamCallPilotEnabled: boolean;
  /**
   * Deterministic percentage of allowlisted staging calls sent to Stream.
   *
   * The provider decision is made from the call id, so retries for one call
   * remain on the same provider. `0` is the safe default and `100` sends every
   * allowlisted call to Stream. The existing Cloudflare call path reads this
   * only after an explicit `stream_capable` opt-in; old clients remain
   * unchanged.
   */
  streamCallPilotPercent: number;
  /**
   * Kill switch for the NEW client-side "streamlane" calling lane built on
   * GetStream's Stream Video SDK (worker/src/routes/stream_video_calls.ts).
   * Deliberately distinct from `streamCallPilotEnabled` — that flag gates the
   * existing server-side rollout/provider-selection pilot; this one gates the
   * separate client lane being built side-by-side with the current call
   * stack, which stays untouched. Ships FALSE.
   */
  streamCallsEnabled: boolean;
  /**
   * [MESSENGER-CALL-BILLING-FOUNDATION] Phase 1 Messenger caller-funded
   * allowance/metering gate. This is separate from the Stream pilot flags and
   * from the legacy monthly human-call meter. It ships dark until the
   * authorization, wallet, provider-adapter, and two-account release gates are
   * complete.
   */
  messengerCallBillingEnabled: boolean;
  messengerAudioFreeParticipantSecondsDaily: number;
  messengerAudioPaidCentitokensPerParticipantMinute: number;
  messengerVideoSdCentitokensPerParticipantMinute: number;
  messengerVideoHdCentitokensPerParticipantMinute: number;
  messengerVideo2kCentitokensPerParticipantMinute: number;
  messengerVideo4kCentitokensPerParticipantMinute: number;
  messengerCallReservationWallSeconds: number;
  messengerCallLowBalanceWarningWallSeconds: number;
  messengerCallUsageTickSeconds: number;
  messengerCallPriceVersion: number;
  /**
   * [STREAM-GATE-1 2026-08-21] Minimum app build allowed to place a call on the
   * LEGACY Cloudflare dial route (`POST /api/call`).
   *
   * Specs/PLAN-STREAM-ONLY-CALLS-2026-08-21.md §2.1 option C. The owner's
   * decision is a HARD CUTOVER to Stream-only calling: a phone on the new Stream
   * build and a phone on a pre-cutover build cannot connect — different engines,
   * different signalling, no common ground. Rather than let a legacy build dial
   * into silence, the Worker refuses the dial and says so.
   *
   * `0` (the default) DISABLES the gate entirely, so this key ships INERT and is
   * switched on deliberately once the cutover build is live:
   *   `ALLOW_PROD=1 scripts/flags.sh set callMinBuild=<cutover build>`
   *
   * DISTINCT from `minAppBuild`, which is the app-wide blocking update screen.
   * This one refuses only CALLS; everything else on an old build keeps working.
   * Deliberately narrower — the owner may not want to lock a whole fleet out of
   * messaging to fix calling.
   *
   * The build is read from the `x-app-build` request header (or an `app_build`
   * body field). See `routes/api.ts` — a request that carries NO build at all is
   * treated as pre-cutover once the gate is armed, because the header is
   * introduced by the cutover build itself.
   */
  callMinBuild: number;
  /**
   * [CALL-RING-FASTPATH-1 2026-08-07] Trim the pre-ring critical path of
   * POST /api/call.
   *
   * MEASURED IN PROD 2026-08-07, one real call: dial → `call_ws_ring_sent` was
   * 3.6 s (observed as high as 4.8 s). Everything in that window was a SERIAL
   * await in front of the ring — blocklist D1, contact-policy D1, KV config,
   * primary-D1 token count, the caller identity profile read, the glare pair-DO
   * hop, the participants DO hop — and most of it cannot change WHETHER a ring
   * is sent, only what is written on it or what happens twenty seconds later.
   *
   * When TRUE, everything that cannot gate the ring runs CONCURRENTLY (one
   * Promise.all batch) or after the response (`waitUntil`), leaving only the
   * three hops that are load-bearing: admission → glare → participants → ring.
   * When FALSE the old serial order is restored exactly, so this is a real,
   * instant rollback with no rebuild. Boolean → NOT in numericKeys.
   */
  callRingFastPath: boolean;
  /**
   * [CALL-PRESENCE-1 2026-08-07] Presence-FIRST call routing.
   *
   * Until now there was no heartbeat anywhere: "presence" was only the
   * side-effect of the WS ring landing on an open socket in the callee's
   * InboxDO. On 2026-08-07 that ring came back `live:false` at +3.6 s — the
   * server KNEW the callee was offline — and the caller still waited until +28 s
   * before Ava took over. When TRUE, `/api/call` reads a real presence record
   * (written by POST /api/presence/beat) BEFORE the DO round-trips and routes a
   * provably-offline, no-token callee straight to the receptionist.
   *
   * Fails OPEN in every ambiguous case: no record, no presence store configured,
   * or a read error all mean `presence:'unknown'` and a completely normal ring.
   * Boolean → NOT in numericKeys.
   */
  callPresenceRouting: boolean;
  /**
   * [CALL-PRESENCE-1] How long a presence beat is treated as FRESH, in seconds.
   * Must comfortably exceed `presenceHeartbeatSec` (a device that misses two
   * beats to a radio nap is not offline). NUMERIC → it MUST also appear in
   * `numericKeys` below or `flags.sh set presenceFreshSec=120` 400s `bad type`.
   * Client mirror: RemoteConfig.presenceFreshSec.
   */
  presenceFreshSec: number;
  /**
   * [CALL-PRESENCE-1] How often a connected device sends POST /api/presence/beat,
   * in seconds. Drives the client's beat cadence (it rides the existing 25 s
   * SyncHub ping tick, so smaller values than 25 have no effect). NUMERIC → also
   * in numericKeys. Client mirror: RemoteConfig.presenceHeartbeatSec.
   */
  presenceHeartbeatSec: number;
  /**
   * [CALL-PRESENCE-2 2026-08-08] How long a phone may go WITHOUT checking in
   * before the server treats it as OFF, in seconds.
   *
   * The owner's rule, in his words: "every phone heartbeats; if a callee's phone
   * has not checked in for X, it is off, and a caller dialing them is routed
   * IMMEDIATELY to the Ava receptionist, not left listening to ringing beeps."
   *
   * WHY IT HAD TO EXIST. [CALL-PRESENCE-1]'s offline trigger required a stale
   * heartbeat AND zero FCM tokens, and in production a token survives the phone
   * being switched off, flight mode, a dead battery and a week in a drawer — so
   * the trigger essentially never fired. Measured 2026-08-08 on call
   * avatok-d679c96a: `presence_age_ms: 657033` (the callee had been silent for
   * ELEVEN MINUTES), the server knew that BEFORE it rang, and the caller was
   * still given ~18 s of ringing before Ava. Time is the signal; a live token
   * only means we could try to wake it, which is the gamble the caller was paying
   * for.
   *
   * Relationship to the other two: `presenceHeartbeatSec` (25) <
   * `presenceFreshSec` (90) < `presenceOfflineSec` (300). Between fresh and
   * offline the callee is `stale` and still rings normally — a radio nap is not
   * an off phone. 300 s = twelve consecutive missed beats.
   *
   * Set to 0 to disable age-based offline routing entirely and fall back to
   * [CALL-PRESENCE-1] behaviour, with no rebuild. NUMERIC → it MUST also appear
   * in `numericKeys` below or `flags.sh set presenceOfflineSec=600` 400s
   * `bad type`. Server-only: no client mirror, because the decision is made
   * server-side in /api/call and the client is only told `routing_reason:
   * 'offline'`, a value it already handles.
   */
  presenceOfflineSec: number;
  /**
   * [CALL-4RINGS-1 2026-08-08] Hand over to Ava after FOUR REAL RINGS, not after
   * a wall-clock alarm.
   *
   * `receptionistRings: 4` has existed since 2026-07-09 and NOTHING has ever
   * timed off it — it is surfaced to the client as `cfg['rings']` and is purely
   * informational. The only thing that actually fires is
   * `CALL_RING_LIFETIME_MS` (20 s) in lib/call_delivery_contract.ts. So the
   * system cannot tell "their phone rang four times and nobody picked up" from
   * "their phone never made a sound", and it drifts: prod call avatok-ca712826
   * (2026-08-07) produced ZERO `device-ringing` receipts and Ava still fired —
   * at +28 s, eight seconds late against even the 20 s rule.
   *
   * When TRUE the callee reports EVERY ring cycle (not just the first), the
   * CallRoom counts the ones that were genuinely audible, and the receptionist
   * handoff runs the moment the count reaches `receptionistRings`. The
   * wall-clock alarm is KEPT as a hard backstop so a silent or lying device can
   * never hold the caller forever — it is merely widened to
   * `max(CALL_RING_LIFETIME_MS, receptionistRings * ringCycleMs + slack)` so
   * four genuine cycles have room to happen.
   *
   * When FALSE everything behaves exactly as it does today: the 20 s deadline,
   * no counting, and the callee's repeat receipts stop being sent at all.
   * Boolean → NOT in numericKeys. Client mirror: RemoteConfig.callRealRingCount.
   */
  callRealRingCount: boolean;
  /**
   * [CALL-4RINGS-1] Assumed duration of ONE ring cycle, in ms.
   *
   * Android exposes no per-ring-cycle callback — neither CallKit/ConnectionService
   * nor `Ringtone`/`RingtoneManager` will tell you "cycle 3 just started", and
   * `flutter_callkit_incoming` surfaces nothing of the sort. So on every path
   * except the app's own bundled tone the cycle is DERIVED from a timer seeded
   * at this value, and the receipt is stamped `derived:true` so measured and
   * assumed can be told apart in telemetry rather than silently blended.
   *
   * 6000 ms is the Android default ringtone loop for the stock tones and is
   * deliberately conservative: too SHORT invents rings that never happened and
   * hands the caller to Ava early, which is the exact failure this change
   * exists to remove. NUMERIC → it MUST also appear in `numericKeys` below or
   * `flags.sh set ringCycleMs=5000` 400s `bad type`.
   * Client mirror: RemoteConfig.ringCycleMs.
   */
  ringCycleMs: number;
  /**
   * [CALLREC-SERVER-1] MASTER kill switch for on-demand call recording
   * (Specs/FEASIBILITY-CALL-RECORDING-2026-08-04.md). Gates the Record tile on
   * the client AND every /api/callrec/* route on the server, so flipping it off
   * stops new recordings AND new uploads without a build. Ships FALSE — the
   * capture layer is Android-only and unproven, and a recording feature must
   * never turn itself on by accident. Existing recordings stay in AvaStorage
   * either way (they are the user's files, paid for by their storage quota).
   * Boolean → NOT in numericKeys. Client mirror: RemoteConfig.callRecordingEnabled.
   */
  callRecordingEnabled: boolean;
  /**
   * [CALLREC-SERVER-1] The persistent "Recording" indicator on BOTH call screens
   * (§4 of the spec — the peer gets no other warning that on-demand recording
   * started). Default TRUE: this is the consent surface, not a preference, and it
   * exists as a flag only so a rendering bug can be neutralised from KV without
   * pulling the whole feature. Boolean → NOT in numericKeys.
   */
  callRecordingIndicatorEnabled: boolean;
  /**
   * [CALLREC-SERVER-1] Device free-space floor, in MB, below which the client
   * refuses to arm the recorder (and finalizes cleanly if crossed mid-call).
   * Tunable from KV because the right floor depends on real devices, not on a
   * number picked here. NUMERIC → it MUST also appear in `numericKeys` below or
   * `flags.sh set callRecordingMinFreeMb=750` 400s `bad type` (fake-flag rule,
   * CLAUDE.md). Client mirror: RemoteConfig.callRecordingMinFreeMb.
   */
  callRecordingMinFreeMb: number;
  /**
   * [ADDCALL-1-SRV] MASTER kill switch for "Add to call" — escalating a live 1:1
   * into a small group conference (Specs/SPEC-ADD-TO-CALL-2026-08-06.md). Gates
   * the Add-to-call tile on the client AND both /api/adhoc-room/* routes on the
   * server, so flipping it off stops new escalations without a build. Ships
   * FALSE: the room this creates is a NEW `kind='call'` conversation and the
   * make-before-break migration (spec §4, Phase 2) does not exist yet, so nothing
   * should be able to reach it by accident. Rooms already created stay in D1
   * either way — nothing deletes conversations today (spec §11 item 1).
   * Boolean → NOT in numericKeys. Client mirror: RemoteConfig.addToCallEnabled.
   */
  addToCallEnabled: boolean;
  /** 1:1 P2P call translation. Independent gate: remains dark by default. */
  callTranslationEnabled: boolean;
  /**
   * [CALL-TRANSLATE-FREE-1] OWNER DECISION 2026-08-05 — REVERSES the 2026-08-04
   * paid-only ruling. Testers hold only the 100-token welcome grant plus the daily
   * free grant, so a paid-only gate made live translation untestable by everyone
   * except the owner. When true, `/start` gates on `spendable` (free + bonus +
   * paid) and every per-minute charge passes `allow_free: true`.
   *
   * The gate and the charge MUST agree — both read this one flag, which is why it
   * is a flag and not two hardcoded constants. Flip it to false to restore
   * paid-only without shipping a build.
   */
  callTranslationAllowFreeTokens: boolean;
  // [CALL-TRANSLATE-2D-3] Call-translation abuse ceilings, per payer per hour.
  // These MUST stay tunable from KV: the client's speculative warm-up (Phase C)
  // creates REAL /start rows that are frequently discarded, so a ceiling written
  // for "one start per call" locks a legitimate payer out. Numeric → all three
  // also appear in `numericKeys` below (see the fake-flag rule in CLAUDE.md).
  /** Real (adopted) POST /api/call-translation/start calls allowed per hour. */
  callTranslationStartsPerHour: number;
  /** Speculative warm-up starts (`warm_up:true`, never activated) per hour. */
  callTranslationWarmupsPerHour: number;
  /** POST /api/call-translation/:id/language calls per hour (2–3 per switch). */
  callTranslationSwitchesPerHour: number;
  translationGroupEnabled: boolean;  // group conferences (multi-speaker caveat)
  // AvaVoice — creator-built AI voice agents (Specs/AVAVOICE-PROPOSAL.md).
  avavoiceEnabled: boolean;          // master switch for /api/avavoice/*
  avavisionEnabled: boolean;         // master switch for /api/avavision/* (vision coaching agents)
  // [AI-FLAG-CONTRACT-1] Hands-free Ava voice call. Was read by the client
  // (remote_config.dart) but never declared here — an un-flippable fake flag
  // (putConfig 400s `unknown key` on any attempt to set it in KV; see the
  // 2026-07-15 inAppUpdateEnabled lesson in CLAUDE.md). Declaring it makes the
  // documented KV brake real. Default false — matches the client's permanent
  // fallback, so declaring it changes nothing today until explicitly flipped.
  aiVoiceCallEnabled: boolean;
  // Ava Receptionist — premium "Ava answers after N rings" (Specs/PROPOSAL-AI-RECEPTIONIST.md
  // + PROPOSAL-RECEPTIONIST-V2.md). First real AvaVoice deployment. Gemini Live via CF AI
  // Gateway, 2-min cap.
  receptionistEnabled: boolean;      // master switch for /api/receptionist/* (default OFF until tested)
  // Authenticated AvaTOK users who are not in the callee's synced contacts still
  // ring by default. Turning this on restores the opt-in privacy mode that sends
  // such callers directly to Ava. It must never be inferred merely from a
  // successful address-book sync: that made ordinary calls silently become
  // voicemail after sync completed (production incident 2026-08-03).
  unknownAvatokCallerReceptionistEnabled: boolean;
  // [AVACALL-VMFREE-1] FREE AvaTOK↔AvaTOK auto-voicemail (owner decision, Phase WS2).
  // When an AvaTOK→AvaTOK AUDIO call is rejected / unanswered / phone-off and the
  // callee has NO active AI receptionist, the CALLER auto-fires a pre-recorded
  // generic voicemail (greeting → beep → ~25s record). FREE for everyone, so this
  // is NOT gated by the paid `voicemailBot`/`businessCallUx`. Default TRUE (kill
  // switch): flip false in KV to end no-answer AvaTOK calls silently again. Boolean
  // → no numericKeys entry. Client mirror: RemoteConfig.avatokVoicemailFree.
  avatokVoicemailFree: boolean;
  // [VM-KILL-1] GLOBAL voicemail master kill switch (owner decision 2026-07-21).
  // Default TRUE = voicemail available (legacy behavior, no change). Flip FALSE in
  // KV to disable EVERY voicemail lane at once — free AvaTOK↔AvaTOK auto-voicemail
  // (voicemail_routes.ts), paid voicemail bot, PSTN voicemail (pstn.ts), and the
  // per-owner mode='vm' receptionist flow (receptionist.ts coerces 'vm'→'agent').
  // A single reversible switch layered ON TOP of the per-surface flags so voicemail
  // is off for everyone without ripping out the code. Boolean → no numericKeys entry.
  // Client mirror: RemoteConfig.voicemailEnabled.
  voicemailEnabled: boolean;
  instantCallMountEnabled: boolean;  // [INSTANT-CALL-MOUNT-1] open 1:1 CallScreen instantly, POST /api/call in background (default ON; kill switch)
  receptionistRings: number;         // v2 Mode A: rings before auto-handoff (default 5)
  // Receptionist ENGINE switch (Specs/RECEPTIONIST-CF-PIPELINE.md). false (default)
  // = Gemini Live (do/reception_room.ts — untouched). true = the SEPARATE
  // Cloudflare-native engine (do/reception_room_cf.ts: Workers AI Deepgram/Whisper
  // STT → Llama LLM → Aura-2 TTS, fixed female "Ava"). Same Flutter client either
  // way — /start just points the call's WS at the chosen DO. One KV flip switches
  // every NEW call, instantly reversible, so the two can be A/B'd for cost.
  receptionistUseCf: boolean;
  // ZERO-COST VOICEMAIL MODE (owner 2026-07-19): routes receptionist calls to the CF
  // DO in a deterministic voicemail flow — play the owner's CACHED Bulbul-v3 greeting
  // ("Hi, seems like <owner> is not available — kindly leave a message after the
  // beep"), beep, record 30s (warning beep at 25s), store + notify. The greeting is
  // rendered ONCE per (owner name + language + voice) and cached in R2 — a name or
  // language change auto-regenerates on the next call (content-hash key). NO
  // STT/LLM/live-TTS runs during the call, so marginal AI cost is zero. Takes
  // precedence over receptionistUseCf/Gemini while ON.
  receptionistVmMode: boolean;
  // [AVA-VM-NOCOUNTDOWN-1] client 3-2-1 Ava warm-up countdown before voicemail.
  // Default true (legacy); flipped false in prod KV — the cached VM greeting is
  // instant so the warm-up screen is dead time. Client mirror: RemoteConfig.
  avaCountdownEnabled: boolean;
  // [RECEPT-BILLING-LIVE-1] charge ava_receptionist_minute for REAL even while
  // betaFreePremium is on (forceMeter) — lets the owner live-test token deduction
  // without ending the free beta platform-wide. Default false (beta stays free).
  receptBillingLive: boolean;
  // [RECEPT-LIB-1] Register each Ava-receptionist voicemail into `user_media` so
  // it appears in AvaLibrary's "Ava Receptionist" audio folder. Default TRUE —
  // the folder has shipped empty since [LIB-AUDIO-SPLIT-1] and this is the
  // missing producer. Kill switch: flip false in KV and new voicemails stop
  // getting a library row (they are still stored, still delivered to the Inbox
  // and still playable through the existing endpoint — the row is a convenience
  // layer, nothing depends on it). Existing rows are NOT removed by flipping it.
  receptionistLibraryEnabled: boolean;
  // [RECEPT-PRIVBUCKET-1] Voicemail/receptionist recordings are stored in the
  // PRIVATE `DIGITAL` bucket instead of the PUBLIC blossom one. Default TRUE:
  // the public bucket has a custom domain and no auth, so the old behaviour
  // made every caller's recorded message fetchable by path. Flipping it FALSE
  // sends NEW recordings back to the public bucket (an escape hatch only —
  // e.g. if a presign/credential problem is ever traced here). Playback is
  // bucket-agnostic either way (lib/voicemail_library.ts reads DIGITAL first,
  // then BLOBS), so this flag can never make an existing recording unplayable.
  voicemailPrivateBucket: boolean;
  // [AVABRAIN-FLAGS-1] AvaBrain program flags (Specs/AVABRAIN-PRODUCT-BIBLE-2026-07-24.md).
  // Personal Live-voice billing (voice_billing.ts): master gate + a
  // receptBillingLive-style force-meter for real charges during any free beta.
  // Tariff is NOT a flag — it reuses ava_receptionist_minute (3 tokens/min).
  avaBrainVoiceBillingEnabled: boolean;
  avaBrainVoiceBillingLive: boolean;
  // media_memory daily-recording pipeline (routes/brain_media.ts + consumer).
  mediaMemoryEnabled: boolean;       // master gate — recordings refuse when off
  mediaMemoryMaxSec: number;         // per-recording duration cap
  mediaMemoryMaxBytes: number;       // per-recording size cap (24MB = Whisper ceiling)
  mediaMemoryFrameBudget: number;    // video caption frame budget (captioner currently stubbed)
  mediaMemoryDailyPerUser: number;   // recordings/user/day
  mediaMemoryConcurrency: number;    // in-flight processing per user
  // Explicit private-content export (routes/brain_export.ts; domain private_export is opt-IN).
  avaBrainExportDailyCap: number;    // exported items/user/day
  // Group companion drafts (lib/companion_policy.ts) — knobs behind avaGroupCompanionEnabled.
  companionGroupCooldownSec: number; // min seconds between drafts per group
  companionGroupDailyBudget: number; // drafts per group per day
  // P1 call-reliability (Specs/MASTER-PROMPT-LAUNCH-READINESS-2026-07-02.md, Phase 1).
  // When ON, the caller's Ava-takeover countdown does NOT start until the server
  // confirms the incoming-call FCM push outcome over the CallRoom socket
  // ({type:'ring-ack', ok}). ok:true → give the callee the full ring window;
  // ok:false (push failed, callee can't ring) → hand to Ava immediately; no
  // ring-ack within 5s → fall back to today's timer. Default OFF (ships dark;
  // flip after a device test). Client mirror: RemoteConfig.receptTakeoverGuard.
  receptTakeoverGuard: boolean;
  // [AVA-PREWARM-1] Owner-requested fix for the 10-11.5s silent gap between
  // ringback stopping and Ava's first audio on outgoing calls (prod
  // ava_recept_first_audio ms=9801/11461). While the caller's ring is still
  // playing, the client starts the receptionist session (HTTP /start + WS +
  // mic + CF engine) in the background with the audio held, so spin-up
  // overlaps the final rings instead of happening in dead air after they
  // stop. Kill switch: default TRUE; flip false in KV to fall back to the
  // cold post-ring start with no rebuild. Client mirror: RemoteConfig.avaPrewarmEnabled.
  // Boolean → NOT in numericKeys.
  avaPrewarmEnabled: boolean;
  // AvaAffiliate (Specs/proposals/PROPOSAL-AVA-AFFILIATE.md). OFF stops
  // registration, attribution + the settlement step (redirects keep working).
  avaAffiliateEnabled: boolean;      // master switch (default OFF until launch)
  affiliateJoinLinkEnabled: boolean;
  affiliateAssetKitEnabled: boolean; // v2 Gemini promo-image kit (flag only; no code in v1)
  upiPayoutEnabled: boolean;
  affiliatePayoutAllowlistOnly: boolean;
  upiPayoutMinCoins: number;
  upiPayoutReservationTtlHours: number;
  upiVpaCooldownHours: number;
  // [AFF-COMM-LIFECYCLE-1] Commission qualification lifecycle
  // (Specs/proposals/PROPOSAL-AFFILIATE-UPI-2026-08-05.md §6.1/§6.2/§7). A top-up
  // commission is now a D1 `pending` row with NO wallet credit; the qualification
  // cron (runAffiliateQualification, routes/affiliate.ts) re-checks refunds, caps,
  // clustering and affiliate standing AT PROMOTION TIME and only then calls
  // walletOp 'earn' (which starts the usual 7-day hold). Total time to
  // withdrawable = affiliateQualifyDays + 7. ALL FIVE ARE NUMERIC — they MUST
  // also appear in `numericKeys` below or `flags.sh set affiliateQualifyDays=45`
  // 400s `bad type` (the fake-flag rule, CLAUDE.md). Caps are deliberately
  // conservative: they can be raised on evidence, but coins paid out on a
  // fraudulent referral cannot be un-paid.
  affiliateQualifyDays: number;              // days from top-up to promotion (launch: 30)
  affiliateMinQualifyingTopupCoins: number;  // dust-farming floor on the SOURCE top-up
  affiliateDailyEarnCapCoins: number;        // per-affiliate promoted coins per UTC day
  affiliateMonthlyEarnCapCoins: number;      // per-affiliate promoted coins per UTC month
  affiliatePerReferredCapCoins: number;      // per (affiliate, referred user) within one qualify window
  // Ava in-chat AI kill-switches (Phase 0 — Foundations). These gate the
  // SERVER-SIDE Ava surfaces/tiers; the client mirrors the defaults in
  // app/lib/core/feature_flags.dart. NOTE: runtime "is Ava on for THIS user" is
  // BYO/our-keys connection state, separate from `aiEnabled` (which is the
  // platform-wide master switch / panic button).
  aiEnabled: boolean;                // master switch for ALL Ava features (panic off)
  // [AI-BILLING-CORE-1] Master switch for the universal AIJob reserve/settle/
  // release wallet-metering contract (worker/src/lib/ai_billing.ts, Specs/
  // AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md §H2/H3/H6/J13). DEFAULT FALSE:
  // while off, reserveAiJob/settleAiJob/releaseAiJob are all no-op pass-throughs
  // (the AI job runs exactly as it does today, nothing is reserved or debited,
  // telemetry still fires with metered:false) — so declaring and wiring this
  // flag changes NOTHING in production until the owner explicitly flips it.
  // Guardian/safety capabilities NEVER go through this gate regardless of its
  // value — they bypass reserveAiJob entirely (see isSafetyCapability()).
  aiWalletMeteringEnabled: boolean;
  // [AI-PRICE-CATALOG-1 / unrecovered-cost controls, §66] Per-account daily ceiling
  // (micro-USD) on `unrecovered_micro_usd` — the gap between a reservation's
  // worst-case estimate and the provider's actual settled cost. Once an account
  // crosses this in a UTC day, further METERED jobs are blocked with a distinct
  // `AI_UNRECOVERED_LIMIT` reason (never a wallet/paywall error) until rollover.
  // Free capabilities (chat_ava/chat_thread) never consult this — it only bounds
  // platform loss on metered multimodal lanes. Numeric — see numericKeys below.
  unrecoveredDailyCapMicroUsd: number;
  // [AI-PRICE-CATALOG-1 / §66] Platform-wide daily unrecovered-loss ALERT threshold
  // (micro-USD), distinct from the per-account CAP above. Crossing this in a UTC
  // day fires an edge-triggered page/alert (recordUnrecoveredLoss in
  // worker/src/lib/ai_billing.ts) — it never blocks a job, only pages. 0/absent =
  // alerting disabled. Declared here (interface + DEFAULTS + numericKeys in the
  // same change) per the fake-flag rule: ai_billing.ts previously read this key
  // through an `as any` cast because config.ts never declared it, so `putConfig`
  // 400'd `unknown key` on any attempt to set it and the alert was permanently
  // unreachable (gate finding B3 — the same failure shape as inAppUpdateEnabled).
  unrecoveredPlatformAlertMicroUsd: number;
  focusMode: boolean;                // hide non-AvaTOK apps in the drawer (reversible)
  webSearchEnabled: boolean;         // premium-only; our-keys free tier never gets it
  fileAnalysisEnabled: boolean;      // premium-only
  openChatUncapped: boolean;         // premium removes the daily cap
  dailyAvaTurnLimit: number;         // free-tier turn cap (turns/account/day) — secondary anti-script limit; the real cost bound is the freeText* budgets below (§19b)
  // [AVA-FREE-BUDGET-1] Free-text-lane budgets (§12b/§19/§55). Text chat
  // (`chat_ava`/`chat_thread`, routed to deepseek/deepseek-v4-flash) is
  // structurally free — these bound COST and ABUSE, not billing. All numeric —
  // see numericKeys below.
  freeTextMaxInputTokens: number;      // per-turn input-token ceiling; over this the turn is rejected with input_too_large (route large pastes/attachments to the paid document flow instead)
  freeTextDailyInputTokens: number;    // per-account daily input-token budget, UTC-day reset
  freeTextDailyOutputTokens: number;   // per-account daily output-token budget, UTC-day reset
  freeTextDailyCostMicroUsd: number;   // per-account daily INTERNAL platform-cost budget (micro-USD), UTC-day reset — counts guardInput/isSafe/regenerate calls too, even though they are never wallet-billed
  // [AI-MOD-FLAG-1 2026-07-25, gate finding B5] Master switch for the
  // llama-guard-3-8b content classifier in lib/ai_gate.ts (ChatAva buffered +
  // streaming, @ava/#ava thread replies, runGated, image prompts). Content
  // moderation for the Ava AI paths was an explicit, DATED owner decision to be
  // a no-op (2026-06-24, Specs §2A). Default FALSE preserves that decision —
  // the classifier ships DARK and is a true no-op (no provider call, always
  // safe) on every tier including BYO until the owner deliberately flips this
  // on. Boolean → NOT in numericKeys. Declared here (interface + DEFAULTS in
  // the same change) per the fake-flag rule: a client/server gate the code
  // reads but this file does not declare can never be flipped (`putConfig`
  // 400s `unknown key`) — the exact inAppUpdateEnabled failure shape from
  // 2026-07-15.
  aiContentModerationEnabled: boolean;
  guardianEnabled: boolean;          // Guardian safety surfaces (basic free, deep premium)
  companionEnabled: boolean;         // blank "New chat with Ava" + personas
  generativeEnabled: boolean;        // in-thread image gen (each gen is a PaidFeature)
  // [PIVOT-AI-SWITCHES-1] Two AI surfaces that had no remote switch at all until
  // 2026-08-27. "Discuss with Ava" was gated only by the compile-time const
  // kDiscussWithAvaEnabled (needing an APK + store rollout to disable), and AskAva
  // had nothing whatsoever — it was dark only as a side effect of shellV2 being
  // false, so flipping shellV2 on for the Marketplace landing would have shipped
  // an AI surface with no brake. Both default TRUE so declaring them changes no
  // behaviour; the marketplace-first pivot flips them in KV as a separate step.
  discussWithAvaEnabled: boolean;    // thread menu → "Discuss this chat with Ava"
  askAvaEnabled: boolean;            // standalone AskAva surface (ShellV2)
  imageDailyCap: number;             // per-USER/day image-gen fair-use backstop (ALL tiers, incl. unlimited)
  // Dedicated gate for the durable derived-media API. It remains dark until a
  // real queue is provisioned and at least one kind handler is implemented.
  aiMediaJobsEnabled: boolean;
  // [AVA-MEDIA-JOB-2] MVP voice-note decision (owner, 2026-07-25): voice notes
  // in DMs are sent SERVER-READABLE (not E2E) so the server can transcribe
  // them — encryption also cost sending latency. Default FALSE = unencrypted
  // (the MVP state). "Unencrypted" only means the SERVER can read the bytes;
  // it does NOT mean the world can — the upload path
  // (worker/src/routes/media.ts's uploadPrivate, x-encrypted:0) still stores
  // these in the private, access-gated DIGITAL bucket, never the public
  // BLOBS/blossom bucket (see this issue's B3 fix). Boolean → NOT in
  // numericKeys. Declared here (interface + DEFAULTS in the same change) per
  // the fake-flag rule — the exact inAppUpdateEnabled failure shape from
  // 2026-07-15 (a client-read flag `config.ts` doesn't declare 400s on
  // `putConfig`, "unknown key", and can never actually be flipped).
  voiceNoteEncryptionEnabled: boolean;
  // AI Ringback Tones + Busy Tone (Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md).
  // Master switch for /api/ringtone/* (generation/library) AND the caller-side
  // ringback playback. OFF → generation 503s and callers fall back to today's
  // silent ring + system busy. Client mirror: kRingbackEnabledDefault.
  ringbackEnabled: boolean;
  // Call-reliability program (Specs, 2026-07-24) — rollout flags for the
  // call-audio/ICE/relay-migration/receptionist-reconnect work. All ship
  // dark (default false) and are flipped one at a time per milestone as each
  // piece is device-verified. Boolean → no numericKeys entry.
  callAudioControllerV2: boolean;      // new unified audio controller path
  callPlayoutHealthV2: boolean;        // playout/media health monitoring v2
  callIceRecoveryV2: boolean;          // ICE restart / recovery v2
  callRelayMigrationV1: boolean;       // relay migration during a live call
  callQosAdaptV1: boolean;
  callCellPresetV1: boolean;
  callQualityIndicatorV1: boolean;
  callAudioRedExperimentV1: boolean;
  callVideoDegradeV1: boolean;
  callVideoCodecPrefV1: boolean;
  // [CALL-VIDEO-RENDER-WATCH-1] Renderer stall self-heal: when inbound video
  // is DECODING but the renderer holds a different (stale) track, rebind it.
  // Kill switch for the heal only; detection telemetry stays on either way.
  callVideoRenderHealV1: boolean;
  receptionistReconnectV1: boolean;    // receptionist reattach-on-reconnect
  callRingAudibilityV1: boolean;       // REL-10 ring audibility fix
  // [CALL-SURVIVE-1 2026-08-04] Handover-survival tunables (numeric — MUST
  // also be in numericKeys below, fake-flag rule). Client mirrors:
  // RemoteConfig.callRecoveryDeadlineSec / callMigrationDeadlineSec /
  // callRecoveryMaxAttempts. Deadlines per attempt; attempts ride the
  // client's 2/4/8/16/30s backoff ladder.
  callRecoveryDeadlineSec: number;     // ICE-recovery attempt deadline (was fixed 30)
  callMigrationDeadlineSec: number;    // relay-migration attempt deadline (was fixed 20)
  callRecoveryMaxAttempts: number;     // retry-ladder length before resting in `reconnecting`
  callQosHeadroomFactor: number;
  callQosLossDownshiftPct: number;
  callQosStableLossPct: number;
  callQosStableRttMs: number;
  callQosStableSamples: number;
  callVideoLossDegradePct: number;
  callVideoLossPausePct: number;
  callVideoStableSamples: number;
  /** [CALL-WS-AUTH-1 2026-08-03] ENFORCE per-side room-token authentication on
   *  CallRoom WebSocket joins (`/room/<id>?t=<token>`).
   *
   *  OFF (the default) = observe only: an unauthenticated join is admitted and
   *  tagged `call_ws_join_unauthenticated` in telemetry. ON = an unauthenticated
   *  or mismatched join is refused with 403.
   *
   *  It ships dark because flipping it BEFORE a build carrying the client half is
   *  in the field would break calling for every installed app — those builds do
   *  not send `?t=` and would be refused at admission. Flip it only once
   *  `call_ws_join_unauthenticated` has gone quiet in PostHog.
   *
   *  Boolean → NOT in numericKeys. Declared here (interface + DEFAULTS in the
   *  same change) per the fake-flag rule: a flag config.ts does not declare is
   *  rejected by putConfig with "unknown key" and can never be flipped, so the
   *  kill switch would not exist. */
  callRoomAuthEnforced: boolean;
  /** [CALL-NATIVE-ANSWER-1] Interactive native "ring screen" (caller name +
   *  Accept/Decline) that MainActivity paints the instant the incoming-call
   *  notification is tapped, while the Flutter engine is still cold-starting.
   *  Root cause it targets: `_routeToBrandedIncoming` in push_service.dart
   *  polls `navigatorKey.currentState` every 250ms for up to 10s waiting for
   *  the Flutter branded screen — production measured 5.61s from
   *  `call_incoming_shown` to `call_branded_fsi_routed` on 2026-08-17, during
   *  which the owner could not press Accept.
   *
   *  OFF (default) = today's behaviour exactly: MainActivity shows only the
   *  passive [CALL-ACCEPT-FRAME-1] "Connecting…" overlay (no buttons) and the
   *  user answers from the Flutter branded screen once it finally paints.
   *
   *  Native cannot read RemoteConfig (no engine on a cold notification tap),
   *  so Dart mirrors the resolved value to
   *  `<filesDir>/callnative/answer_flags.json` on every config refresh (see
   *  `RemoteConfig.refresh()`), matching the `nativeInCallUi` /
   *  `AvaDialPlugin.nativeUiFile` pattern. A missing/unreadable mirror reads
   *  as OFF.
   *
   *  Boolean → NOT in numericKeys. Declared here (interface + DEFAULTS in the
   *  same change) per the fake-flag rule: a flag config.ts does not declare
   *  is rejected by putConfig with "unknown key" and can never be flipped, so
   *  the kill switch would not exist. Client mirror:
   *  RemoteConfig.callNativeAnswerV1. */
  callNativeAnswerV1: boolean;
  // BETA PHASE (2026-06-21, owner): open EVERYTHING at premium tier, free for all.
  // When true: isPremiumAI is true for every user (all AI tools unlocked, daily cap
  // bypassed), chargeFeature deducts nothing (no Token metering), and the wallet
  // balance reports premium:1 so the whole client renders premium (green pill →
  // "BETA PHASE", no PAID badges, no upsell). Flip to false in KV to restore the
  // normal free/premium + coin-metering model — no redeploy needed.
  betaFreePremium: boolean;
  // Phase 1 subscriptions (Free/Plus/Pro/Max — Specs/PROPOSAL-USAGE-PACKAGES-AND-GATING.md).
  // While FALSE: the Subscribe screen renders for preview but checkout endpoints
  // 503 and NO tier gating is enforced (today's beta = everyone unlimited). Flip
  // TRUE to enable real checkout + per-tier daily allowance enforcement. One KV
  // flip, no redeploy.
  billingEnabled: boolean;
  // AvaWallet Google Play top-up (fixed-price `avatok_topup_*` products → Tokens).
  // Independent of billingEnabled (that gates subscriptions): a user can top up
  // their wallet even while subscription paywalls are off. When FALSE the verify
  // endpoint 503s. Real security gate is the Play service account (fail-closed);
  // this is the killable master switch. Owner flips via scripts/flags.sh.
  playTopupEnabled: boolean;
  // AvaTOK Number (Specs/AVATOK-NUMBER-FEATURE-SPEC.md) — purchasable in-network
  // virtual number that represents a user and hides their real phone. Master
  // switch for /api/number/* and the directory's number search key.
  numberFeatureEnabled: boolean;
  // [PIVOT-PAID-NUMBER-1] Price (in tokens, 1 token = ₹1) for a FREE-TIER user to
  // buy a specific vanity/short AvaTOK number without a subscription — the paid
  // path added alongside the existing tier-gated reserve/assign flow in
  // number.ts. NUMERIC → MUST also be in `numericKeys` below (fake-flag rule,
  // CLAUDE.md) or `flags.sh set avatokVanityNumberTokens=50` 400s `bad type`.
  // Default 0 means "not for sale" — the purchase endpoint fails CLOSED (never
  // free) until the owner explicitly prices it in KV, mirroring how an
  // unconfigured telephony_tiers/virtual_lines rate is treated.
  avatokVanityNumberTokens: number;
  // AVACALLS / Virtual Numbers — dark until the additive schema and client are
  // verified. Numeric values are token units unless explicitly named subunits.
  avaCallsEnabled: boolean;
  avaCallsUniversalDialpadEnabled: boolean;
  avaCallsAvatokResolveEnabled: boolean;
  avaCallsPstnOutboundEnabled: boolean;
  avaCallsPstnTokensPerMinute: number;
  avaCallsPstnMinRunwayMinutes: number;
  virtualNumbersEnabled: boolean;
  virtualNumberDidPurchaseEnabled: boolean;
  virtualNumberFreeEnabled: boolean;
  virtualNumberFreeMaxPerAccount: number;
  virtualNumberDidMonthlyTokens: number;
  virtualNumberSmsEnabled: boolean;
  virtualNumberOtpEnabled: boolean;
  virtualNumberRecordingsEnabled: boolean;
  virtualNumberReceptionistEnabled: boolean;
  virtualNumberPrimaryProvider: "vobiz" | "frejun";
  virtualNumberFrejunEnabled: boolean;
  virtualNumberVobizEnabled: boolean;
  virtualNumberProviderFailoverEnabled: boolean;
  teamIvrEnabled: boolean;           // master switch for /api/team/* (auto-attendant + team billing)
  ivrAiFrontDesk: boolean;           // future: AI natural-language front desk (off; tap-menu is default)
  // Group invites with TRUE pending membership + Accept/Decline (owner request
  // 2026-06-29). OFF (default) = current behavior: added members join the group
  // immediately. ON = added users get a PENDING invite (group_invites table) and
  // only become members of conversation_members when they Accept — so the message
  // router is unaffected (pending users simply aren't members yet). Flip ON in KV
  // after the migration + a test; no redeploy.
  groupInvitesEnabled: boolean;
  // P4: gate ALL listing creation/publish on video-liveness verification
  // (kyc_status='verified'). Browsing stays free. Default OFF (ships dark; flip ON
  // at launch). Fail-closed on the server route — a direct API call from an
  // unverified user is rejected 403 liveness_required.
  listingLivenessGate: boolean;
  // Liveness V2 (Specs/LIVENESS-V2-PLAN.md): the ML-Kit-gated, detection-driven
  // selfie-video verification flow that replaces the timer-script V1. Ships DARK
  // (default OFF); while off the client uses the V1 LivenessCheckScreen unchanged.
  // Flip ON in KV once V2 pass-rate is proven. Client mirror: RemoteConfig.livenessV2Enabled.
  livenessV2Enabled: boolean;
  // Liveness V2 P3 (Specs/LIVENESS-V2-PLAN.md §3/§6). Optional accuracy booster:
  // when ON *and* AWS creds (AWS_ACCESS_KEY_ID/SECRET/REGION) exist, the server-side
  // same-person check (B5) runs the STANDARD Rekognition IMAGE API CompareFaces
  // (neutral vs a challenge frame, similarity ≥ 90). NEVER the paid managed Face
  // Liveness API. Default OFF: with it off (or no creds) B5 is skipped-as-pass so a
  // user is never failed on a check we can't run. Purely additive — verification
  // stays 100% Workers-AI (LLaVA + Whisper) unless this is flipped.
  livenessUseRekognition: boolean;
  // [LIVE-DEVAUTH-1] device-authoritative liveness (scaling plan). Default OFF.
  // When ON, a verify carrying a device_report with ALL checks true skips the
  // expensive B2/B3/B4/B7 LLaVA calls (marked pass with an `_device` id suffix)
  // and runs only B1 realness (1 call) + B6 phrase + B9 clip sanity. A random
  // livenessAuditSampleRate fraction of device-authoritative verifies ALSO runs
  // the full LLaVA pipeline for disagreement telemetry (liveness_audit_sample).
  livenessDeviceAuthoritative: boolean;
  // [LIVE-DEVAUTH-1] fraction (0..1) of device-authoritative verifies that also
  // run the full server-side LLaVA pipeline, purely for audit/disagreement
  // telemetry (never changes the verdict served to the client).
  livenessAuditSampleRate: number;
  // Liveness V3 (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-DRAFT.md) — voice-guided,
  // randomized head-and-neck capture, Rekognition DetectFaces via the provider-
  // normalization + deterministic-rules pipeline (worker/src/routes/liveness_v3.ts).
  // EXTENDS V2 (never replaces it): V2 stays the default flow. Ships DARK (default
  // OFF). When ON, the client can open the /api/liveness/v3/* Policy-Engine
  // entrypoint; while OFF those routes 503 `flag_off`. Flip ON in KV (never code —
  // 2026-07-04 lesson). Client mirror: RemoteConfig.livenessV3Enabled.
  livenessV3Enabled: boolean;
  // [AVA-IDGATE-1] Just-in-time identity gating (Specs/SPEC-2026-07-10-identity-gating.md).
  // Master kill switch. When ON, every PUBLIC action (post/listing/comment/live/
  // dm-to-stranger/group-post/upload) requires a Didit liveness pass no older than
  // `livenessValidityDays`. Consumers are never gated; signup is never gated.
  // Ships DARK. Flip ON in KV only AFTER the backfill migration has run — otherwise
  // every existing user is gated on their next public action (spec §11.1).
  identityGatingEnabled: boolean;
  // Liveness validity window in days (owner decision: 90). Widening this is the
  // no-code contingency if Didit's per-call price above the 500/mo free cap bites
  // (spec §9) — it divides check volume directly.
  livenessValidityDays: number;
  // [AVA-IDGATE-1] Version string for the biometric-consent disclosure the user
  // agreed to (BIPA §15(b)). Bump when the disclosure text or retention period
  // changes; the value is stored per-user so we can prove WHICH text they saw.
  biometricConsentVersion: string;
  // [LIVE-DIDIT-1] didit.me-hosted liveness. Default ON — this IS the liveness path.
  // [LIVE-DIDIT-5] When ON, only didit-provider liveness counts for L2.
  // ── DRIFT FIX 2026-07-18: both keys existed in DEFAULTS but NOT here. That is the
  // INVERSE of the fake-flag bug: `putConfig` gates writes on `k in DEFAULTS` (a
  // runtime check), so they were settable and did reach clients — but they were
  // absent from the type, so `readConfig(env).diditLivenessEnabled` did not
  // typecheck, and `const DEFAULTS: PlatformConfig` was an excess-property error.
  // Nothing caught it because NOTHING TYPECHECKS THE WORKER: `npm run typecheck`
  // (tsc --noEmit) exists in worker/package.json but no workflow runs it, and
  // wrangler deploys via esbuild, which strips types without checking them.
  diditLivenessEnabled: boolean;
  requireDiditLiveness: boolean;
  // P6: always-on per-message safety scanning (Nemotron :free via OpenRouter) with
  // red-bubble marking on the recipient. Ships **ON** (this one ships enabled).
  // Async, fail-open — a scan never blocks or delays delivery. Adult opt-out lives
  // in Guardian settings; child accounts cannot opt out.
  safetyScanEnabled: boolean;
  // P11: mandatory + AI-vetted profile completion. When ON, `/api/me` reports
  // profile_complete and the profile save route enforces completeness + real-name
  // plausibility (+ photo moderation) server-side. Default OFF (ships dark; ON at
  // launch). Client mirror: RemoteConfig.profileCompletionGate.
  profileCompletionGate: boolean;
  // P8 backup/restore durability (Specs/MASTER-PROMPT-LAUNCH-READINESS-2026-07-02, Phase 8).
  chatArchiveV2: boolean;   // batched R2 cold archive on InboxDO append (dark until verified)
  restoreV2: boolean;       // new-phone restore lazily pages older history from R2 (dark)
  driveAutoBackup: boolean; // daily auto-backup to the user's OWN Google Drive — ships ON, ALL users
  // P5: per-user daily cap on DISTINCT marketplace agent conversations (UTC day).
  // Tunable via KV without redeploy. The per-listing talk-once dedupe is separate
  // and does NOT consume quota (re-opening the same listing's result is free).
  agentDailyCap: number;
  // STREAM F (AI Messenger Batch): "Ava replies while you're away" auto-responder.
  // Master kill switch for the whole feature — the settings page, hot-path enqueue,
  // and the auto_reply consumer all gate on this. Default ON (per spec AUTOREP-5).
  autoResponderEnabled: boolean;
  // AI Messenger Batch 2026-07-03 — per-stream kill switches (spec §8 / §12).
  marketplaceAgentSettingsEnabled: boolean; // STREAM A: Marketplace Agent settings surface
  mktI18nNegotiationEnabled: boolean;        // STREAM A: English-canonical negotiation + translation
  strangerGateEnabled: boolean;              // STREAM B: message-request stranger safety gate
  linkPreviewsEnabled: boolean;              // STREAM C: server-side unfurl + inline YouTube
  richInputEnabled: boolean;                 // STREAM E: emoji/GIF/sticker input panel
  groupTranslationEnabled: boolean;          // STREAM G: per-member group translation (cost watch)
  smartRepliesEnabled: boolean;              // STREAM G: DM smart-reply chips
  scamAutoScanEnabled: boolean;              // STREAM G: auto scam-scan on stranger-thread first render
  // [AVA-IDGATE-1] livenessOnboardingGate REMOVED — superseded by identityGatingEnabled
  // (gate at first public action, not at signup). See lib/identity_gate.ts.
  unlimitedForwardEnabled: boolean;          // STREAM I: unlimited forwarding + forward-to-groups
  // [AVAGRP-SEENBY-1] Group "Info → seen by" (WhatsApp-style per-message read/
  // delivered receipts for group chats). Master kill switch: OFF drops every
  // POST /api/msg/receipts write server-side (msgReceiptBatch short-circuits to
  // {ok:true, disabled:true} before touching any InboxDO) and the sender simply
  // sees no seen-by data — never a crash. Dark-launch default false; see the
  // DEFAULTS entry for why this pair MUST ship together in one change.
  groupReceiptsEnabled: boolean;
  // PERF-DNS-2: client DNS-over-HTTPS fallback (resolve our hosts via 1.1.1.1 when
  // the device resolver fails — carrier-proof). Default ON in the client even
  // without this key; this is a KV kill switch to force pure OS resolution.
  dohFallbackEnabled: boolean;
  // [ARCH-ROUTING-V2] Master kill switch for the v4 server-authoritative routing
  // path (Identity/Conversation/Routing/Delivery/Transport — frozen architecture,
  // Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md). Default OFF: the new /api/v2/*
  // endpoints answer 404 and NOTHING in the v4 path runs. Purely additive while
  // OFF — the legacy /api/conversations + /api/msg/send path is untouched. Flip ON
  // in KV per-cohort to strangle the legacy path over. Reversible with one KV edit.
  routingV2Enabled: boolean;
  // Guardian Sentinel (Specs/GUARDIAN-SENTINEL-FINAL-PLAN-2026-07-06.md, phase S1).
  // Master kill switch for the derived safety-projection engine (deterministic
  // extractors → append-only EvidenceAdded → snapshot+tail fold → SentinelDO hot
  // caches). Default OFF: the whole worker/src/sentinel/* pipeline is DARK — the
  // best-effort ingest hooks (e.g. after guardianScan.recordFlag) no-op, nothing is
  // written, no DO is touched. Flipping ON requires a KV patch of platform_config
  // (code defaults NEVER win over KV — 2026-07-04 lesson). S1 is telemetry-only; no
  // LLM, no mem0, no enforcement — thresholds ship dark and are tuned before any act.
  sentinelEnabled: boolean;
  // Sentinel S2 (behaviour memory via mem0) — gates the async summariser
  // (sentinel/summariser.ts). Default OFF. Also requires MEM0_API_KEY; both absent →
  // clean no-op. mem0 is a DERIVED cache, never an owner of truth (plan §1.1 rule 5).
  sentinelMem0Enabled: boolean;
  // Guardian G3 — INLINE two-lane scan (Specs/GUARDIAN-SENTINEL-FINAL-PLAN §G3).
  // When ON, messaging.ts awaits a cheap FAST-lane scan (regex + ONE Nemotron
  // moderate() call, hard-timeout budget guardianInlineBudgetMs) BEFORE fan-out in
  // guardian-ON chats and attaches the verdict to the fanned-out payload so the
  // recipient's bubble paints red on arrival. The detached DEEP lane (Opus) still
  // runs after fan-out (slow lane). Default OFF: with it off messaging.ts behaves
  // EXACTLY as today (deep lane only, no pre-fanout await). Fail-open everywhere —
  // a timeout/error never delays or blocks delivery. Flip ON via KV (never code).
  guardianInlineEnabled: boolean;
  // Fast-lane hard budget (ms) for the single Nemotron moderate() call in G3.
  // Promise.race trips at this bound → fan out immediately (fail-open) and emit
  // guardian_inline_latency_budget_breach. Numeric KV key (400–600 ms per plan).
  guardianInlineBudgetMs: number;
  // U1-lite — MANUAL "Require verification" gate (Specs/GUARDIAN-SENTINEL §U1, dark).
  // When ON, a 1:1 owner control can ask the peer to complete a live face check
  // (Trust Engine liveness) before continuing. Fully DARK by default: the server
  // require_verify/gate_status modes 403 `feature_off`, the client control is
  // hidden, and NOTHING is wired to enforcement. Flip ON via KV (never code).
  guardianGateEnabled: boolean;
  minAppBuild: number;
  // Newest build published to the store. When it is greater than the build the
  // user has installed, the app shows a (dismissible) "new version available"
  // popup whose Update button opens the Google Play listing. Owner bumps this in
  // KV each time a new release is published. 0 = never prompt. Distinct from
  // minAppBuild, which is the HARD floor that shows a blocking update screen.
  latestAppBuild: number;
  // [AVA-UPDATE-AUTO] Kill switch for the automatic in-app update flow
  // (app/lib/core/update_service.dart): the on-launch Play check, the background
  // flexible download, the auto-install, and the fallback popup. Default TRUE.
  //
  // THIS EXISTS BECAUSE IT DIDN'T. remote_config.dart's own docstring claimed you
  // could "flip inAppUpdateEnabled: false in KV" to silence the update checks —
  // but the key was never declared here, and the PUT handler below rejects any key
  // not in DEFAULTS (`unknown key`, 400). So the documented brake was unusable:
  // the client defaulted it true and nothing could turn it off. That is a bad
  // shape for a feature that installs itself without asking — if a build ever
  // ships an update loop, this switch is the only thing between a bad release and
  // every device retrying it. Declaring it makes the brake real.
  inAppUpdateEnabled: boolean;
  // Cloudflare-only media migration Wave-0 scaffold (Specs/CLOUDFLARE-ONLY-REALTIME-MEDIA-MIGRATION-PROPOSAL-2026-07-24.md).
  // Both dormant/legacy-safe defaults: Cloudflare conference path is not built yet
  // (stays OFF), LiveKit remains the live conference provider (stays ON) until the
  // migration flips them.
  cloudflareConferenceEnabled: boolean;
  // Call-state control-plane authority (Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md
  // §5 — protocol-v1/v2 shadow rollout). All default OFF/legacy: CallStateAuthorityDO
  // is wired (wrangler binding + v13 migration) but fully dormant until these flip.
  authorityShadowEnabled: boolean;  // shadow-write only, never read for decisions
  authorityReadEnabled: boolean;    // routes may READ authority state (still legacy writes)
  authorityWriteEnabled: boolean;   // routes WRITE through the authority DO
  authorityEnforced: boolean;       // authority verdicts are enforced (legacy path fully replaced)
  callProtocolVersion: number;      // client/server call-signaling protocol version (1 = legacy)
  // Personalized BUSY CARD (Specs/CALL-MESSAGING-RECEPTIONIST-REMEDIATION-PLAN.md
  // §3). Master kill switch for the whole busy-card server feature: the /acquire
  // busy-response enrichment (receptionist_enabled + generation), the bounded
  // waiter list ("Notify me"), and the "now free" FCM fan-out on return-to-idle.
  // Default OFF — while off, the acquire busy response is byte-for-byte today's
  // shape, no waiter rows are accepted, and no now-free push ever fires, so a bug
  // in this path can NEVER touch live calls. Flip ON in KV once the client card
  // ships + is device-verified. Client mirror: RemoteConfig.busyCardEnabled.
  busyCardEnabled: boolean;
  // Ava Copilot Phases A+B (Specs/AVA-COPILOT-FINAL-PLAN-2026-07-08.md §5–§9).
  // All default OFF — the routes 503 {flag} while dark; flip ON in KV (never code).
  avaCopilotEnabled: boolean;          // master: private lane posts + per-chat toggle + all /api/ava/doc/* routes
  avaDocActionsEnabled: boolean;       // context-menu doc actions (Summarize ✨ / Translate ✨)
  avaAutoTranslateFileEnabled: boolean; // "Auto-translate file ✨" (chunked whole-doc translation — cost watch)
  // Ava Copilot Phases C+D (ODL — Opportunity Detection Layer, shadow-mode).
  odlEnabled: boolean;        // Phase C: ODL wake scan from guardianScan (shadow-mode telemetry only)
  avaMomentsEnabled: boolean; // Phase C: master gate for user-visible Moments (nothing posts while false)
  // [AVA-GROUP-COMPANION-1] Group Ava (Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md
  // §I). Third gate stacked ON TOP of odlEnabled + avaMomentsEnabled — ALL
  // THREE must be true before ava_odl.ts's group path can post anything, and
  // even then only for groups whose OWN ava_group_state.mode === 'companion'
  // (per-group owner/admin opt-in, worker/migrations/ava_group_companion.sql).
  // Default false — group Companion mode ships fully dark.
  avaGroupCompanionEnabled: boolean;
  // [AVA-ODL-POST-1] Per-capability kill switches (ava_capabilities.ts
  // CAPABILITY_SEED[i].kill_switch). MUST be declared here — an undeclared
  // kill_switch key is a FAKE flag (putConfig 400s "unknown key" on any
  // attempt to set it, so it can never actually be pulled; see the
  // 2026-07-15 inAppUpdateEnabled lesson in CLAUDE.md). Only the two
  // lifecycle:"production" capabilities (meeting, reminder) can currently
  // reach the post path this flag gates; humor/auto_sticker stay shadow
  // (unreachable via CATEGORY_TO_CAPABILITY in v1) but are declared now so a
  // future lifecycle promotion never repeats the fake-flag mistake.
  avaCapMeetingEnabled: boolean;
  avaCapReminderEnabled: boolean;
  avaCapHumorEnabled: boolean;
  avaCapAutoStickerEnabled: boolean;
  // Remaining shadow-lifecycle capabilities (CAPABILITY_SEED) — declared for
  // the same fake-flag reason as above, even though shadow mode never posts.
  avaCapExpenseSplitEnabled: boolean;
  avaCapBirthdayEnabled: boolean;
  avaCapOtpGuardEnabled: boolean;
  avaCapOrderTrackingEnabled: boolean;
  avaCapTravelPlanEnabled: boolean;
  avaCapCelebrationEnabled: boolean;
  // CALL OUTCOME MENU (Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md). One server-
  // driven menu for every non-answered call (declined / no-answer / unreachable /
  // phone-off / Ava-mode / busy): Talk to Ava, voice note, text note, See Listings.
  callMenuEnabled: boolean;          // master switch — client shows the menu; server serves /api/call-menu
  callMenuListingsEnabled: boolean;  // "See Listings" button + Ava listings context — OFF until marketplace goes public
  callMenuRateLimitEnabled: boolean; // master switch for the per-caller daily caps below
  avaSessionsPerCallerPerDay: number;   // Talk-to-Ava cap per caller per owner per UTC day (owner 2026-07-09: 2)
  strangerVoiceNotesPerDay: number;     // stranger voice notes per caller per owner per day
  strangerTextNotesPerDay: number;      // stranger text notes per caller per owner per day
  // [MSG-GROUP-CAP-1] (Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md §J4) — the
  // product caps CONFERENCE size (≤25 via LiveKit/CF SFU), but until this flag
  // ordinary messaging groups had no comparable ceiling: create/adopt/add-member/
  // invite-accept in worker/src/routes/messaging.ts all expanded a client-supplied
  // member list into unbounded D1 writes + one queued fan-out job per 80 members
  // per message. Enforced server-side, before any D1 write, in convCreate,
  // convAdopt, convAddMembers, and the accept branch of convInviteRespond. Numeric
  // KV key — also in numericKeys below.
  maxGroupMembers: number;
  // Dialpad business calls + Ava AI Voice Agent (Specs/PLAN-2026-07-11-dialpad-
  // business-calls-ava-voice-agent.md §7/§15.6). One kill switch per phase — ALL
  // default OFF, staging first, prod flags flipped one at a time on the owner's
  // say-so. While every one of these is false, the whole feature is byte-for-byte
  // dark: no new UI, no new routes, no new event emission.
  businessCallUx: boolean;    // Phase A: channel split UI (named incoming-call screen, no-answer card, tappable numbers)
  brandedIncomingUi: boolean; // [AVACALL-INUI-1] branded IncomingBusinessCallScreen for ALL AvaTOK calls (friend+business), over the lock screen via full-screen intent. Default TRUE; false = native CallKit everywhere. Client mirror: RemoteConfig.brandedIncomingUi.
  foregroundRingDetectionV2: boolean; // [CALL-REL-R4-B 2026-08-03] Kill switch for the relaxed "is the app in front" test that decides whether the branded screen owns the ring. The old test was `lifecycle == 'resumed'` exactly, which is FALSE while Android is launching CallKit's own full-screen-intent activity over a perfectly open app — prod calls show `os_ring_suppressed=false lifecycle=paused`, i.e. both surfaces live, which is what leaves the OS ring sitting in the notification shade after Accept. V2 also accepts `inactive`, and `paused` within a short grace of the last resume, and arms a fallback that registers CallKit anyway if the app turns out not to be in front. Default TRUE; false restores the strict equality. Client mirror: RemoteConfig.foregroundRingDetectionV2.
  suppressOsRingInForeground: boolean; // [ONERING-1] When the app is FOREGROUNDED and the branded ring screen is pushed in-app, skip the native CallKit registration so Android's heads-up banner (its own Accept/Decline) does not stack on top of our screen. Foreground only — locked/backgrounded rings still use CallKit, and it remains the fallback where full-screen intent is denied. Default TRUE; false restores the old double-surface behaviour. Client mirror: RemoteConfig.suppressOsRingInForeground.
  notifMessagingStyle: boolean; // [NOTIF-STYLE-1 2026-08-17] Render incoming chat messages as a per-conversation Android MessagingStyle stack: one notification per chat on a stable per-conv id, all bundled under a shared groupKey with a "N messages from M chats" summary, each child expandable on its own chevron and carrying the sender's photo. Replaces the single hardcoded notification id 8000, under which a message from a second person OVERWROTE the first in place — which is why the shade could never physically hold more than one AvaTOK chat row. Default TRUE; false restores the legacy single BigText banner exactly. Client mirror: RemoteConfig.notifMessagingStyle.
  notifQuickActions: boolean; // [NOTIF-ACTIONS-1 2026-08-17] Attach Reply (RemoteInput, allowGeneratedReplies) / Mark as read / Mute actions to message notifications. Also what makes Android's on-device Smart Reply offer its "Okay/Thanks" chips, since it only does so for a MessagingStyle notification carrying a RemoteInput reply action. The reply is sent from a headless Dart isolate (bootstrapBackgroundIsolate re-establishes the Clerk bearer, without which the POST 401s), so this is the brake if that path misbehaves in the field. Default TRUE; false renders the same stacked cards with no buttons. Client mirror: RemoteConfig.notifQuickActions.
  notifReactions: boolean; // [NOTIF-REACT-1 2026-08-17] Push "X reacted <emoji> to your message" to the AUTHOR of the reacted-to message. Owner decision 2026-08-17: every reaction, 1:1 and groups, foreground and background, no throttling; Mute (NOTIF-ACTIONS-1) is the escape hatch. Before this, reactions were a TRANSIENT InboxDO frame only - never persisted client-side (the client never called POST /api/msg/react at all, despite kMsgReactUrl existing) and never pushed, so a reaction to a sleeping phone did not exist. Recipient is validated as a conversation member and never the reactor themselves; an unresolvable author means NO push rather than a guess. Default TRUE. Client mirror: RemoteConfig.notifReactions.
  voicemailBot: boolean;      // Phase B: server-side voice-prompt + 25s recording bot in the call room
  paidCalls: boolean;         // Retired per-recipient escrow compatibility key; forced false. Pooled call usage uses a separate authority.
  voiceAgent: boolean;        // Phase C: Ava AI Voice Agent (Grok realtime session)
  serviceNumbers: boolean;    // Phase C: Mode-B-only additional AvaTOK numbers
  // Home · AvaDial · AvaTalk · Services 4-root shell (Specs/PLAN-2026-07-12-home-
  // ava-tok-services-shell.md, Phase 1). Master kill switch for "shellV2". Default
  // OFF — while false the client renders the CURRENT shell (messenger-first, apps
  // pushed on top) byte-for-byte, and none of the new 4-root code runs. Flip
  // `shellV2: true` in KV `platform_config` (staging first) to switch the app to
  // the four-sibling shell (Home/AvaDial/AvaTalk/Services). Client mirror:
  // RemoteConfig.shellV2.
  shellV2: boolean;
  // AvaDial community spam shield (Specs/PLAN-2026-07-12-home-ava-tok-services-shell
  // .md §4.4, Phase 2a). Master kill switch for the whole spam-reputation backend:
  // /api/spam/report, /api/spam/lookup/:e164, /api/spam/bloom and the nightly
  // scoring job. Default OFF — while false EVERY spam route 403s, the D1 tables go
  // unused and the scoring job no-ops, so the feature is fully DARK. Flip
  // `spamShield: true` in KV `platform_config` (staging first) once the reputation
  // pool + on-device bloom cache are device-verified. Client mirror:
  // RemoteConfig.spamShield.
  spamShield: boolean;
  // AvaDial native dialer layer (Specs/PLAN-2026-07-12-home-ava-tok-services-shell
  // .md §4.1-4.3, Phase 2b). Master kill switch for the AvaDial PSTN surfaces in
  // the app: default-dialer onboarding banner, device contacts/logs tabs, block
  // list, red/green/blue PSTN call screens. Default OFF — while false AvaDial
  // shows the Phase-1 placeholders only. Flip `avaDialer: true` in KV
  // `platform_config` (staging first) after the §9 device test matrix passes.
  // Client mirror: RemoteConfig.avaDialer.
  avaDialer: boolean;
  // [AVADIAL-NATIVE-INCALL-1] Native in-call screen (owner decision 2026-07-15).
  // While FALSE, answering a PSTN call hands off to MainActivity and the Flutter
  // in_call_screen.dart exactly as before. While TRUE, the native InCallActivity
  // takes over and Flutter never enters the call path at all — no engine boot, no
  // Keystore, no Firebase/PostHog init, no 3s shell gate.
  //
  // This is the ONE flag that matters most on this feature: the answer path is the
  // same one that broke prod testers on 2026-07-14. Default OFF; flip it only after
  // device testing, and revert instantly if anything looks wrong.
  //
  // Native cannot read RemoteConfig (it runs with no engine), so Dart mirrors the
  // resolved value to <filesDir>/avadial/native_ui.json on every config refresh —
  // see AvaDialChannel.setNativeInCallEnabled / AvaDialPlugin.nativeInCallEnabled.
  // A missing/corrupt mirror reads as OFF (fail-closed).
  nativeInCallUi: boolean;
  // [AVA-MISSEDCALL-1] Truecaller-style missed-call overlay (owner request 2026-07-14).
  // Master kill switch for the after-call popup that draws OVER other apps naming who
  // called + quick actions, AND for the phone-presence lookup that lights the AvaTOK
  // icon. IMPORTANT: turning this ON deliberately REVERSES the 2026-06-27 privacy lock
  // — /api/contacts/match resolves AvaTOK membership from the caller's real phone
  // number (private or not), per the owner's explicit 2026-07-14 instruction. While
  // false the match endpoint returns nothing (old privacy behaviour) and the native
  // receiver/overlay stay inert. Client mirror: RemoteConfig.missedCallOverlay.
  missedCallOverlay: boolean;
  // AvaDial default-SMS-app layer (Specs/PLAN-2026-07-12-home-ava-tok-services-shell
  // .md, AVA-SMS; owner decision 2026-07-12). Master kill switch for the AvaDial
  // SMS surfaces in the app: the "Make AvaTOK your messages app" onboarding banner,
  // the Messages tab conversation list + composer, and the AI Inbox/Spam filter over
  // carrier SMS. Requires ROLE_SMS at runtime (independent of ROLE_DIALER). Default
  // OFF — while false the Messages tab keeps its Phase-1 placeholder, NO SMS role is
  // ever requested, and the native SMS receivers/send service stay inert (they only
  // ever fire once the user grants the default-SMS role, which we never request unless
  // this flag is on). Flip `avaSms: true` in KV `platform_config` (staging first)
  // after the SMS role qualification + device test matrix passes and the Play Store
  // default-SMS-handler declaration is approved. Client mirror: RemoteConfig.avaSms.
  avaSms: boolean;
  // [DEFAULT-APPS-REPROMPT-1] (owner request 2026-07-15) One-time re-prompt that
  // sends EXISTING users who never took the onboarding "make AvaTOK your phone"
  // step to Settings → "Default phone & messages" on their next app open. Shows
  // AT MOST ONCE per account, ever (a persistent account-scoped key on device
  // records it), and never at all for users who already hold the roles.
  //
  // This is a kill switch on an INTERRUPTION, which is exactly the kind of thing
  // that needs one: on 2026-07-14 the owner had the old setup sheet stopped from
  // auto-popping because it nagged. If this one misbehaves, flip it false and it
  // is gone without a build. Default ON — it's the point of the feature.
  // Client mirror: RemoteConfig.defaultAppsReprompt.
  defaultAppsReprompt: boolean;
  // AvaDial contact-book backup/restore (owner request 2026-07-13; scaled 2026-07-14).
  // `contactsBookEnabled` is the master kill switch for /api/contacts/book* — when
  // false every route 503s (panic off). Default ON (the feature is live + free).
  // `contactsBookPaged` gates the paginated GET + background R2 chunking job; when
  // false the endpoint still serves the full book in one response (older behaviour)
  // and no chunks are built. Client mirror: RemoteConfig honours pagination purely
  // from the response shape, so these flags are server-authoritative.
  contactsBookEnabled: boolean;
  contactsBookPaged: boolean;
  // [AVADIAL-BACKUP-DAILY] Kill switch for the CLIENT's ~24h WorkManager
  // background backup (app/lib/features/avadial/contacts_daily_backup.dart). The
  // job re-reads this flag on every wake and does nothing when it's false, so a
  // misbehaving daily lane (e.g. an upload storm from a bad build) can be stopped
  // for the entire install base from KV WITHOUT shipping an APK — which matters
  // precisely because these clients are un-updatable in the moment. Distinct from
  // contactsBookEnabled, which 503s the ROUTES (and would take manual backup and
  // restore down with them). Default ON: the whole point is that a user who never
  // opens AvaTOK is still covered.
  contactsDailyBackup: boolean;
  // §11/§15 money + timing constants — flag-overridable via KV so a value tweak
  // never needs a redeploy. These are VALUES, not design; see plan §11.
  minServiceRate: number;          // MIN_SERVICE_RATE — floor for a caller-paid rate/min (owner proposed 20)
  agentRateAPerMin: number;        // Mode A callee-pays agent rate, tokens/min (6)
  platformFeePerMin: number;       // Mode B platform fee taken from the caller, tokens/min (10)
  serviceLineFeePerMin: number;    // service-number "extra line" fee, tokens/min, billed to the callee (3)
  agentMaxCallSec: number;         // AGENT_MAX_CALL — hard cap on an agent call, seconds (300 = 5 min)
  ringTimeoutSec: number;          // RING_TIMEOUT — no-answer window, seconds (30 ≈ 5 rings)
  agentAutoanswerSec: number;      // AGENT_AUTOANSWER — auto-handoff to agent, seconds (12 ≈ 2 rings)
  voicemailRecordSec: number;      // VOICEMAIL_RECORD — max voicemail length, seconds (25)
  escrowPromptTimeoutSec: number;  // ESCROW_PROMPT_TIMEOUT — price/length prompt abandon window, seconds (30)
  offlineDetectSec: number;        // OFFLINE_DETECT — no push-ack within this → skip ring, seconds (6)
  agentConcurrencyA: number;       // AGENT_CONCURRENCY_A — Mode A concurrent calls per primary number (1)
  agentConcurrencyB: number;       // AGENT_CONCURRENCY_B — Mode B concurrent escrowed sessions per service number (5)
  networkReconnectWindowSec: number; // NETWORK_RECONNECT_WINDOW — drop-past-this settles+refunds, seconds (20)
  conferenceBillingEnabled: boolean;     // Retired host/conference compatibility key; forced false. Participant usage uses a separate authority.
  conferenceVideoTokensPerHour: number;  // Legacy compatibility key; permanently forced to zero.
  /** [HUMAN-CALL-POOL-1] Explicit opt-in for the new pooled participant-minute
   * meter. Independent from the retired paidCalls/conferenceBillingEnabled
   * keys, so existing call paths remain free and dark until staged. */
  humanCallParticipantBillingEnabled: boolean;

  // PSTN voicemail platform — Canonical Architecture v1.0 (Specs/PLAN-2026-07-16-
  // ava-receptionist-guardian-FINAL.md, "Rollout inversion": V1 SHIPS VOICEMAIL FOR
  // EVERYONE; the AI pipeline is merged but DARK — no engine code exists yet).
  // `pstnVoicemail` is the master switch for worker/src/routes/pstn.ts's whole
  // Vobiz webhook surface (answer/hangup/record-cb/expect). While FALSE the
  // routes still run in PURE PROBE MODE (capture-only + orphan voicemail — this
  // doubles as the Phase-0 Vobiz wiring probe and is safe dark because the routes
  // are unreachable unless Vobiz itself calls them). Flip ON in KV (staging
  // first) once the carrier-forwarding matrix (plan Phase 0) passes.
  pstnVoicemail: boolean;
  // Max voicemail recording length in seconds for the PSTN (Vobiz) leg — separate
  // numeric flag from the existing in-app `voicemailRecordSec` (voicemail_room.ts)
  // even though the default matches, because the two record windows are enforced
  // by different systems (Vobiz's <Record maxLength=…> XML attribute vs our own
  // DO timer) and may need to diverge for carrier/cost reasons. Numeric — remember
  // the numericKeys entry below.
  pstnVoicemailRecordSec: number;
  // [AVA-VM-PAID-1] (owner decision 2026-07-17) Each forwarded condition costs us
  // ~55 paisa per call, so only "phone off / unreachable" (cfnrc) is FREE. The
  // "missed calls" (cfnry) and "declined / busy" (cfb) conditions are a PAID
  // upgrade: the client renders those two rows greyed with a green PAID pill and
  // no "Turn on" button, and one-time-cancels them at the carrier for anyone who
  // already had them on (they shipped free-and-default-ON before this date).
  //
  // TRUE unlocks both conditions for EVERYONE — this is the switch to flip when
  // the paid tier ships (or to un-break a mistake), NOT a per-user entitlement.
  // Per-user billing is a separate lane; until it exists, leave this FALSE.
  pstnPaidConditionsUnlocked: boolean;
  // [AVA-PSTN-AGENT-1] (Specs/PLAN-2026-07-19-vobiz-media-stream-agent.md)
  // Live Gemini agent on CELL (Vobiz DID) calls via bidirectional media
  // streams. When TRUE, routes/pstn.ts's answer webhook routes calls for
  // owners with receptionist mode="agent" (and ≥3 tokens runway) to a
  // <Stream> WebSocket → do/vobiz_agent_room.ts instead of the voicemail XML.
  // FALSE (dark) = the voicemail lane is byte-identical to before. This is
  // ALSO the kill switch: flip off and the very next call gets voicemail.
  pstnAgentEnabled: boolean;
  // [AVA-VM-SELFREC-1] (owner 2026-07-20) Self-record PSTN voicemail over a
  // Vobiz bidirectional <Stream> instead of the billed <Record> verb. When TRUE,
  // routes/pstn.ts's answer webhook ends the voicemail XML with a <Stream> →
  // do/voicemail_stream_room.ts (which captures the caller's audio, encodes MP3
  // to R2, and delivers the SAME InboxDO voicemail envelope) instead of
  // <Record>. FALSE (default/dark) = the voicemail lane is byte-identical to
  // before, still using Vobiz <Record>. This is ALSO the kill switch: flip off
  // and the very next call falls back to <Record>. Boolean → NOT in numericKeys.
  pstnVoicemailSelfRecord: boolean;
  // [TEL-TIERS-1] (Phase 4, Specs/PLAN-2026-07-19-tokens-cockpit-pstn-master.md)
  // PSTN channel-concurrency ENFORCEMENT. routes/pstn.ts always TRACKS per-owner
  // active-call gauges + monthly peaks (KV, best-effort); with this FALSE
  // (track-only, the launch state) a subscribed owner whose simultaneous calls
  // exceed channels_total still gets the call — we only emit pstn_channel_busy
  // telemetry. Flip TRUE only after real peak data validates the tier limits:
  // then the excess call gets the busy/voicemail fallback instead of admission.
  // Boolean → NOT in numericKeys.
  pstnConcurrencyEnforced: boolean;
  // [AVA-CONVO-BUDGET-1] (owner 2026-07-19) Receptionist conversation budget in ms,
  // decoupled from callMenuEnabled. The old coupling reverted Gemini to the 40/60/90s
  // VOICEMAIL caps when the menu was turned off — the 40s wrap cue landed mid-goodbye
  // and produced a double sign-off. Defaults are conversation-grade (wrap 120s, close
  // 160s, hard 180s); tune live from KV. All three MUST be in numericKeys.
  receptWrapCueMs: number;
  receptCloseMs: number;
  receptHardCapMs: number;
  // [PA-GATE-1] (Specs/SPEC-AVA-SPAM-SECRETARY-2026-08-09.md §3.4) PA stuck-session
  // watchdog, in ms. An INDEPENDENT DO alarm one minute past `receptHardCapMs`: if a
  // PA session is somehow still alive then (stuck timer, hung Gemini leg), it is
  // force-finalized, `pa_watchdog_fired` is emitted and the settle is trued up to the
  // hard cap — Ava must never sit engaged and billing for no reason. Failsafe, not a
  // normal path: its presence in telemetry is a bug signal. NUMERIC → it MUST also
  // appear in `numericKeys` below or `flags.sh set paWatchdogMs=420000` 400s
  // `bad type` (fake-flag rule, CLAUDE.md).
  paWatchdogMs: number;
  // [PA-GATE-1] (spec §4) Zero-balance backstop on the PSTN answer webhook. The app
  // dials the carrier MMI deactivation codes at zero balance, but only the phone can
  // truly disable forwarding — so a stray forwarded call can still reach us. When
  // TRUE, routes/pstn.ts's answer webhook returns an immediate `<Response><Hangup/>`
  // for an owner whose SPENDABLE balance (paid + free daily, per
  // [RECEPT-AVAIL-SPENDABLE-1]) is exactly zero: AvaTOK steps out entirely, so a
  // decline is a normal decline and the call costs nothing. Low-but-nonzero balances
  // are UNCHANGED — they still fall through to the voicemail lane. Ships FALSE: a
  // hangup is user-visible behaviour and must not turn itself on by accident.
  // Boolean → NOT in numericKeys.
  paZeroBalanceHangup: boolean;
  // [RECEPT-BILLING-3] Phase 1 billing v2 (Specs/PLAN-2026-07-19-tokens-cockpit-pstn-master.md):
  // USD→INR conversion for the INTERNAL per-call cost ledger
  // (call_cost_ledger.actual_api_cost_inr, written by ReceptionRoom.finalize), and
  // the real-cost-per-minute margin alert threshold in PAISE (₹2.20/min default —
  // above it finalize emits ava_recept_margin_alert). Both numeric — they MUST
  // also be in the numericKeys set below.
  usdInrRate: number;
  receptMarginAlertPaise: number;
  // Creator marketplace master switch for /api/marketplace/*. worker/src/routes/
  // marketplace.ts has claimed since day one that "everything here is dark until the
  // marketplaceEnabled kill switch is on" — but the key was never declared, so
  // putConfig rejected it (`unknown key`, 400) and the routes in fact had NO master
  // switch at all. Declaring it makes the documented brake real (same shape of bug as
  // inAppUpdateEnabled, found 2026-07-15). Default OFF per FREE LAUNCH (marketplace
  // hidden); flip ON in KV (staging first) when the marketplace goes public.
  marketplaceEnabled: boolean;
  // Independent server-side brakes. UI visibility is never a rollback or
  // authorization mechanism; stop new writes while existing content stays readable.
  marketplacePublishEnabled: boolean;
  marketplaceNegotiationEnabled: boolean;
  // Independent rollback gate for the V2 Messenger result/audio delivery
  // contract. UI visibility and negotiation admission must not be its brake.
  marketplaceDealDeliveryV2: boolean;
  // Master kill switch for /api/olx/*. Until now olx.ts was LIVE in production gated
  // by nothing — no flag anywhere. Default OFF so the routes ship dark and can be
  // turned on deliberately in KV (staging first). Read side lives in routes/olx.ts.
  olxEnabled: boolean;
  // [MKT2] AI-chat listing creation — the compose state machine that replaces the
  // 6-step SellListingFlow form (PLAN-2026-07-17 §3). Gates /api/marketplace/compose/*.
  // Default OFF: this is an LLM that talks to sellers and writes public listing text,
  // so it ships dark and is flipped on staging first. Independent of marketplaceEnabled
  // on purpose — compose can be dark while the marketplace itself is live, and the form
  // remains the escape hatch (M-D7) until the compose_started→listing_published funnel
  // proves out (§7.4).
  aiComposeEnabled: boolean;
  // [MKT6] Compose brain enrichment (PLAN §6.1). When ON, the compose greeting is
  // pre-filled from the seller's OWN listing history + a minimal-domain brainRecall
  // (domains:['listings'], k<=5). Default OFF, and it is only ONE of FOUR gates: (1) this
  // flag, (2) the user's `listings` brain consent, (3) One Brain B4 shipped (brainRecall
  // exists), (4) domains:['listings'] filtering. Failing any → the AI just asks. Separate
  // from aiComposeEnabled ON PURPOSE: turning compose on must NOT silently turn on
  // account-history recall. Read side is worker/src/lib/listing_enrichment.ts.
  listingBrainEnrichmentEnabled: boolean;
  // [MKT5] Per-listing billing (PLAN §5, M-D2: 5 free listings, then 100 tokens = $1
  // per listing per 30 days). Default OFF: while off, every publish is granted 'free'
  // and the entitlement row is still written so the quota count is accurate the moment
  // this flips on. NOTE betaFreePremium independently zeroes chargeFeature, so even with
  // this ON beta users are not debited — the machinery lands dark twice over. Read side
  // is worker/src/lib/listing_billing.ts.
  listingFeeEnabled: boolean;

  // --- outbound campaigns ---
  // Outbound AI Calling Campaigns (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §18).
  // Master kill switch + per-capability flags/limits, all declared here per the
  // fake-flag rule so every one is actually flippable via KV (never code).
  campaignsEnabled: boolean;              // master switch for the whole campaigns feature
  campaignDialerEnabled: boolean;         // outbound dialer path (provider client + scheduling)
  campaignOwnerAllowlist: boolean;        // restrict campaign creation to an owner allowlist
  campaignMachineDetection: boolean;      // AMD advisory + Gemini self-detect (default ON)
  campaignGoogleSheets: boolean;          // Google Sheets contact ingestion source
  campaignKbEnabled: boolean;             // per-campaign knowledge-base store/attach
  campaignToolsEnabled: boolean;          // ToolRuntime (generic tool-calling during a call)
  campaignBookingEnabled: boolean;        // calendar booking tool
  campaignHandoverEnabled: boolean;       // AI-to-human handover FSM
  campaignMaxContacts: number;            // ingestion cap per campaign (2000)
  campaignCallMaxMin: number;             // hard cap on a single AI call, minutes (10)
  campaignWrapCueMin: number;             // wrap-up cue before the call cap, minutes (8)
  campaignTokensPerMin: number;           // Token cost, tokens/min (6)
  campaignDidMonthlyTokens: number;       // per-DID monthly token allotment (700)
  campaignKbMaxFiles: number;             // per-campaign KB file cap (10)
  campaignToolBudget: number;             // ToolRuntime call budget per session (6)
  campaignHandoverRingSec: number;        // handover ring window, seconds (25)
  campaignHandoverTokensPerMin: number;   // handover tariff, tokens/min (3, was 2 — bumped 2026-07-20)
  campaignHandoverTopupMin: number;       // handover rolling-reservation top-up window, minutes (10)

  // Dynamic Workers (Specs/PROPOSAL-DYNAMIC-WORKERS-2026-07-28.md, [DYNW-CORE-1]).
  // Master kill switch + one flag per workstream, all declared per the fake-flag
  // rule. NO dynMessagingEnabled by owner decision: ordinary messaging (InboxDO/
  // PartyDO hot paths) is explicitly out of scope for dynamic code.
  dynamicWorkersEnabled: boolean;         // master switch — lib/dynw/host.ts refuses to run anything while false
  dynCodeModeEnabled: boolean;            // WS-1: Code Mode for AvaApps/Ava tool loops
  dynAvaBrainContextEnabled: boolean;     // WS-1: read-only consent-scoped DynBrain capability
  dynReceptionistRulesEnabled: boolean;   // WS-2: per-owner receptionist/delegate rule scripts
  dynMarketplaceFlowsEnabled: boolean;    // WS-4: seller policy scripts + tenant automations
  dynCallRoutingEnabled: boolean;         // WS-9: DID/PSTN call-routing scripts (evaluate-only for now)
  dynCreatorAgentToolsEnabled: boolean;   // WS-8: creator agent skills via ToolRuntime
  dynModuleMaxBytes: number;              // registry cap on bundled module source (131072)

  // [DYNW-FLOWS-1] WS-3: DARK PARALLEL Cloudflare Workflow port of the account-
  // deletion cascade (worker/src/workflows/deletion.ts). The account-deletions
  // QUEUE + 6-hourly cron backstop stay the LIVE path regardless of this flag —
  // flipping it on only changes where NEW deletion requests are enqueued (see
  // routes/account.ts). Boolean → NOT in numericKeys.
  deletionWorkflowEnabled: boolean;

  // ---------------------------------------------------------------------------
  // [AVA-CFG-CACHE-1 2026-08-07] Ava V2 workstream flags. Every key below is
  // declared HERE and in `DEFAULTS`, in the same change (fake-flag rule); the
  // numeric ones also have a `numericKeys` entry in `putConfig`. Verified with
  // `scripts/flags.sh set <key>=…` — a key missing from either place 400s
  // (`unknown key` / `bad type`) and can never actually be flipped.
  // ⚠️ config.ts accepts ONLY `number` and `boolean`. There is no string type,
  // which is why the two enum-ish keys below are numbers with documented values.
  // ---------------------------------------------------------------------------

  // WS-5. Kill switch for streaming the plain Ava lane. Until now the only brake
  // was the `AVA_STREAM_OFF` env var, which needs a redeploy to pull; this makes
  // it a live flag. Default TRUE = streaming on. Boolean → NOT in numericKeys.
  avaStreamPlainEnabled: boolean;
  // WS-7. Kill switch for the direct-to-image fast path (skip the LLM round trip
  // when the prompt is unambiguously an image request). Default TRUE; flip FALSE
  // if the intent regex misfires and starts drawing pictures of plain questions.
  avaImageFastPathEnabled: boolean;
  // WS-12. Intent gate that skips the memory/recall fetch when the turn plainly
  // does not need it. SHIPS DARK — a wrong skip silently loses context.
  avaMemoryIntentGateEnabled: boolean;
  // WS-10. Two-tier image generation (cheap preview, paid full-res upgrade).
  // SHIPS DARK until the tiering is verified end to end on a device.
  avaImageTwoTierEnabled: boolean;
  // WS-17. Per-thread Ava toggle in 1:1 DMs. SHIPS DARK.
  avaDmToggleEnabled: boolean;
  // WS-17. The default state of that per-thread toggle for threads that have
  // never been set. Owner wants this ON eventually, but it ships FALSE and gets
  // flipped deliberately — turning Ava on inside every existing DM by default is
  // not something a code default should do on its own.
  avaDmDefaultOn: boolean;
  // WS-18b. The AI ambient lane (Ava reacting to group activity unprompted).
  // SHIPS DARK — needs WS-1, WS-15 and WS-17 first, plus an owner decision.
  // [AVA-AMBIENT-2 2026-08-14] Owner decision made (cloud gatekeeper, companion
  // default): this flag now gates lib/ava_ambient.ts + AvaAgentDO /ambient —
  // the DM companion lane. It is THE kill switch for unprompted AI posts.
  avaAmbientAiEnabled: boolean;
  // [AVA-AMBIENT-2] Minimum seconds between Ava's unprompted posts in ONE
  // conversation (ledger in the conv's AvaAgentDO SQLite; DM lane).
  avaAmbientCooldownS: number;
  // [AVA-AMBIENT-2] Max unprompted Ava posts per conversation per UTC day.
  avaAmbientDailyCapPerConv: number;
  // [AVA-AMBIENT-1 2026-08-17] "Ambient Ava" — Ava drops emoji reactions on
  // members' messages and occasionally leaves a short supportive/funny comment
  // in ANY chat (owner decision 2026-08-17: expressive by default). DISTINCT
  // from `avaAmbientAiEnabled` above, which gates the still-dark WS-18b
  // DM-companion gatekeeper lane; THIS key gates lib/ava_ambient.ts (tapped
  // from sendMsg). Default TRUE — this IS the kill switch. Boolean → NOT in
  // numericKeys.
  avaAmbientEnabled: boolean;
  // [AVA-AMBIENT-1] Max ambient COMMENTS per conversation per rolling hour.
  // (Reactions are capped separately in code at ~1 per 3 messages; comments
  // additionally need ≥10 member messages since the last one.) NUMERIC → it
  // MUST also appear in `numericKeys` below or
  // `flags.sh set avaAmbientCommentsPerHour=2` 400s `bad type`.
  avaAmbientCommentsPerHour: number;
  // WS-19d. Flat per-action pricing (imageCostTokens / searchCostTokens / …)
  // instead of the live metered per-token billing. SHIPS DARK and MUST NOT be
  // switched on by a default change: flipping it REPLACES the billing path that
  // is currently charging real users.
  avaFlatPricingEnabled: boolean;
  // WS-19. On-device message-search tool exposed to Ava. SHIPS DARK.
  avaMessageSearchEnabled: boolean;

  // WS-14. Ava's default voice style. NUMERIC ENUM because config.ts cannot hold
  // a string (`putConfig` accepts only number|boolean), so this mirrors
  // `TemplateLang` in lib/ava_templates.ts as an integer:
  //     0 = "en"        plain English
  //     1 = "hi"        Hindi
  //     2 = "hinglish"  Hinglish Gen-Z   ← default (owner decision 2026-08-07)
  // ⚠️ Do not "tidy" this into a bare number: an undocumented magic value here is
  // a trap. NUMERIC → it MUST also appear in `numericKeys` in putConfig.
  avaVoiceStyleDefault: number;
  // WS-10. Resolution tier for the cheap PREVIEW image. NUMERIC ENUM:
  //     0 = 512px   1 = 1K   2 = 2K
  // Numeric → also in numericKeys.
  imagePreviewResolutionTier: number;
  // WS-10. Resolution tier for the paid FULL image. Same enum as
  // `imagePreviewResolutionTier` (0 = 512px, 1 = 1K, 2 = 2K). Numeric →
  // also in numericKeys.
  imageFullResolutionTier: number;
  // WS-19d flat-pricing tariffs, in TOKENS (1 token = ₹1). Only consulted when
  // `avaFlatPricingEnabled` is true. All numeric → all in numericKeys.
  imageCostTokens: number;            // preview image (owner decision: 1 token)
  image2kUpgradeCostTokens: number;   // 2K upgrade   (owner decision: 4 tokens)
  searchCostTokens: number;           // one web/brain search action
  // Forward declaration: music generation has NO code path yet. The key exists so
  // the tariff is set before the feature lands, not after it starts billing.
  musicCostPerMinuteTokens: number;

  // [VENICE-IMG-1 2026-08-14] Venice AI media kill switch — Specs/VENICE-AI-MEDIA-PLAN-2026-08-14.md.
  // Ships DARK (default false): generateImage() keeps using the existing OpenRouter
  // path until this is explicitly flipped true in KV. Boolean → NOT in numericKeys.
  veniceMediaEnabled: boolean;
  // Venice tariffs in TOKENS (1 token = ₹1), read only when veniceMediaEnabled is
  // true. All numeric → all in numericKeys.
  veniceImageTokens: number;
  veniceMusicTokens: number;
  veniceVideoTokens: number;
  // [VENICE-CHAT-1 2026-08-14] Uncensored-TEXT chat lane kill switch. Ships
  // DARK (default false): even when a caller's veniceTier(env, uid)
  // (lib/venice_tier.ts) resolves to "paid" (18+ opt-in AND paid balance > 0),
  // the plain @ava chat lane keeps using the Gemma/Gemini ladder until this
  // is explicitly flipped true in KV. Boolean → NOT in numericKeys.
  veniceUncensoredChatEnabled: boolean;

  // [SONG-LEN-2 2026-08-17] Venice music model for LONG song requests
  // (> 90 seconds). MiniMax Music 2.6 rejects lyrics_prompt >= 1000 chars
  // (verified live 2026-08-16: "lyrics_prompt must be less than 1000
  // characters"), which physically caps it at roughly a 60-90 second vocal.
  // When this is set to a duration-capable Venice model ("ace-step-15" or
  // "elevenlabs-music" — the only two lib/venice.ts sends duration_seconds
  // to), longer requests route there with full lyrics. Empty string = off:
  // long requests stay on MiniMax with lyrics trimmed to fit. String key.
  veniceLongMusicModel: string;

  // [SONG-QUICK-1 2026-08-17] Venice music model for the QUICK SONG mode, where
  // the ENGINE writes and sings its own words from a descriptive brief (no lyric
  // draft, no approval step). This deliberately prefers a model that does NOT
  // take a lyrics_prompt: elevenlabs-music returns a live 400 ("This model does
  // not support lyrics", verified 2026-08-17) yet sings words it invents from
  // the prompt — exactly this mode. Empty string = fall back to the default
  // per-generation music model. STRING key → NOT in numericKeys.
  veniceQuickSongModel: string;

  // [AVA-GROUP-SESSION-1 2026-08-16] Shared group media sessions: while a
  // public (#ava) song/video conversation is active in a GROUP thread, other
  // members' public #ava turns join the initiator's conversation (initiator's
  // AvaAgentDO + wallet) instead of spawning their own parallel Ava. Only the
  // initiator can approve the paid generate step (owner decision 2026-08-16).
  // Kill switch — boolean → NOT in numericKeys.
  groupSharedMediaSessionEnabled: boolean;
}

// FREE LAUNCH (2026-06-28, owner-locked Specs/FREE-LAUNCH-DIRECTION.md): ship an
// all-free, focused comms product. Core ON: messaging, 1:1 calls, group AUDIO,
// free number/dialpad, AI receptionist, basic Ava chat, Guardian. Everything
// else (paid/marketplace/agent-builders/premium-AI) is OFF and hidden in the
// client. All paywalls off (betaFreePremium ON / billingEnabled OFF). Fully
// reversible — flip these back in KV `platform_config`, no redeploy.
const DEFAULTS: PlatformConfig = {
  walletRealMoney: false, // money-in stays OFF pending legal (§10.1)
  donationsEnabled: true,
  liveEnabled: false,              // FREE LAUNCH: marketplace/AvaLive hidden
  consultEnabled: false,           // FREE LAUNCH: paid consulting hidden
  commercialLiveListingsEnabled: false,
  commercialLiveCheckoutEnabled: false,
  commercialLiveJoinEnabled: false,
  commercialConsultListingsEnabled: false,
  commercialConsultCheckoutEnabled: false,
  commercialConsultJoinEnabled: false,
  commercialCreatorFeePct: 80,
  commercialSettlementHoldHours: 24,
  commercialConsultJoinEarlyMin: 10,
  commercialConsultJoinLateMin: 2,
  // Paid consultation extensions stay dark until an owner-configured duration
  // and token/minute rate are present. Zero is intentionally fail-closed.
  commercialConsultExtensionEnabled: false,
  commercialConsultExtensionMinutes: 0,
  commercialConsultExtensionRate: 0,
  commercialLiveBackstageEarlyMin: 30,
  commercialLiveStartGraceMin: 15,
  commercialReplayEnabled: false,
  commercialRecordingEnabled: false,
  messengerCallingEnabled: false,  // [PIVOT-MSGR-CALL-OFF-1] Messenger 1:1 A/V is killed by the marketplace-first pivot. NOT streamCallsEnabled — see the interface comment.
  conferenceEnabled: true,         // group AUDIO calls (master kill switch)
  groupAudioSfuEnabled: false,     // CF Realtime SFU group path — dormant until built+CI-verified
  brainEnabled: false,             // FREE LAUNCH: secondary — revisit later
  cloudReasoningOverPrivate: true, // One Brain B4/B-D6: allow device-private recall snippets in cloud reasoning (our-keys, no-retention transport). Flip false in KV to force local-only handling of private hits.
  verseEnabled: false,             // FREE LAUNCH: creator dashboard hidden
  syncSkipEnabled: true,           // [AVA-SYNC-SKIP] skip empty reconnect/resume catch-ups when the client cursor is already at head; flip false to force full syncs

  identityLadderEnabled: true,
  guestTierEnabled: true,
  workersAiLivenessEnabled: true,  // ON 2026-07-03: Cloudflare-native liveness (no AWS/Rekognition creds); powers the signup human-check
  // [M-D1 2026-07-17 / M-D11 2026-07-18] simOnlyPhoneEnabled removed from DEFAULTS —
  // phone OTP is gone app-wide; the flag gated an unrouted, 410'd endpoint.
  translationEnabled: false,       // FREE LAUNCH: Gemini-Live cost — hidden
  // [CALL-SFU-1] Dark until CI + a two-device staging test that includes a
  // WiFi->mobile switch mid-call. P2P remains in the build as the fallback, so
  // flipping this back to false is a full, instant rollback with no rebuild.
  callSfuV1: false,
  callSfuAudioOnly: false,         // [CALL-SFU-1] owner 2026-08-06: video on the SFU too
  // [CALL-PREWARM-1 2026-08-16] Instant-pickup plan P1/P2. The client seam is
  // implemented and must be the default for new environments. Existing
  // production overrides remain authoritative, so rollout/rollback is still
  // controlled through the normal config layer rather than a client rebuild.
  callPrewarmOnRingV1: true,
  callerPrejoinOnRingV1: true,
  // [CALL-PREROLL-RETIRE-1] Retired. New clients hard-disable pre-Accept
  // media acquisition; retain the false key only so older builds stay dark.
  callPrerollV1: false,
  callSilentTransportPrewarmV1: true,
  callSilentPrewarmDeadlineMs: 12_000,
  // [CALL-RTK-2 2026-08-08] RealtimeKit migration, Phase 0. Both ship FALSE:
  // the worker route exists and the secrets may be set, but no user reaches it
  // until a client build implements the seam and a two-phone test passes.
  callRealtimeKitV1: false,
  groupRealtimeKitV1: false,
  callRtkJoinDeadlineSec: 10,      // numeric → numericKeys. Abort-to-legacy deadline.
  callSetupParallelBootV1: true,   // [CALL-DEADAIR-1] concurrent setup prologue + peer poll
  callFirstAudioProbeV1: true,     // [CALL-DEADAIR-1] 200ms first-audio probe -> call_first_audio_ms
  avaVoicemailFallbackV1: true,    // [AVA-VM-FALLBACK-1] Ava timeout degrades to a plain recorder, never ends the call
  // [CALL-AUDIO-OWNER-1] Already-shipped client behaviour, declared here so the
  // key exists and can be flipped. TRUE = today's behaviour; false restores the
  // pre-[CALL-AUDIO-OWNER-1] multi-owner audio session without a rebuild.
  callAudioOwnerV1: true,
  // [CALL-AUDIBLE-1] OFF: no client build wires `audibleReady` into the UI
  // yet. Flip true once that build ships to start showing "Connecting
  // audio…" until real inbound audio is confirmed; false is an instant,
  // no-rebuild rollback to today's (early) "Connected" label.
  callAudibleStateV1: false,
  streamCallPilotEnabled: false,
  streamCallPilotPercent: 0,
  streamCallsEnabled: false,   // kill switch for the new streamlane client lane (distinct from streamCallPilotEnabled)
  // [MESSENGER-CALL-BILLING-FOUNDATION] Safe defaults: new billing is dark,
  // audio has four wall-clock hours of daily allowance for two participants,
  // and all paid SKUs remain unavailable until rates are supplied remotely.
  messengerCallBillingEnabled: false,
  messengerAudioFreeParticipantSecondsDaily: 28_800,
  messengerAudioPaidCentitokensPerParticipantMinute: 0,
  messengerVideoSdCentitokensPerParticipantMinute: 0,
  messengerVideoHdCentitokensPerParticipantMinute: 0,
  messengerVideo2kCentitokensPerParticipantMinute: 0,
  messengerVideo4kCentitokensPerParticipantMinute: 0,
  messengerCallReservationWallSeconds: 300,
  messengerCallLowBalanceWarningWallSeconds: 300,
  messengerCallUsageTickSeconds: 15,
  messengerCallPriceVersion: 1,
  // [STREAM-GATE-1 2026-08-21] 0 = gate DISABLED. Ships inert on purpose: arming
  // it before the cutover build is on people's phones would refuse every call in
  // the fleet. Flip to the cutover build number once that build is published.
  callMinBuild: 0,
  // [CALL-RING-FASTPATH-1] ON: only admission → glare → participants → ring stay
  // on the pre-ring await chain. Flip false in KV to restore the old fully-serial
  // order (3.6-4.8s to call_ws_ring_sent) with no rebuild.
  callRingFastPath: true,
  // [CALL-PRESENCE-1] ON: read the callee's heartbeat before the DO round-trips
  // and send a provably-offline, zero-token callee straight to Ava instead of
  // making the caller wait out a 20s ring nobody can hear. Fails open to a normal
  // ring whenever presence is unknown.
  callPresenceRouting: true,
  presenceFreshSec: 90,            // numeric → numericKeys. ~3.6 missed 25s beats.
  presenceHeartbeatSec: 25,        // numeric → numericKeys. Rides the existing SyncHub ping tick.
  // [CALL-PRESENCE-2] The owner's rule: silent for this long = the phone is OFF,
  // and the caller goes STRAIGHT to Ava instead of hearing ring cycles. 300s = 12
  // consecutive missed 25s beats. numeric → numericKeys. 0 disables the age arm.
  presenceOfflineSec: 300,
  callRealRingCount: true,         // [CALL-4RINGS-1] count real rings; false = today's 20s wall clock
  ringCycleMs: 6000,               // numeric → numericKeys. Assumed length of one ring cycle.
  // [CALLREC-SERVER-1] On-demand call recording. Ships OFF — the Android capture
  // layer is unproven and /api/callrec/* 403s while this is false. The indicator
  // (the peer's only warning that recording started) defaults ON.
  callRecordingEnabled: false,
  callRecordingIndicatorEnabled: true,
  callRecordingMinFreeMb: 500,     // device free-space floor before arming (numeric → numericKeys)
  // [ADDCALL-1-SRV] "Add to call" master kill switch. Ships OFF — /api/adhoc-room/*
  // 403s and the client tile stays hidden until the Phase 2 migration lands and is
  // device-verified. Flip true in KV to open it, no rebuild.
  addToCallEnabled: false,
  callTranslationEnabled: false,   // [CALL-TRANSLATE-1] dark until CI + two-device verification
  // [CALL-TRANSLATE-FREE-1] ON per owner 2026-08-05, reversing the 2026-08-04
  // paid-only ruling: testers hold only welcome/daily grants, so paid-only made
  // the feature untestable. Gate and per-minute charge both read this one flag.
  callTranslationAllowFreeTokens: true,
  // [CALL-TRANSLATE-2D-3] Abuse ceilings, not product limits. Sized off worst-case
  // legitimate behaviour with ~2x headroom: back-to-back short calls ≈30 starts/h,
  // 2–3 language-sheet opens per call ≈60 warm-ups/h, ≈15 switches/h × 3 requests
  // each ≈45 /language calls. None of these three spend money — the paid boundary
  // is /activate — so the cost they bound is provider token mints + D1 rows.
  callTranslationStartsPerHour: 60,
  callTranslationWarmupsPerHour: 120,
  callTranslationSwitchesPerHour: 200,
  translationGroupEnabled: false,  // FREE LAUNCH: hidden
  avavoiceEnabled: false,          // FREE LAUNCH: agent builder hidden
  avavisionEnabled: false,         // FREE LAUNCH: agent builder hidden
  aiVoiceCallEnabled: false,       // [AI-FLAG-CONTRACT-1] hands-free Ava voice call — was a fake flag; declared now, still dark until explicitly flipped
  receptionistEnabled: true,       // FREE LAUNCH: AI receptionist ON (Gemini Live)
  unknownAvatokCallerReceptionistEnabled: false, // [CALL-UNKNOWN-GATE-1] normal authenticated AvaTOK calls ring unless this policy is explicitly enabled
  avatokVoicemailFree: true,       // [AVACALL-VMFREE-1] FREE AvaTOK↔AvaTOK auto-voicemail ON. Kill switch — flip false in KV to end no-answer AvaTOK audio calls silently again. NOT gated by the paid voicemailBot.
  voicemailEnabled: true,          // [VM-KILL-1] GLOBAL voicemail master switch. Default true = no change. Flip false in prod KV to disable ALL voicemail lanes at once (reversible).
  instantCallMountEnabled: true,   // [INSTANT-CALL-MOUNT-1] instant 1:1 call screen; POST /api/call runs in background. Kill switch (flip false to restore awaited path)
  receptionistRings: 4,            // [ONE-FLOW-1] owner 2026-07-09: 4 rings (20s) GLOBAL — one flow for everyone; KV can override
  receptionistUseCf: false,        // engine switch: false = Gemini Live (default), true = Cloudflare Workers AI engine
  receptionistVmMode: false,       // zero-cost voicemail: cached Bulbul greeting + beep + 30s record (overrides engines while ON)
  avaCountdownEnabled: true,       // client 3-2-1 Ava countdown; prod KV flips false (VM greeting is instant)
  receptBillingLive: false,        // [RECEPT-BILLING-LIVE-1] real receptionist token deduction during beta (test switch)
  receptionistLibraryEnabled: true, // [RECEPT-LIB-1] voicemail → user_media row → AvaLibrary "Ava Receptionist" folder. Kill switch only; flipping false stops NEW rows, never deletes or breaks playback.
  voicemailPrivateBucket: true,    // [RECEPT-PRIVBUCKET-1] store new voicemail/receptionist recordings in the PRIVATE DIGITAL bucket, not the public blossom one. Reads try both, so this never breaks playback.
  // [AVABRAIN-FLAGS-1] AvaBrain program — all dark/conservative by default; prod KV flips deliberately.
  avaBrainVoiceBillingEnabled: false, // personal Live-voice lease/settle path (ava_receptionist_minute tariff)
  avaBrainVoiceBillingLive: false,    // force-meter during betaFreePremium (mirrors receptBillingLive)
  mediaMemoryEnabled: false,          // daily-recording memory pipeline
  mediaMemoryMaxSec: 900,             // 15 min
  mediaMemoryMaxBytes: 25_165_824,    // 24MB — transcribeVoice hard Whisper ceiling
  mediaMemoryFrameBudget: 20,
  mediaMemoryDailyPerUser: 10,
  mediaMemoryConcurrency: 2,
  avaBrainExportDailyCap: 50,
  companionGroupCooldownSec: 300,
  companionGroupDailyBudget: 10,
  receptWrapCueMs: 120_000,        // [AVA-CONVO-BUDGET-1] wrap-up cue at 2:00 (was 40s when menu off → double sign-off)
  receptCloseMs: 160_000,          // graceful close by ~2:40
  receptHardCapMs: 180_000,        // stall backstop 3:00
  paWatchdogMs: 360_000,           // [PA-GATE-1] PA stuck-session watchdog — 1 min past a 5:00 hard cap
  paZeroBalanceHangup: false,      // [PA-GATE-1] immediate <Hangup/> for zero-spendable owners — ships dark
  usdInrRate: 96.4,                // [RECEPT-BILLING-3] USD→INR for the internal call_cost_ledger (tune from KV as FX moves)
  receptMarginAlertPaise: 220,     // [RECEPT-BILLING-3] alert when real API cost > ₹2.20/min (price is ₹3/min)
  receptTakeoverGuard: false,      // P1: gate Ava takeover on FCM ring-ack — ships dark, flip after device test
  avaPrewarmEnabled: true,         // [AVA-PREWARM-1] pre-warm the receptionist during the final rings — default ON

  avaAffiliateEnabled: false,      // launch gate — flip ON after A5 fraud checks
  affiliateJoinLinkEnabled: false, // generic signup links remain dark independently
  affiliateAssetKitEnabled: false, // v2 asset kit (Gemini) — defined, not built
  upiPayoutEnabled: false,
  affiliatePayoutAllowlistOnly: true,
  upiPayoutMinCoins: 1000,
  upiPayoutReservationTtlHours: 72,
  upiVpaCooldownHours: 72,
  // [AFF-COMM-LIFECYCLE-1] §7 launch values. Nothing here is live while
  // avaAffiliateEnabled is false — the whole lifecycle is dark.
  affiliateQualifyDays: 30,
  affiliateMinQualifyingTopupCoins: 100,
  affiliateDailyEarnCapCoins: 2000,
  affiliateMonthlyEarnCapCoins: 20000,
  affiliatePerReferredCapCoins: 1000,
  // Ava in-chat AI defaults (proposal §7.1 anti-abuse tiering).
  aiEnabled: true,                 // basic free Ava chat ON
  aiWalletMeteringEnabled: false,  // [AI-BILLING-CORE-1] DARK — flip ON only after the owner reviews H4's route-by-route premium-gate audit; see interface comment above
  unrecoveredDailyCapMicroUsd: 50_000, // [AI-PRICE-CATALOG-1] $0.05/account/day unrecovered-cost ceiling before metered jobs block with AI_UNRECOVERED_LIMIT (§66)
  unrecoveredPlatformAlertMicroUsd: 1_000_000, // [AI-PRICE-CATALOG-1] $1/day platform-wide unrecovered-loss alert threshold (§66, gate finding B3)
  focusMode: true,
  webSearchEnabled: false,         // FREE LAUNCH: premium AI cost — hidden
  fileAnalysisEnabled: false,      // premium unlocks
  openChatUncapped: false,         // premium removes the cap
  dailyAvaTurnLimit: 200,          // [AVA-FREE-BUDGET-1] owner decision §10: free text is "free but generously rate-limited" — raised from 25; secondary anti-script limit, real cost bound is freeText* below
  // [AVA-FREE-BUDGET-1] §19b/§55: a turn cap does not cap cost — DeepSeek V4 Flash's
  // 1,048,576-token context means 200 capped turns of pasted documents could still
  // reach ~200M input tokens/day. These are the budgets that actually bound spend.
  freeTextMaxInputTokens: 32_000,
  freeTextDailyInputTokens: 2_000_000,
  freeTextDailyOutputTokens: 200_000,
  freeTextDailyCostMicroUsd: 50_000,   // $0.05/account/day INTERNAL platform-cost ceiling (generation + guardInput + isSafe + regenerate)
  aiContentModerationEnabled: false, // [AI-MOD-FLAG-1] ships dark — preserves the 2026-06-24 no-op decision until the owner flips it on
  guardianEnabled: true,           // safety shield — free, trust driver
  companionEnabled: true,          // basic free Ava chat
  generativeEnabled: false,        // FREE LAUNCH: premium image gen — hidden
  discussWithAvaEnabled: true,     // [PIVOT-AI-SWITCHES-1] matches today's compile-const behaviour; the pivot flips it in KV
  askAvaEnabled: true,             // [PIVOT-AI-SWITCHES-1] behaviour-neutral today (shellV2 is false); MUST be flipped false before shellV2 goes true
  imageDailyCap: 100,              // fair-use backstop per user/day — applies even to "unlimited" packages
  aiMediaJobsEnabled: false,       // five media handlers are intentionally dark until individually production-ready
  voiceNoteEncryptionEnabled: false, // [AVA-MEDIA-JOB-2] MVP: voice notes are server-readable, not E2E (owner decision 2026-07-25)
  ringbackEnabled: true,           // AI ringback + busy tone (free, our AI key)
  callAudioControllerV2: false,    // call-reliability program — ships dark
  callPlayoutHealthV2: false,      // call-reliability program — ships dark
  callIceRecoveryV2: false,        // call-reliability program — ships dark
  callRelayMigrationV1: false,     // call-reliability program — ships dark
  callQosAdaptV1: false,
  callCellPresetV1: false,
  callQualityIndicatorV1: false,
  callAudioRedExperimentV1: false,
  callVideoDegradeV1: false,
  // [CALL-VIDEO-CODEC-1] AV1>VP9>VP8>H264 preference + temporal SVC (L1T3) on
  // the 1:1 video sender. Ships dark — see remote_config.dart for why.
  callVideoCodecPrefV1: false,
  // [CALL-VIDEO-RENDER-WATCH-1] ON by default: the heal only fires on the
  // exact stall it exists for (decode progressing + renderer holding a
  // different track, twice in a row), which healthy calls never produce.
  // Observed in prod 2026-08-08 (avatok-b403ba59): 30fps decoded for 9 min
  // while the screen showed one frozen frame.
  callVideoRenderHealV1: true,
  receptionistReconnectV1: false,  // call-reliability program — ships dark
  callRingAudibilityV1: false,     // call-reliability program — ships dark
  callRecoveryDeadlineSec: 12,     // [CALL-SURVIVE-1] per-attempt ICE-recovery deadline
  callMigrationDeadlineSec: 8,     // [CALL-SURVIVE-1] per-attempt relay-migration deadline
  callRecoveryMaxAttempts: 5,      // [CALL-SURVIVE-1] retry ladder length (2/4/8/16/30s backoff)
  callQosHeadroomFactor: 1.5,
  callQosLossDownshiftPct: 8,
  callQosStableLossPct: 1,
  callQosStableRttMs: 180,
  callQosStableSamples: 3,
  callVideoLossDegradePct: 8,
  callVideoLossPausePct: 20,
  callVideoStableSamples: 3,
  // [CALL-WS-AUTH-1] OFF = observe-only. Flip ONLY after a build carrying the
  // client `?t=` half is in the field, or every installed app loses calling.
  callRoomAuthEnforced: false,
  callNativeAnswerV1: true,        // [CALL-NATIVE-ANSWER-1] native ring + instant connecting continuity
  betaFreePremium: true,           // FREE LAUNCH: no paywalls — everyone premium, no metering
  billingEnabled: false,           // FREE LAUNCH: subscriptions/checkout off
  playTopupEnabled: true,          // AvaWallet Google Play top-up (gated also by Play service account)
  numberFeatureEnabled: true,      // AvaTOK Number — virtual number + handle retirement
  avatokVanityNumberTokens: 0,     // [PIVOT-PAID-NUMBER-1] 0 = paid vanity-number path DARK until priced
  avaCallsEnabled: false,
  avaCallsUniversalDialpadEnabled: false,
  avaCallsAvatokResolveEnabled: false,
  avaCallsPstnOutboundEnabled: false,
  avaCallsPstnTokensPerMinute: 0.5,
  avaCallsPstnMinRunwayMinutes: 1,
  virtualNumbersEnabled: false,
  virtualNumberDidPurchaseEnabled: false,
  virtualNumberFreeEnabled: false,
  virtualNumberFreeMaxPerAccount: 5,
  virtualNumberDidMonthlyTokens: 600,
  virtualNumberSmsEnabled: false,
  virtualNumberOtpEnabled: false,
  virtualNumberRecordingsEnabled: false,
  virtualNumberReceptionistEnabled: false,
  virtualNumberPrimaryProvider: "vobiz",
  virtualNumberFrejunEnabled: false,
  virtualNumberVobizEnabled: true,
  virtualNumberProviderFailoverEnabled: false,
  teamIvrEnabled: false,           // Team Receptionist (IVR) — OFF until dogfood passes (enable via KV)
  ivrAiFrontDesk: false,           // tap-menu is the default routing; AI front desk is a future upsell
  groupInvitesEnabled: false,      // pending-membership group invites — OFF until migration + test
  listingLivenessGate: true,       // ON 2026-07-03: mandatory liveness (once) to create/publish a listing
  livenessV2Enabled: false,        // Liveness V2 ML-Kit-gated flow — dark, flip ON once pass-rate proven
  livenessUseRekognition: false,   // Liveness V2 P3: optional AWS CompareFaces same-person (image API, NOT Face Liveness) — OFF; needs AWS creds
  livenessDeviceAuthoritative: false, // [LIVE-DEVAUTH-1] device-authoritative fast path — OFF (dark until device-signal trust is proven)
  livenessAuditSampleRate: 0.08,      // [LIVE-DEVAUTH-1] 8% of device-authoritative verifies also run full LLaVA for disagreement telemetry
  livenessV3Enabled: false,           // Liveness V3 voice-guided/Rekognition pipeline — DARK; extends V2, flip ON in KV once proven
  // [AVA-IDGATE-1] [CSAM-GATE-1 2026-07-11] Was DARK pending the identity_proofs
  // backfill migration (see Specs/IDGATE-WHAT-WE-DID-2026-07-10.md). The backfill
  // has since RUN (confirmed: 0 users left without a verification record; 1 real
  // Didit pass, 17 grandfathered, renewal dates spread days 36-88 — no gate cliff).
  // With this flag OFF, gatePublicAction() always short-circuits `on=false` and
  // returns null (allow) for EVERY action — including dm_stranger — so an
  // unverified first-time user's first message to a stranger was NEVER actually
  // gated server-side despite the gate code being correctly ordered before persist/
  // deliver in messaging.ts sendMsg/convCreate. That is the confirmed root cause of
  // the CSAM-risk hole (a first message to a stranger was delivered, unverified).
  // Flipping the DEFAULT here only changes behaviour where no KV override exists —
  // if `identityGatingEnabled` was ever explicitly set false in KV (scripts/
  // flags.sh), that override still wins and must be cleared/re-set by the owner
  // per the staging-then-prod protocol in CLAUDE.md. Test per the "what to test"
  // checklist in IDGATE-WHAT-WE-DID-2026-07-10.md before promoting to prod.
  identityGatingEnabled: true,
  livenessValidityDays: 90,           // owner decision 2026-07-10
  // [AVA-IDGATE-1] BUMPED v1→v2 when retention changed 584d → 256d. The version is
  // stored per-user, and hasCurrentConsent() only accepts the CURRENT one — so a
  // changed disclosure invalidates prior consent and the user is asked again. That is
  // the entire point of versioning it: nobody consented to a period they never saw.
  // Bump this string whenever the consent TEXT or the RETENTION PERIOD changes, and
  // update app/.../biometric_consent_screen.dart:_kRetentionDays + the published
  // schedule at /biometric-retention in the same commit. All three must agree.
  biometricConsentVersion: "2026-07-10-v2",
  // [LIVE-DIDIT-1] didit.me-hosted liveness (owner decision 2026-07-09). Default
  // ON — this IS the liveness path now; v2/v3 above are retired. The client
  // routes the human check to DiditLivenessScreen when this is true.
  diditLivenessEnabled: true,
  // [LIVE-DIDIT-5] When ON, only didit-provider liveness counts for L2 — users
  // verified by the retired v2/v3 pipelines are re-gated on next app open.
  // OWNER-CONTROLLED: flip in KV when ready to re-verify the existing base.
  requireDiditLiveness: false,
  safetyScanEnabled: true,         // P6: always-on Nemotron per-message safety scan + red bubbles — ships ON
  profileCompletionGate: true,     // Mandatory complete + AI-vetted profile before app access
  chatArchiveV2: false,            // P8 Stage 1: batched R2 cold archive — dark until verified
  restoreV2: false,               // P8 Stage 2: R2 lazy-older restore paging — dark
  driveAutoBackup: true,          // P8 Stage 3: daily Drive backup for EVERY user (no premium gate)
  agentDailyCap: 10,               // P5: 10 marketplace agent conversations/user/UTC-day
  autoResponderEnabled: true,      // STREAM F: auto-responder "Ava replies while away" — ships ON
  // AI Messenger Batch 2026-07-03 defaults (spec §8 / §12).
  marketplaceAgentSettingsEnabled: true, // STREAM A — ships ON
  mktI18nNegotiationEnabled: true,       // STREAM A — ships ON
  strangerGateEnabled: false,            // All senders appear in the normal chat list
  linkPreviewsEnabled: true,             // STREAM C — ships ON
  richInputEnabled: true,                // STREAM E — ships ON
  groupTranslationEnabled: false,        // STREAM G — OFF (cost watch)
  smartRepliesEnabled: true,             // STREAM G — ships ON
  scamAutoScanEnabled: true,             // STREAM G — ships ON
  // [AVA-IDGATE-1] livenessOnboardingGate removed from DEFAULTS. Liveness is no longer
  // an onboarding gate — it fires at the first public action via identityGatingEnabled.
  unlimitedForwardEnabled: true,         // STREAM I — ships ON
  groupReceiptsEnabled: false,           // [AVAGRP-SEENBY-1] dark launch — flip in KV once verified (scripts/flags.sh set groupReceiptsEnabled=true)
  dohFallbackEnabled: true,              // PERF-DNS-2 — DoH-to-1.1.1.1 fallback ON
  routingV2Enabled: false,               // [ARCH-ROUTING-V2] v4 routing path — DORMANT until wired + validated; legacy path unaffected
  sentinelEnabled: false,                // Guardian Sentinel S1 — DARK; flip ON in KV platform_config (never code) after telemetry review
  sentinelMem0Enabled: false,            // Sentinel S2 behaviour memory (mem0) — DARK; needs KV flag ON + MEM0_API_KEY secret
  guardianInlineEnabled: false,          // Guardian G3 inline two-lane scan — DARK; with it off messaging.ts is unchanged (deep lane only)
  guardianInlineBudgetMs: 600,           // G3 fast-lane hard budget (ms) for the single Nemotron moderate() call
  guardianGateEnabled: false,            // U1-lite manual "Require verification" gate — DARK; server modes 403 + client control hidden
  minAppBuild: 0,
  latestAppBuild: 0,                     // newest published build; >installed → soft "update available" popup (opens Play Store). Owner bumps in KV per release. 0 = never prompt.
  inAppUpdateEnabled: true,              // [AVA-UPDATE-AUTO] emergency brake for the auto-updater. TRUE (matches the client's own fallback default, so declaring it changes nothing today) — set false in KV to stop every device update-checking.
  cloudflareConferenceEnabled: false,    // [CF-CALL-000] Cloudflare-only media migration — DARK until Wave-N builds the CF conference path
  // Call-state control-plane authority (Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md §5)
  // — Phase A plumbing only. All OFF/legacy: CallStateAuthorityDO is bound but dark.
  authorityShadowEnabled: true,   // CALL-AUTH-LIVE-1: authority observes + records vs legacy
  authorityReadEnabled: true,     // routes may READ authority state
  authorityWriteEnabled: true,    // routes WRITE call state through the authority DO (fail-open)
  authorityEnforced: false,       // verdicts NOT yet enforced — one KV flip when shadow data is clean
  callProtocolVersion: 2,
  busyCardEnabled: true,           // Busy-card feature (personalized card + waiter list + now-free FCM) — LIVE 2026-07-07 (glue wired end-to-end). Flip false in KV to force legacy "User is busy".
  // Ava Copilot Phases A+B — ALL DARK until device-verified; flip ON in KV.
  avaCopilotEnabled: false,           // master switch (private lane + per-chat toggle + doc routes)
  avaDocActionsEnabled: false,        // Summarize ✨ / Translate ✨ context-menu actions
  avaAutoTranslateFileEnabled: false, // Auto-translate file ✨ (chunked — cost watch)
  // Ava Copilot Phases C+D — ODL ships DARK; flip via scripts/flags.sh set odlEnabled=true
  odlEnabled: false,          // ODL wake scan (shadow telemetry only; zero AI, zero user-visible output)
  avaMomentsEnabled: false,   // no user-visible Moments until a capability is production AND this is on
  avaGroupCompanionEnabled: false, // [AVA-GROUP-COMPANION-1] group Ava — dark; each group ALSO needs its own ava_group_state.mode='companion'
  // [AVA-ODL-POST-1] Per-capability kill switches — default true (no EXTRA
  // restriction beyond odlEnabled/avaMomentsEnabled/lifecycle, all of which
  // already keep this dark in prod). Explicit false in KV turns ONE
  // capability off without touching the other seven.
  avaCapMeetingEnabled: true,
  avaCapReminderEnabled: true,
  avaCapHumorEnabled: true,
  avaCapAutoStickerEnabled: true,
  avaCapExpenseSplitEnabled: true,
  avaCapBirthdayEnabled: true,
  avaCapOtpGuardEnabled: true,
  avaCapOrderTrackingEnabled: true,
  avaCapTravelPlanEnabled: true,
  avaCapCelebrationEnabled: true,
  // Call Outcome Menu (Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md) — ships DARK;
  // flip callMenuEnabled=true in KV (scripts/flags.sh) on staging first.
  callMenuEnabled: false,            // master switch for the unified call outcome menu
  callMenuListingsEnabled: false,    // See Listings button — stays OFF until marketplace goes public
  callMenuRateLimitEnabled: true,    // per-caller daily caps live whenever the menu is on
  avaSessionsPerCallerPerDay: 2,     // owner 2026-07-09: 2 Ava sessions/caller/owner/day, then greyed out
  strangerVoiceNotesPerDay: 5,       // stranger voice-note cap (known contacts unlimited)
  strangerTextNotesPerDay: 10,       // stranger text-note cap (known contacts unlimited)
  maxGroupMembers: 256,               // [MSG-GROUP-CAP-1] ordinary-group member ceiling (conference cap is separate, unaffected)
  // Dialpad business calls + Ava AI Voice Agent — ALL DARK until each phase is
  // device-verified on staging; flip one at a time in KV (never code).
  businessCallUx: false,
  brandedIncomingUi: true,           // [AVACALL-INUI-1] branded incoming-call screen for ALL AvaTOK calls; false = native CallKit everywhere
  suppressOsRingInForeground: true,  // [ONERING-1] foreground rings show ONE surface (the branded screen); false = old behaviour with the OS banner stacked on top
  foregroundRingDetectionV2: true,   // [CALL-REL-R4-B] relaxed front-of-screen test + CallKit fallback if we guessed wrong; false = strict `lifecycle == 'resumed'`
  notifMessagingStyle: true,         // [NOTIF-STYLE-1] per-chat stacked message notifications with sender photos; false = the old single shared banner on id 8000
  notifQuickActions: true,           // [NOTIF-ACTIONS-1] Reply / Mark as read / Mute on message notifications (and the Smart Reply chips that ride on the reply action); false = cards with no buttons
  notifReactions: true,              // [NOTIF-REACT-1] notify the message author when someone reacts; false = reactions stay silent (still persisted + live)
  voicemailBot: false,
  paidCalls: false,                    // Retired recipient-rate/escrow model stays disabled.
  voiceAgent: false,
  serviceNumbers: false,
  // 4-root shell (Home/AvaDial/AvaTalk/Services) — DARK. While false the client
  // renders today's messenger-first shell unchanged; flip ON in KV (staging first)
  // to switch to ShellV2. Client mirror: RemoteConfig.shellV2.
  shellV2: false,
  // AvaDial spam shield — DARK. While false every /api/spam/* route 403s and the
  // nightly scoring job no-ops. Flip ON in KV (staging first) after device tests.
  spamShield: false,
  // AvaDial native dialer surfaces — DARK. While false the AvaDial root keeps
  // its Phase-1 placeholders. Flip ON in KV (staging first) after the telecom
  // spike's device test matrix passes. Client mirror: RemoteConfig.avaDialer.
  avaDialer: false,
  // [AVADIAL-NATIVE-INCALL-1] Native in-call screen — DARK. While false, the answer
  // path is byte-for-byte the current Flutter one. Flip ON only after the device
  // matrix passes (mute/keypad/speaker/hold/bluetooth/end + lock-screen answer).
  nativeInCallUi: false,
  // [AVA-MISSEDCALL-1] Missed-call overlay + phone-presence lookup — DARK by default.
  // While false, /api/contacts/match returns nothing (privacy lock intact) and the
  // native missed-call receiver/overlay never fire. Flip ON in KV (staging first)
  // once the overlay is device-verified. Client mirror: RemoteConfig.missedCallOverlay.
  missedCallOverlay: false,
  // AvaDial default-SMS-app surfaces — DARK. While false the Messages tab keeps its
  // Phase-1 placeholder, NO SMS role is requested and the native SMS receivers stay
  // inert. Flip ON in KV (staging first) after the SMS role + device matrix passes
  // and Play's default-SMS-handler declaration is approved. Client mirror:
  // RemoteConfig.avaSms.
  avaSms: false,
  // [DEFAULT-APPS-REPROMPT-1] One-time "make AvaTOK your phone" re-prompt for
  // existing users — ON. Self-limiting: at most once per account, and only for
  // users missing the roles. Flip false in KV to kill it without a build.
  defaultAppsReprompt: true,
  // Contact-book backup/restore — LIVE + free. Paged download + R2 chunking ON so
  // large books restore a page at a time. Panic-off via contactsBookEnabled=false.
  contactsBookEnabled: true,
  contactsBookPaged: true,
  // [AVADIAL-BACKUP-DAILY] Daily background backup ON by default (owner decision
  // 2026-07-15: backup is a default app behaviour, not an opt-in). Set false in KV
  // to stop every client's daily job without a build.
  contactsDailyBackup: true,
  // §11/§15 constants — flag-overridable values, not design. Defaults per plan.
  minServiceRate: 20,
  agentRateAPerMin: 6,
  platformFeePerMin: 10,
  serviceLineFeePerMin: 3,
  agentMaxCallSec: 300,
  ringTimeoutSec: 30,
  agentAutoanswerSec: 12,
  voicemailRecordSec: 25,
  escrowPromptTimeoutSec: 30,
  offlineDetectSec: 6,
  agentConcurrencyA: 1,
  agentConcurrencyB: 5,
  networkReconnectWindowSec: 20,
  conferenceBillingEnabled: false,     // Retired host-paid conference model stays disabled.
  conferenceVideoTokensPerHour: 0,
  humanCallParticipantBillingEnabled: false, // [HUMAN-CALL-POOL-1] dark by default.
  // PSTN voicemail platform — DARK. While false, worker/src/routes/pstn.ts runs
  // pure-probe mode only (capture + orphan voicemail, no owner inbox delivery).
  // Flip ON in KV (staging first) once Phase 0 carrier verification passes.
  pstnVoicemail: false,
  pstnVoicemailRecordSec: 25,
  // [AVA-VM-PAID-1] FALSE = missed/declined are a locked paid upgrade (the
  // launch state). Flip TRUE only when the paid tier actually ships.
  pstnPaidConditionsUnlocked: false,
  // [AVA-PSTN-AGENT-1] Live Gemini agent on Vobiz DID calls — SHIPS DARK.
  // Flip on only after: Gemini credits topped up on avatok-avaglobal, audio-
  // streams confirmed enabled on the Vobiz account, and a test owner has
  // mode="agent". Boolean → NOT in numericKeys.
  pstnAgentEnabled: false,
  pstnVoicemailSelfRecord: false, // [AVA-VM-SELFREC-1] dark by default; flip in KV to self-record voicemail

  // [TEL-TIERS-1] Track-only launch state: concurrency gauges run, enforcement
  // (busy fallback above channels_total) stays OFF until peak data says otherwise.
  pstnConcurrencyEnforced: false,
  // Creator marketplace (/api/marketplace/*) — DARK, per FREE LAUNCH. The kill switch
  // marketplace.ts always claimed to have; it did not exist until now.
  marketplaceEnabled: false,
  marketplacePublishEnabled: false,
  marketplaceNegotiationEnabled: false,
  marketplaceDealDeliveryV2: false,
  // OLX surface (/api/olx/*) — DARK. Was previously ungated in production; flip ON in
  // KV (staging first) when it should be reachable.
  olxEnabled: false,
  // AI-chat listing creation (/api/marketplace/compose/*) — DARK. An LLM that talks to
  // sellers and drafts public listing text; staging first, and the form stays as the
  // escape hatch until the funnel says otherwise (M-D7).
  aiComposeEnabled: false,
  // Per-listing billing — DARK. While off, publishes are free and entitlements are
  // still recorded so the 5-free quota is accurate when this flips on (staging first).
  listingFeeEnabled: false,
  // Compose brain enrichment — DARK. Needs One Brain B4 + the user's listings consent;
  // separate from aiComposeEnabled so compose can be live without account-history recall.
  listingBrainEnrichmentEnabled: false,

  // --- outbound campaigns ---
  // Outbound AI Calling Campaigns (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §18) — DARK.
  // Flip campaignsEnabled ON in KV (staging first) once the dialer + billing path
  // is device/CI-verified; the other flags gate individual capabilities beneath it.
  campaignsEnabled: false,
  campaignDialerEnabled: false,
  campaignOwnerAllowlist: false,
  campaignMachineDetection: true,   // AMD advisory ships ON by default
  campaignGoogleSheets: false,
  campaignKbEnabled: false,
  campaignToolsEnabled: false,
  campaignBookingEnabled: false,
  campaignHandoverEnabled: false,
  campaignMaxContacts: 2000,
  campaignCallMaxMin: 10,
  campaignWrapCueMin: 8,
  campaignTokensPerMin: 6,
  campaignDidMonthlyTokens: 700,
  campaignKbMaxFiles: 10,
  campaignToolBudget: 6,
  campaignHandoverRingSec: 25,
  campaignHandoverTokensPerMin: 3,   // [AVA-CAMP-Q-BACKEND] human-takeover tariff bumped 2->3 tokens/min (owner decision 2026-07-20)
  campaignHandoverTopupMin: 10,

  // --- Dynamic Workers ([DYNW-CORE-1]) — ALL DARK. Flip on staging KV first. ---
  dynamicWorkersEnabled: false,
  dynCodeModeEnabled: false,
  dynAvaBrainContextEnabled: false,
  dynReceptionistRulesEnabled: false,
  dynMarketplaceFlowsEnabled: false,
  dynCallRoutingEnabled: false,
  dynCreatorAgentToolsEnabled: false,
  dynModuleMaxBytes: 131072,         // 128 KB bundled-source cap (lib/dynw/registry.ts)

  // [DYNW-FLOWS-1] WS-3 deletion Workflow — DARK. Flip on staging KV first.
  deletionWorkflowEnabled: false,

  // --- [AVA-CFG-CACHE-1 2026-08-07] Ava V2 workstream flags (see the interface
  // above for what each one gates). Live kill switches default TRUE; everything
  // that changes behaviour or money SHIPS DARK and is flipped deliberately. ---
  avaStreamPlainEnabled: true,        // WS-5  kill switch, streaming ON
  avaImageFastPathEnabled: true,      // WS-7  kill switch, fast path ON
  avaMemoryIntentGateEnabled: false,  // WS-12 dark
  avaImageTwoTierEnabled: false,      // WS-10 dark
  avaDmToggleEnabled: false,          // WS-17 dark
  avaDmDefaultOn: false,              // WS-17 dark (owner flips this one on)
  avaAmbientAiEnabled: false,         // WS-18b — flip deliberately; kill switch for unprompted AI posts
  avaAmbientCooldownS: 1800,          // [AVA-AMBIENT-2] 30 min between unprompted posts per conv
  avaAmbientDailyCapPerConv: 8,       // [AVA-AMBIENT-2] hard daily cap per conv
  avaAmbientEnabled: true,            // [AVA-AMBIENT-1] Ambient Ava reactions+comments — ships ON (kill switch)
  avaAmbientCommentsPerHour: 3,       // [AVA-AMBIENT-1] comment cap per conv per rolling hour
  avaFlatPricingEnabled: false,       // WS-19d dark — replaces LIVE metered billing
  avaMessageSearchEnabled: false,     // WS-19 dark
  // WS-14 voice style enum: 0=en, 1=hi, 2=hinglish. Default 2 = Hinglish Gen-Z.
  avaVoiceStyleDefault: 2,
  // WS-10 resolution tier enum: 0=512, 1=1K, 2=2K.
  imagePreviewResolutionTier: 1,      // preview at 1K
  imageFullResolutionTier: 2,         // full at 2K
  // WS-19d tariffs in TOKENS (1 token = ₹1); only read when avaFlatPricingEnabled.
  imageCostTokens: 1,
  image2kUpgradeCostTokens: 4,
  searchCostTokens: 2,
  musicCostPerMinuteTokens: 5,        // forward declaration — no code path yet
  // [VENICE-IMG-1 2026-08-14] ships dark; flip true in KV to route image gen to Venice.
  veniceMediaEnabled: false,
  veniceImageTokens: 2,
  veniceMusicTokens: 10,
  veniceVideoTokens: 45,
  // [VENICE-CHAT-1 2026-08-14] ships dark; flip true in KV to let paid-tier
  // opted-in accounts route @ava chat to Venice Uncensored 1.2.
  veniceUncensoredChatEnabled: false,
  // [AVA-GROUP-SESSION-1 2026-08-16] shared group song/video sessions — live by
  // owner decision the same day; flip false in KV to kill instantly.
  groupSharedMediaSessionEnabled: true,
  // [SONG-LEN-2 2026-08-17] off until a duration-capable model is live-tested;
  // set to "ace-step-15" or "elevenlabs-music" in KV to enable 2-3.5 min songs.
  veniceLongMusicModel: "",
  // [SONG-QUICK-1 2026-08-17] engine-written quick songs sing on elevenlabs-music,
  // which writes its own words from the prompt. Set to "" in KV to send quick
  // songs to the default music model instead.
  veniceQuickSongModel: "elevenlabs-music",
};

/**
 * Owner decision 2026-08-02: ordinary human messaging and audio/video calls are
 * no longer used. Keep the old config keys for wire compatibility with
 * installed clients, but never allow stale KV overrides to resurrect charging.
 */
export const PERMANENT_FREE_COMMUNICATION = Object.freeze({
  paidCalls: false,
  conferenceBillingEnabled: false,
  conferenceVideoTokensPerHour: 0,
});

export function enforcePermanentFreeCommunication(config: PlatformConfig): PlatformConfig {
  return { ...config, ...PERMANENT_FREE_COMMUNICATION };
}

// ---------------------------------------------------------------------------
// [AVA-CFG-CACHE-1] readConfig had NO caching of any kind — a fresh KV get on
// every call, and it is called 4x per plain Ava turn (premium.ts, ai_gate.ts x3)
// across 40+ call sites. This memo is module scope, i.e. PER ISOLATE, which is
// exactly the right granularity: every call site benefits with no change, and a
// cold isolate reads KV once.
//
// TTL = 10 s. Deliberately short: a flag flip must stay an OPERATIONAL tool, not
// a wait. 10 s kills essentially every duplicate read (an Ava turn lasts seconds,
// so all 4 reads collapse into 1) while keeping the worst case a server-side gate
// can lag a `flags.sh set` at ten seconds. `/api/config` is NOT served from this
// memo — getConfig keeps its own read — so the client-facing 60 s edge cache does
// not stack on top of it. Worst cases: server-side gates ≤ 10 s; the client blob
// ≤ 60 s edge (unchanged by this commit) + the client's own RemoteConfig poll.
//
// Keyed by ENVIRONMENT_NAME (wrangler [vars] "prod" / [env.staging.vars]
// "staging"). Staging and prod are separate Worker scripts with separate TOKENS
// KV namespaces, so they already never share an isolate — the key is belt and
// braces so this can never serve staging config to production if that ever
// changes. Only the raw OVERRIDES blob is memoized, never the merged object:
// DEFAULTS stay the source of truth and are re-layered on every call, and no
// caller can mutate a shared object.
//
// A failed KV read is NOT cached. Pinning an empty override blob for 10 s during
// a transient KV error would revert every production flag to its DEFAULT for
// that window; falling through to KV on the next call is the safe behaviour and
// matches what happened before this change.
const CONFIG_MEMO_TTL_MS = 10_000;
const configMemo = new Map<string, { at: number; overrides: Partial<PlatformConfig> }>();

function memoKey(env: Env): string {
  return String(env.ENVIRONMENT_NAME ?? "prod");
}

/** Drop the memo for this isolate. Called by putConfig; TTL is the real
 *  invalidation across the other isolates. */
export function bustConfigMemo(env?: Env): void {
  if (env) configMemo.delete(memoKey(env));
  else configMemo.clear();
}

/** Merged config for server-side gates (same blob getConfig serves). */
export async function readConfig(env: Env): Promise<PlatformConfig> {
  const key = memoKey(env);
  const hit = configMemo.get(key);
  if (hit && Date.now() - hit.at < CONFIG_MEMO_TTL_MS) {
    return enforcePermanentFreeCommunication({ ...DEFAULTS, ...hit.overrides });
  }
  let stored: Partial<PlatformConfig> = {};
  try {
    stored = ((await env.TOKENS.get(KEY, "json")) ?? {}) as Partial<PlatformConfig>;
    configMemo.set(key, { at: Date.now(), overrides: stored });
  } catch { /* defaults; deliberately NOT memoized — see the note above */ }
  return enforcePermanentFreeCommunication({ ...DEFAULTS, ...stored });
}

export async function getConfig(env: Env): Promise<Response> {
  let stored: Partial<PlatformConfig> = {};
  try {
    stored = (await env.TOKENS.get(KEY, "json")) ?? {};
  } catch { /* defaults */ }
  // PartyKit realtime layer master switch (replaces Ably). Ships DARK: the client
  // only opens party sockets when this is true. Flip via `wrangler secret put
  // PARTY_ENABLED` = "1" once the PartyDO migration (v11) is deployed.
  const partyEnabled = env.PARTY_ENABLED === "1";
  return json({ ...enforcePermanentFreeCommunication({ ...DEFAULTS, ...stored }), partyEnabled }, 200, {
    "cache-control": "public, max-age=60",
  });
}

export async function putConfig(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const admins = (env.ADMIN_UIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!admins.includes(u.uid)) return json({ error: "admin only" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  // Whitelist merge — unknown keys are rejected so a typo can't ship a dead flag.
  //
  // [ENV-ISOLATION-1] KV stores OVERRIDES ONLY — never `{...DEFAULTS, ...current}`.
  // The old code materialized all ~40 flags into the blob on every write, which
  // meant (a) flipping one switch rewrote the entire config, and (b) once the
  // blob existed, changing a default in this file silently stopped taking effect
  // because the stale value was pinned in KV forever. Readers (readConfig /
  // getConfig) already layer DEFAULTS underneath, so an absent key is correct and
  // self-healing. To drop a stale pinned key: `scripts/flags.sh unset <key>`
  // (or `scripts/flags.sh prune` to sweep every key that just restates a default).
  const current = ((await env.TOKENS.get(KEY, "json")) ?? {}) as Partial<PlatformConfig>;
  const next: Record<string, unknown> = { ...current };
  const numericKeys = new Set([
    "commercialCreatorFeePct", "commercialSettlementHoldHours",
    "commercialConsultJoinEarlyMin", "commercialConsultJoinLateMin",
    "commercialConsultExtensionMinutes", "commercialConsultExtensionRate",
    "commercialLiveBackstageEarlyMin", "commercialLiveStartGraceMin",
    "minAppBuild", "latestAppBuild", "dailyAvaTurnLimit", "receptionistRings", "agentDailyCap", "livenessAuditSampleRate",
    "receptWrapCueMs", "receptCloseMs", "receptHardCapMs",
    // [PA-GATE-1] PA stuck-session watchdog (spec §3.4) — numeric, so it must be here.
    "paWatchdogMs",
    // [AVA-AMBIENT-2] DM companion ambient lane knobs.
    "avaAmbientCooldownS", "avaAmbientDailyCapPerConv",
    // [AVA-AMBIENT-1] Ambient Ava comment cap.
    "avaAmbientCommentsPerHour",
    "usdInrRate", "receptMarginAlertPaise", "upiPayoutMinCoins", "upiPayoutReservationTtlHours", "upiVpaCooldownHours",
    // [AVABRAIN-FLAGS-1] media_memory caps + export cap + companion knobs.
    "mediaMemoryMaxSec", "mediaMemoryMaxBytes", "mediaMemoryFrameBudget", "mediaMemoryDailyPerUser",
    "mediaMemoryConcurrency", "avaBrainExportDailyCap", "companionGroupCooldownSec", "companionGroupDailyBudget",
    "guardianInlineBudgetMs", "callProtocolVersion", "avaSessionsPerCallerPerDay", "strangerVoiceNotesPerDay",
    "strangerTextNotesPerDay", "maxGroupMembers",
    // Dialpad business calls + Ava AI Voice Agent — §11/§15 numeric constants.
    "minServiceRate", "agentRateAPerMin", "platformFeePerMin", "serviceLineFeePerMin", "agentMaxCallSec",
    "ringTimeoutSec", "agentAutoanswerSec", "voicemailRecordSec", "escrowPromptTimeoutSec", "offlineDetectSec",
    "agentConcurrencyA", "agentConcurrencyB", "networkReconnectWindowSec", "conferenceVideoTokensPerHour",
    // PSTN voicemail platform (Canonical Architecture v1.0).
    "pstnVoicemailRecordSec",
    // Outbound AI Calling Campaigns (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §18).
    "campaignMaxContacts", "campaignCallMaxMin", "campaignWrapCueMin", "campaignTokensPerMin",
    "campaignDidMonthlyTokens", "campaignKbMaxFiles", "campaignToolBudget",
    "campaignHandoverRingSec", "campaignHandoverTokensPerMin", "campaignHandoverTopupMin",
    // [AI-FLAG-CONTRACT-1 2026-07-25] Both were numeric in DEFAULTS but missing here,
    // so `scripts/flags.sh set` 400'd `bad type` on either — un-tunable fair-use caps.
    "imageDailyCap", "livenessValidityDays",
    // [AVA-FREE-BUDGET-1 / AI-PRICE-CATALOG-1 2026-07-25] free-text-lane budgets + the
    // unrecovered-cost circuit breaker — all numeric, all must be here or they 400.
    "freeTextMaxInputTokens", "freeTextDailyInputTokens", "freeTextDailyOutputTokens",
    "freeTextDailyCostMicroUsd", "unrecoveredDailyCapMicroUsd",
    // [AI-PRICE-CATALOG-1 2026-07-25 / gate finding B3] platform-wide unrecovered-
    // loss alert threshold — numeric, must be here or `putConfig` 400s `bad type`.
    "unrecoveredPlatformAlertMicroUsd",
    // [DYNW-CORE-1] dynamic-module source size cap — numeric or flags.sh 400s.
    "dynModuleMaxBytes",
    // [CALL-TRANSLATE-2D-3] call-translation abuse ceilings — numeric, must be
    // here or `flags.sh set callTranslationStartsPerHour=90` 400s `bad type`.
    "callTranslationStartsPerHour", "callTranslationWarmupsPerHour", "callTranslationSwitchesPerHour",
    // [CALL-SURVIVE-1 2026-08-04] handover-survival tunables — numeric, must
    // be here or `flags.sh set callRecoveryDeadlineSec=15` 400s `bad type`.
    "callRecoveryDeadlineSec", "callMigrationDeadlineSec", "callRecoveryMaxAttempts",
    "callQosHeadroomFactor", "callQosLossDownshiftPct", "callQosStableLossPct",
    "callQosStableRttMs", "callQosStableSamples",
    "callVideoLossDegradePct", "callVideoLossPausePct", "callVideoStableSamples",
    // [CALLREC-SERVER-1] device free-space floor for the call recorder — numeric,
    // must be here or `flags.sh set callRecordingMinFreeMb=750` 400s `bad type`.
    "callRecordingMinFreeMb",
    // [CALL-PRESENCE-1 2026-08-07] heartbeat freshness + cadence — numeric, must
    // be here or `flags.sh set presenceFreshSec=120` 400s `bad type`.
    "presenceFreshSec", "presenceHeartbeatSec",
    // [CALL-PRESENCE-2 2026-08-08] the OFFLINE threshold — numeric, must be here or
    // `flags.sh set presenceOfflineSec=600` 400s `bad type`. This is the knob the
    // owner will actually turn ("X amount of time"), so a fake flag here would mean
    // the rule's one tunable could never be tuned.
    "presenceOfflineSec",
    // [CALL-4RINGS-1 2026-08-08] assumed length of one ring cycle — numeric, must
    // be here or `flags.sh set ringCycleMs=5000` 400s `bad type`. (`callRealRingCount`
    // is a BOOLEAN and must NOT be listed here.)
    "ringCycleMs",
    // [CALL-RTK-2 2026-08-08] RealtimeKit join deadline — numeric, must be here
    // or `flags.sh set callRtkJoinDeadlineSec=15` 400s `bad type`.
    // (`callRealtimeKitV1` / `groupRealtimeKitV1` are BOOLEANS — not listed.)
    "callRtkJoinDeadlineSec", "callSilentPrewarmDeadlineMs",
    // GetStream Video pilot rollout percentage. The provider selector clamps
    // this defensively to 0..100; keep it numeric so flags.sh can flip rollout
    // without a Worker/client rebuild.
    "streamCallPilotPercent",
    // [MESSENGER-CALL-BILLING-FOUNDATION] Messenger prices, allowance and
    // reservation/tick controls. Every numeric config key must be listed here
    // or flags.sh rejects a valid remote override as bad type.
    "messengerAudioFreeParticipantSecondsDaily",
    "messengerAudioPaidCentitokensPerParticipantMinute",
    "messengerVideoSdCentitokensPerParticipantMinute",
    "messengerVideoHdCentitokensPerParticipantMinute",
    "messengerVideo2kCentitokensPerParticipantMinute",
    "messengerVideo4kCentitokensPerParticipantMinute",
    "messengerCallReservationWallSeconds",
    "messengerCallLowBalanceWarningWallSeconds",
    "messengerCallUsageTickSeconds",
    "messengerCallPriceVersion",
    // [STREAM-GATE-1 2026-08-21] Legacy-dial build floor — numeric, must be here
    // or `flags.sh set callMinBuild=10620` 400s `bad type`, and the one knob the
    // whole "update required" cutover depends on would be untunable.
    "callMinBuild",
    // [AFF-COMM-LIFECYCLE-1 2026-08-05] affiliate qualification window + caps —
    // numeric, must be here or `flags.sh set affiliateQualifyDays=45` 400s `bad type`.
    "affiliateQualifyDays", "affiliateMinQualifyingTopupCoins",
    "affiliateDailyEarnCapCoins", "affiliateMonthlyEarnCapCoins", "affiliatePerReferredCapCoins",
    // [AVA-CFG-CACHE-1 2026-08-07] Ava V2 numeric keys. The two *Tier keys and
    // avaVoiceStyleDefault are ENUMS-AS-NUMBERS (config.ts has no string type) —
    // see the interface for the value tables. Missing here = `flags.sh set
    // avaVoiceStyleDefault=1` 400s `bad type`.
    "avaVoiceStyleDefault", "imagePreviewResolutionTier", "imageFullResolutionTier",
    "imageCostTokens", "image2kUpgradeCostTokens", "searchCostTokens", "musicCostPerMinuteTokens",
    // [VENICE-IMG-1 2026-08-14] Venice tariffs — numeric, must be here or
    // `flags.sh set veniceImageTokens=3` 400s `bad type`. (`veniceMediaEnabled`
    // is a BOOLEAN — not listed.)
    "veniceImageTokens", "veniceMusicTokens", "veniceVideoTokens",
    // AVACALLS / Virtual Numbers pricing and per-account cap.
    "avaCallsPstnTokensPerMinute", "avaCallsPstnMinRunwayMinutes",
    "virtualNumberFreeMaxPerAccount", "virtualNumberDidMonthlyTokens",
    // [PIVOT-PAID-NUMBER-1] paid vanity AvaTOK number price, in tokens.
    "avatokVanityNumberTokens",
  ]);
  const stringKeys = new Set(["virtualNumberPrimaryProvider"]);
  for (const [k, v] of Object.entries(body)) {
    if (!(k in DEFAULTS)) return json({ error: `unknown key: ${k}` }, 400);
    if ((k === "paidCalls" || k === "conferenceBillingEnabled") && v !== false) {
      return json({ error: `${k} is retired; use humanCallParticipantBillingEnabled` }, 409);
    }
    if (k === "conferenceVideoTokensPerHour" && v !== 0) {
      return json({ error: "conferenceVideoTokensPerHour is retired; pooled participant billing owns rates" }, 409);
    }
    if (numericKeys.has(k) ? typeof v !== "number" : stringKeys.has(k) ? typeof v !== "string" : typeof v !== "boolean") {
      return json({ error: `bad type for ${k}` }, 400);
    }
    if (k.startsWith("messenger") && numericKeys.has(k) && (!Number.isFinite(v as number) || (v as number) < 0)) {
      return json({ error: `${k} must be a non-negative finite number` }, 400);
    }
    if (k.startsWith("commercial") && numericKeys.has(k)
      && (!Number.isFinite(v as number) || (v as number) < 0)) {
      return json({ error: `${k} must be a non-negative finite number` }, 400);
    }
    if (k === "commercialCreatorFeePct" && (v as number) > 100) {
      return json({ error: "commercialCreatorFeePct must be between 0 and 100" }, 400);
    }
    if (k === "messengerCallPriceVersion" && (v as number) < 1) {
      return json({ error: "messengerCallPriceVersion must be >= 1" }, 400);
    }
    if (k === "virtualNumberPrimaryProvider" && v !== "vobiz" && v !== "frejun") {
      return json({ error: "virtualNumberPrimaryProvider must be vobiz or frejun" }, 400);
    }
    next[k] = v;
  }
  await env.TOKENS.put(KEY, JSON.stringify(next));
  // [AVA-CFG-CACHE-1] Bust this isolate's memo so the admin who just flipped the
  // switch is not told a stale value back. Other isolates fall out of date for at
  // most CONFIG_MEMO_TTL_MS (10 s) — the TTL is the real cross-isolate
  // invalidation; a Worker has no way to broadcast to its own isolates.
  bustConfigMemo(env);
  // Echo the EFFECTIVE config (defaults + overrides) so the admin UI still sees
  // every flag, even though only `next` was persisted.
  return json({ ok: true, config: enforcePermanentFreeCommunication({ ...DEFAULTS, ...next }), overrides: next });
}
