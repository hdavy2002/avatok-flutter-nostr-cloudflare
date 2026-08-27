import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show MethodChannel;
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';

import '../identity/identity.dart';
import '../sync/party/party_hub.dart';
import 'analytics.dart';
import 'ava_log.dart';
import 'config.dart';
import 'disk_cache.dart';
import 'feature_flags.dart';
import 'money_api.dart';
import 'net/ava_dns.dart';

/// Remote kill switches (creator-marketplace Phase 1, audit A2). Mirrors the
/// Worker's GET /api/config (KV `platform_config`). Fetched at app start and
/// every 15 min; money/live UI must check the matching getter before
/// rendering. Defaults are PERMISSIVE except real money, so a fetch failure
/// never bricks the app.
class RemoteConfig {
  RemoteConfig._();

  static Map<String, dynamic> _cfg = const {};
  static Timer? _timer;

  /// [BOOT-FLASH-1] Disk cache of the LAST-KNOWN-GOOD server config.
  ///
  /// Until 2026-08-06 `_cfg` lived in memory only, so EVERY cold start began on
  /// the hardcoded defaults below and flipped to the server's values a moment
  /// later when the HTTP GET landed. With `RootFlow.build` wrapped in a
  /// `ValueListenableBuilder<RemoteConfig.revision>`, that flip rebuilt the whole
  /// tree — and for a UI-shaping flag like [shellV2] it repainted an entirely
  /// different shell. That is the "settle / flash" on launch.
  ///
  /// DEVICE-LEVEL, not per-account: `/api/config` is unauthenticated and returns
  /// the same platform-wide blob for everyone (the only per-account thing in this
  /// class is [_isAdmin], which keeps its own account-scoped cache), so
  /// [DiskCache.writeGlobal] is correct here. Scoping it per account would mean
  /// every account on a shared phone re-flashed on its first launch, and would
  /// also make the cache unavailable during the pre-`AccountScope` boot window
  /// where we actually need it.
  static const String _kCfgCache = 'platform_config_v1';

  /// Max age of the disk cache. Past this we fall back to the compile-time
  /// defaults rather than trusting a very old snapshot — see the kill-switch note
  /// on [hydrateFromDisk]. Generous (7d) because the app is used daily; a device
  /// that hasn't reached `/api/config` in a week is not a device we should be
  /// letting a week-old "feature ON" decision drive.
  static const int _cfgCacheMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

  /// Signature of the config currently in [_cfg]. Used to bump [revision] ONLY
  /// when the values actually changed — a 15-minute poll that returns the same
  /// blob used to rebuild the entire widget tree for nothing.
  static String _cfgSig = '';

  static Future<void>? _hydrated;

  /// Bumps whenever a fetch lands — listen to re-check flags (e.g. the
  /// minAppBuild gate in RootFlow).
  static final ValueNotifier<int> revision = ValueNotifier(0);

  /// Whether the SIGNED-IN account is a platform admin (uid ∈ server ADMIN_UIDS).
  /// Resolved by [refreshAdmin] via the existing signed /admin/recon probe. Used
  /// to surface admin-only, not-yet-launched surfaces (e.g. the Marketplace) to
  /// the operator without exposing them to ordinary testers. Per-account: it is
  /// re-resolved on every config refresh AND on every account switch (see
  /// [onAccountSwitched]), so an account switch on a shared phone re-checks
  /// against the newly active token instead of inheriting the departing
  /// account's value.
  static bool _isAdmin = false;
  static bool get isAdmin => _isAdmin;

  /// Per-account cache key for [_isAdmin]. DiskCache is scoped by AccountScope.id,
  /// so each account on a shared phone keeps its OWN cached admin flag — a switch
  /// never inherits the previous account's value, and there is no cross-account
  /// leak. The signed /admin/recon probe ([refreshAdmin]) stays the source of
  /// truth and refreshes this cache; the cache only supplies an instant, leak-free
  /// paint before the probe lands (no Marketplace flicker on a non-admin child).
  static const String _kAdminCache = 'is_admin';

  /// [ADMIN-GATE] Per-account timestamp (ms) of the last COMPLETED /admin/recon
  /// probe. PostHog (7d prod): every ordinary user's client fired the admin probe
  /// on launch + every 15 min, so the directory saw 95×401 (79 users) + 128×403
  /// (39 users) and 378 admin_probe events across 82 users — all rejections, all
  /// pure waste, since admin status is a fixed server-side claim that does not
  /// change minute to minute. Admin status is only knowable server-side (no local
  /// claim), so for a NON-admin account we cache the rejection and re-probe at
  /// most once a week; a known admin (cached is_admin=1) keeps probing normally so
  /// a revoked admin loses admin surfaces promptly. Scoped by AccountScope.id.
  static const String _kAdminProbeAtKey = 'admin_probe_last_ms';
  static const int _adminProbeThrottleMs = 7 * 24 * 60 * 60 * 1000; // 7d

  /// Load the ACTIVE account's cached admin flag into memory (instant paint).
  /// Never throws; defaults to non-admin when nothing is cached for this account.
  static Future<void> _loadAdminCache() async {
    bool v = false;
    try { v = (await DiskCache.read(_kAdminCache)) == '1'; } catch (_) {/* best-effort */}
    if (v != _isAdmin) { _isAdmin = v; revision.value++; }
  }

  /// Re-resolve admin state for the NEWLY active account after an account switch.
  /// Step 1 paints the target account's own cached value instantly (leak-free on a
  /// shared phone — a non-admin child no longer briefly sees admin-only surfaces
  /// like the Marketplace). Step 2 re-probes the server to confirm + refresh the
  /// cache. Skips the network probe on logout (no active account). Never throws.
  static Future<void> onAccountSwitched() async {
    await _loadAdminCache();
    if (AccountScope.id != null && AccountScope.id!.isNotEmpty) {
      unawaited(refreshAdmin());
    }
  }

  static bool _b(String k, bool dflt) => _cfg[k] is bool ? _cfg[k] as bool : dflt;

  /// Tolerant numeric parsing: handles bool→num cast (when server sends true/false
  /// for numeric fields). Converts bool 1→1, 0→0; otherwise tries num parse.
  /// This prevents "bool is not num?" crashes when config fields are mistyped.
  static num? _asNum(dynamic v) => v is num ? v : (v is bool ? (v ? 1 : 0) : null);

  // FREE LAUNCH (2026-06-28, Specs/FREE-LAUNCH-DIRECTION.md): the hidden-feature
  // defaults below flip to FALSE so a config-fetch failure renders the focused
  // free product (not the full marketplace). The live KV `platform_config`
  // mirrors these; flip them back when paid/marketplace returns.
  static bool get walletRealMoney => _b('walletRealMoney', false);
  static bool get donationsEnabled => _b('donationsEnabled', true);
  static bool get liveEnabled => _b('liveEnabled', false);
  static bool get consultEnabled => _b('consultEnabled', false);
  // Phase 2 commercial GetStream lane. Every launch-facing control fails
  // closed and is independent of Messenger transport/billing configuration.
  static bool get commercialLiveListingsEnabled =>
      _b('commercialLiveListingsEnabled', false);
  static bool get commercialLiveCheckoutEnabled =>
      _b('commercialLiveCheckoutEnabled', false);
  static bool get commercialLiveJoinEnabled =>
      _b('commercialLiveJoinEnabled', false);
  static bool get commercialConsultListingsEnabled =>
      _b('commercialConsultListingsEnabled', false);
  static bool get commercialConsultCheckoutEnabled =>
      _b('commercialConsultCheckoutEnabled', false);
  static bool get commercialConsultJoinEnabled =>
      _b('commercialConsultJoinEnabled', false);
  static int get commercialCreatorFeePct =>
      (_asNum(_cfg['commercialCreatorFeePct'])?.toInt()) ?? 80;
  static int get commercialSettlementHoldHours =>
      (_asNum(_cfg['commercialSettlementHoldHours'])?.toInt()) ?? 24;
  static int get commercialConsultJoinEarlyMin =>
      (_asNum(_cfg['commercialConsultJoinEarlyMin'])?.toInt()) ?? 10;
  static int get commercialConsultJoinLateMin =>
      (_asNum(_cfg['commercialConsultJoinLateMin'])?.toInt()) ?? 2;
  static bool get commercialConsultExtensionEnabled =>
      _b('commercialConsultExtensionEnabled', false);
  static int get commercialConsultExtensionMinutes =>
      (_asNum(_cfg['commercialConsultExtensionMinutes'])?.toInt()) ?? 0;
  static int get commercialConsultExtensionRate =>
      (_asNum(_cfg['commercialConsultExtensionRate'])?.toInt()) ?? 0;
  static int get commercialLiveBackstageEarlyMin =>
      (_asNum(_cfg['commercialLiveBackstageEarlyMin'])?.toInt()) ?? 30;
  static int get commercialLiveStartGraceMin =>
      (_asNum(_cfg['commercialLiveStartGraceMin'])?.toInt()) ?? 15;
  static bool get commercialReplayEnabled =>
      _b('commercialReplayEnabled', false);
  static bool get commercialRecordingEnabled =>
      _b('commercialRecordingEnabled', false);
  static bool get conferenceEnabled => _b('conferenceEnabled', true);
  // Cloudflare-only media migration Wave-0 scaffold (Specs/CLOUDFLARE-ONLY-REALTIME-MEDIA-MIGRATION-PROPOSAL-2026-07-24.md).
  static bool get cloudflareConferenceEnabled => _b('cloudflareConferenceEnabled', false);
  // [AVA-VM-NOCOUNTDOWN-1] 3-2-1 Ava warm-up countdown before voicemail. Default ON
  // (legacy behavior); prod KV flips it OFF because the cached VM greeting is instant.
  static bool get avaCountdownEnabled => _b('avaCountdownEnabled', true);
  /// [AVA-SYNC-SKIP] Kill switch for the reconnect/resume empty-catch-up skip. Default
  /// TRUE. When true, the InboxDO answers a reconnect/resume whose cursor is already at
  /// head with a cheap `sync_skip` frame instead of a full replay. Flip false in KV to
  /// make every device fall back to the always-full-sync behaviour. Declared in
  /// worker/src/routes/config.ts (PlatformConfig + DEFAULTS) so it is a real, flippable flag.
  static bool get syncSkipEnabled => _b('syncSkipEnabled', true);
  /// CF Realtime SFU group-audio path — dormant until its build lands + is
  /// CI/device-verified. While false, group calls use the existing LiveKit path.
  static bool get groupAudioSfuEnabled => _b('groupAudioSfuEnabled', false);
  // [CALL-SFU-1] 1:1 media transport selector. When enabled, CallSession
  // attempts Cloudflare Realtime first and retains the existing P2P path as
  // the rollback if the SFU is unavailable or the peer aborts it.
  static bool get callSfuV1 => _b('callSfuV1', false);
  static bool get callSfuAudioOnly => _b('callSfuAudioOnly', false);

  /// [STREAM-CALL-PILOT-1] Staging-only switch for the optional Stream 1:1
  /// voice transport. The client defaults to OFF so a config fetch failure can
  /// never move a call away from the proven Cloudflare/P2P path. The worker can
  /// add this key later; older workers simply leave the adapter dormant.
  ///
  /// This flag does not itself ring or join a call. The Stream adapter also
  /// requires an explicit per-call provider decision, which keeps one call
  /// sticky and prevents the two peers from choosing different transports.
  static bool get streamCallPilotEnabled => _b('streamCallPilotEnabled', false);

  /// [STREAM-LANE] Independent gate for the NEW `stream_video_flutter` SDK
  /// integration (app/lib/streamlane/) — do not confuse with
  /// [streamCallPilotEnabled] above, which gates the OLD hand-rolled Stream
  /// pilot (core/calls/rtc/). The two must never both be true for the same
  /// call; keeping separate flags makes that a config-time guarantee rather
  /// than something the client has to reconcile at runtime.
  static bool get streamCallsEnabled => _b('streamCallsEnabled', false);

  /// [MESSENGER-CALL-BILLING-UI] Provider-neutral Messenger billing gate.
  ///
  /// All paid rates intentionally default to zero. A missing or malformed
  /// remote config must leave paid choices unavailable, never silently free.
  static bool get messengerCallBillingEnabled =>
      _b('messengerCallBillingEnabled', false);
  static int get messengerAudioFreeParticipantSecondsDaily =>
      (_asNum(_cfg['messengerAudioFreeParticipantSecondsDaily'])?.toInt()) ?? 28800;
  static int get messengerAudioPaidCentitokensPerParticipantMinute =>
      (_asNum(_cfg['messengerAudioPaidCentitokensPerParticipantMinute'])?.toInt()) ?? 0;
  static int get messengerVideoSdCentitokensPerParticipantMinute =>
      (_asNum(_cfg['messengerVideoSdCentitokensPerParticipantMinute'])?.toInt()) ?? 0;
  static int get messengerVideoHdCentitokensPerParticipantMinute =>
      (_asNum(_cfg['messengerVideoHdCentitokensPerParticipantMinute'])?.toInt()) ?? 0;
  static int get messengerVideo2kCentitokensPerParticipantMinute =>
      (_asNum(_cfg['messengerVideo2kCentitokensPerParticipantMinute'])?.toInt()) ?? 0;
  static int get messengerVideo4kCentitokensPerParticipantMinute =>
      (_asNum(_cfg['messengerVideo4kCentitokensPerParticipantMinute'])?.toInt()) ?? 0;
  static int get messengerCallReservationWallSeconds =>
      (_asNum(_cfg['messengerCallReservationWallSeconds'])?.toInt()) ?? 300;
  static int get messengerCallLowBalanceWarningWallSeconds =>
      (_asNum(_cfg['messengerCallLowBalanceWarningWallSeconds'])?.toInt()) ?? 300;
  static int get messengerCallUsageTickSeconds =>
      (_asNum(_cfg['messengerCallUsageTickSeconds'])?.toInt()) ?? 15;
  static int get messengerCallPriceVersion =>
      (_asNum(_cfg['messengerCallPriceVersion'])?.toInt()) ?? 1;

  /// [CALL-PREWARM-1 2026-08-16] P1 of
  /// `Specs/PLAN-CALL-INSTANT-PICKUP-2026-08-16.md`. When true, the callee
  /// begins warming its media path (ICE credentials + SFU seat join) the
  /// moment the incoming-call push lands, so accept only has to publish +
  /// pull instead of building the whole stack cold. Gates
  /// `CallPrewarm.instance.start()` — a no-op while false.
  ///
  /// Declared in `worker/src/routes/config.ts` (PlatformConfig + DEFAULTS) in
  /// the same change, per the fake-flag rule.
  static bool get callPrewarmOnRingV1 => _b('callPrewarmOnRingV1', false);

  /// Main-isolate-only transport prewarm. The background FCM isolate remains
  /// JOIN-only; this permits Flutter foreground to build a datachannel-only PC
  /// and adopt it on Accept. Ships dark until the server contract is enabled.
  static bool get callSilentTransportPrewarmV1 =>
      _b('callSilentTransportPrewarmV1', false);

  /// [CALL-PREWARM-1] P2 of the same plan — caller pre-joins and publishes to
  /// the SFU at ring start. Declared now; not yet read by any client code
  /// (ships as its own change).
  static bool get callerPrejoinOnRingV1 => _b('callerPrejoinOnRingV1', false);

  /// [CALL-PREROLL-1 2026-08-17] Extends [callPrewarmOnRingV1]: the CALLEE
  /// pre-rolls its whole media path during the ring — mic (disabled),
  /// isolated peer connection, silent publish, muted pull — so accept only
  /// has to flip two `enabled` flags instead of running publish+pull cold.
  /// `CallPrewarm` requires BOTH this and [callPrewarmOnRingV1] before doing
  /// any of the extra work; this flag alone is inert.
  ///
  /// Declared in `worker/src/routes/config.ts` (PlatformConfig + DEFAULTS) in
  /// the same change, per the fake-flag rule.
  /// [CALL-PREROLL-RETIRE-1 2026-08-18] Permanently retired. Creating either
  /// local or remote audio while the phone is still ringing can seize Android
  /// audio focus before Accept, and the original implementation could hand a
  /// session back after its SFU seat had already been cleared. Keep the server
  /// key for old-build rollback compatibility, but new builds never execute it.
  static bool get callPrerollV1 => false;

  /// [CALL-RTK-3] Cloudflare RealtimeKit media transport
  /// (`Specs/CALL-REALTIMEKIT-MIGRATION.md` §3.3).
  ///
  /// Precedence at the one fork point in `call_session.dart`:
  /// [callRealtimeKitV1] → RTK meeting join; else [callSfuV1] → legacy raw-SFU;
  /// else P2P. The `rtk-start`/`rtk-abort` frames carry the SAME fallback
  /// semantics as `sfu-start`/`sfu-abort`, so a bad flag flip can never strand
  /// a call — it lands on P2P.
  ///
  /// Declared in `worker/src/routes/config.ts` (PlatformConfig + DEFAULTS) in
  /// the same change, per the fake-flag rule; [callRtkJoinDeadlineSec] also
  /// needs a `numericKeys` entry there or it is un-tunable from KV.
  static bool get callRealtimeKitV1 => _b('callRealtimeKitV1', false);

  /// [CALL-RTK-3] Group conference via RealtimeKit instead of
  /// `CloudflareConferenceController`. Independent of [callRealtimeKitV1] on
  /// purpose: the spec rolls the group path out FIRST (Phase 1, lowest risk).
  static bool get groupRealtimeKitV1 => _b('groupRealtimeKitV1', false);

  /// [CALL-RTK-3] Seconds to wait for the RTK meeting join before self-aborting
  /// to the legacy path. Deliberately a KV number, not a constant: the one
  /// thing we cannot predict without device data is how long a cold RTK join
  /// takes on a bad network, and getting it wrong either strands calls (too
  /// long) or abandons good ones (too short).
  static int get callRtkJoinDeadlineSec =>
      (_asNum(_cfg['callRtkJoinDeadlineSec'])?.toInt()) ?? 10;

  /// [CALL-DEADAIR-1 2026-08-08] Parallelise the call-setup prologue.
  ///
  /// ON (default): the two renderer initialisations, the ICE credential fetch
  /// and the network-class probe run CONCURRENTLY with each other and with
  /// `getUserMedia`, and the SFU transport starts polling for the peer's seat
  /// concurrently with its own publish instead of strictly after it. OFF: the
  /// exact pre-2026-08-08 serial ordering, so a regression is one KV flip away
  /// from being undone with no build.
  ///
  /// Declared in `worker/src/routes/config.ts` (PlatformConfig + DEFAULTS).
  static bool get callSetupParallelBootV1 => _b('callSetupParallelBootV1', true);

  /// [CALL-DEADAIR-1] The 200ms first-inbound-audio probe and the
  /// `call_first_audio_ms` event it emits.
  ///
  /// Pure observability — switching it off changes no call behaviour, it only
  /// blinds the measurement. Kept flippable because it is the one thing in the
  /// call path that polls `getStats()` faster than every 5s, so if it ever shows
  /// up as a battery or jank cost it can be pulled without a release.
  ///
  /// Declared in `worker/src/routes/config.ts` (PlatformConfig + DEFAULTS).
  static bool get callFirstAudioProbeV1 => _b('callFirstAudioProbeV1', true);

  /// [AVA-VM-FALLBACK-1 2026-08-08] An Ava timeout must never end the call.
  ///
  /// ON (default): when the receptionist session opens but produces no audio
  /// inside the ava-live window, the caller's app asks the DO to degrade that
  /// SAME session to the deterministic voicemail flow (cached greeting -> beep
  /// -> record -> the ordinary receptionist `finalize()`), instead of ending the
  /// call with `reason=ava-live-timeout`. OFF: the pre-2026-08-08 behaviour —
  /// the call ends and the message is lost.
  ///
  /// Measured on prod call avatok-946b6090 (2026-08-07 20:52 IST): Ava connected,
  /// said nothing, retried, and the call was hung up on the owner while he was
  /// trying to leave a voicemail. A recording that works beats an assistant that
  /// doesn't.
  ///
  /// Declared in `worker/src/routes/config.ts` (PlatformConfig + DEFAULTS).
  static bool get avaVoicemailFallbackV1 => _b('avaVoicemailFallbackV1', true);

  /// [CALLREC-CORE-1] On-demand call recording (spec
  /// `Specs/FEASIBILITY-CALL-RECORDING-2026-08-04.md`, rev 11).
  ///
  /// MASTER KILL SWITCH — ships OFF, and the server means it: all four
  /// `/api/callrec/*` routes answer **403 `disabled`** while this is false
  /// (`worker/src/routes/callrec.ts`). So flipping it client-side alone gets you
  /// a Record button that captures audio nothing will accept. Both sides read
  /// the SAME key, declared in `PlatformConfig` AND `DEFAULTS`
  /// (`worker/src/routes/config.ts:90/975`) — i.e. it is a REAL flag, not one of
  /// the fake ones CLAUDE.md warns about, and `flags.sh set
  /// callRecordingEnabled=true` will not 400.
  ///
  /// The compile-time fallback is `false` deliberately: a config-fetch failure
  /// must never arm a recorder. This is the one feature where failing open is a
  /// consent problem, not a convenience problem.
  static bool get callRecordingEnabled => _b('callRecordingEnabled', false);

  /// The persistent "Recording" indicator on BOTH call screens (spec §4).
  /// Defaults TRUE and should stay true — with on-demand recording the other
  /// party gets no warning at all until something on screen tells them, and the
  /// indicator is a load-bearing part of the consent story, not decoration.
  /// Exists as a flag only so a rendering bug can be switched off without a
  /// build; turning it off is a deliberate, temporary act.
  static bool get callRecordingIndicatorEnabled =>
      _b('callRecordingIndicatorEnabled', true);

  /// Device free-space floor, in MEGABYTES, below which we refuse to arm
  /// (spec §5.2). NUMERIC — so it is listed in the Worker's `numericKeys`
  /// (`config.ts:1445`); without that entry `flags.sh set
  /// callRecordingMinFreeMb=750` 400s `bad type`.
  ///
  /// Read through [_asNum] like every other numeric getter: a raw
  /// `_cfg[k] as num` throws if the value ever arrives as anything else, whereas
  /// [_asNum] returns null and this falls back to the documented default.
  static num get callRecordingMinFreeMb =>
      _asNum(_cfg['callRecordingMinFreeMb']) ?? 500;

  /// [ADDCALL-1-UI] "Add to call" — turning a live 1:1 into a group call
  /// (spec `Specs/SPEC-ADD-TO-CALL-2026-08-06.md`).
  ///
  /// MASTER KILL SWITCH, and the server means it: both `/api/adhoc-room/create`
  /// and `/api/adhoc-room/add` answer **403 `disabled`** while this is false
  /// (`worker/src/routes/adhoc_room.ts`). Declared in the Worker's
  /// `PlatformConfig` AND `DEFAULTS` (`worker/src/routes/config.ts:119/993`), so
  /// it is a REAL flag — `flags.sh set addToCallEnabled=true` will not 400 —
  /// not one of the fake ones CLAUDE.md warns about.
  ///
  /// The compile-time fallback is `false` deliberately, and while it is false the
  /// Add tile is not rendered at all: the control panel's third row is then
  /// byte-for-byte what it was before this feature existed.
  static bool get addToCallEnabled => _b('addToCallEnabled', false);

  static bool get brainEnabled => _b('brainEnabled', false);
  /// [ONEBRAIN-B4] Global kill-switch for cloud reasoning over device_private
  /// brain content (SPEC §6, B-D6). Default TRUE (owner decision 2026-07-18:
  /// cloud reasoning is allowed; the per-account "Local-only answers" toggle is
  /// the opt-out). When flipped FALSE in KV it behaves like every account has the
  /// toggle ON — `brainRecall(forCloud: true)` strips device_private hits for
  /// everyone, so no on-device excerpt ever reaches a cloud model. Declared in
  /// worker/src/routes/config.ts (PlatformConfig + DEFAULTS, per the fake-flag
  /// rule) so it is a real, flippable flag — the server agent adds it there.
  static bool get cloudReasoningOverPrivate => _b('cloudReasoningOverPrivate', true);
  static bool get verseEnabled => _b('verseEnabled', false);
  static bool get translationEnabled => _b('translationEnabled', false);
  /// 1:1 call translation is separately gated from marketplace/live translation.
  /// Both this flag and [translationEnabled] must be true at runtime.
  static bool get callTranslationEnabled => _b('callTranslationEnabled', false);
  static bool get translationGroupEnabled => _b('translationGroupEnabled', false);
  static bool get avavoiceEnabled => _b('avavoiceEnabled', false);
  static bool get avavisionEnabled => _b('avavisionEnabled', false);
  // STREAM G (AI in chats). Mirrors config.ts flags of the same name.
  /// [GROUP-AI-2] per-member group translation (translate on fetch). Default OFF
  /// (cost watch) — the "Translate this group for me" toggle is hidden while off.
  static bool get groupTranslationEnabled => _b('groupTranslationEnabled', false);
  /// [GROUP-AI-4] DM smart-reply suggestion chips. Default ON.
  static bool get smartRepliesEnabled => _b('smartRepliesEnabled', true);
  /// [GROUP-AI-6] auto scam-scan a stranger thread on first render. Default ON.
  static bool get scamAutoScanEnabled => _b('scamAutoScanEnabled', true);
  /// STREAM I (AI Messenger Batch): unlimited forwarding + forward-to-groups.
  /// Master kill switch for the whole forwarding feature — the multi-select
  /// forward sheet and the /api/msg/forward route both gate on this. Default ON
  /// (per spec FWD-4); flip OFF in KV to fall back to hiding Forward if abuse
  /// ever spikes. Mirrors config.ts `unlimitedForwardEnabled`.
  static bool get unlimitedForwardEnabled => _b('unlimitedForwardEnabled', true);
  /// FREE LAUNCH: no paywalls. When true, the whole client renders premium and
  /// no upgrade/metering UI shows. Mirrors KV `betaFreePremium`.
  static bool get betaFreePremium => _b('betaFreePremium', true);
  /// FREE LAUNCH: subscriptions/checkout off. When false, hide Subscribe/upgrade
  /// + wallet top-up entry points. Mirrors KV `billingEnabled`.
  static bool get billingEnabled => _b('billingEnabled', false);
  /// AI receptionist (Gemini Live) — ON for the free launch. Mirrors KV.
  static bool get receptionistEnabled => _b('receptionistEnabled', true);

  /// [AVACALL-VMFREE-1] FREE AvaTOK↔AvaTOK auto-voicemail (owner decision, Phase
  /// WS2). Mirrors config.ts `avatokVoicemailFree`, which DECLARES this key in
  /// BOTH PlatformConfig and DEFAULTS (default true) — without that declaration
  /// putConfig would 400 `unknown key` and this kill switch could never actually
  /// be pulled (the inAppUpdateEnabled trap, CLAUDE.md 2026-07-15).
  ///
  /// When an AvaTOK→AvaTOK AUDIO call is rejected / unanswered / phone-off and
  /// the callee has NO active AI receptionist, the caller auto-fires a
  /// pre-recorded generic voicemail (greeting → beep → ~25s record) instead of a
  /// silent 'timeout-ringing' teardown. FREE for everyone — deliberately NOT
  /// gated by the paid `voicemailBot`/`businessCallUx`.
  ///
  /// Defaults TRUE: this is a free fallback that only fires AFTER the ring window
  /// has already elapsed with no answer, so a config-fetch failure falling back
  /// to "offer a voicemail" is the safe, user-friendly side. Flip false in KV to
  /// restore the silent no-answer teardown without a build.
  static bool get avatokVoicemailFree => _b('avatokVoicemailFree', true);

  /// [VM-KILL-1] GLOBAL voicemail master switch (owner decision 2026-07-21).
  /// Mirrors config.ts `voicemailEnabled`, DECLARED in BOTH PlatformConfig and
  /// DEFAULTS (default true) so it is a real, flippable KV kill switch (not an
  /// unknown-key trap). Default TRUE = voicemail available (no behavior change).
  /// When flipped FALSE, the client stops auto-firing the free AvaTOK↔AvaTOK
  /// voicemail on no-answer and the "AI receptionist" settings hide every
  /// voicemail affordance — the receptionist (opt-in per lane) is the only
  /// unanswered-call handler. Server enforces the same kill on every voicemail
  /// route, so an old app build is covered even without this getter.
  static bool get voicemailEnabled => _b('voicemailEnabled', true);
  /// [AVA-CAMP-FL-NAV] Outbound AI-calling campaigns — master switch for the
  /// whole feature (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md). Key already
  /// declared in worker DEFAULTS (worker/src/routes/config.ts
  /// `campaignsEnabled`, default false) and enforced server-side by every
  /// `/api/campaigns*` route's `gate()` — this getter is a real, flippable
  /// kill switch, not a client-only flag. Gates the "Campaigns"/"Analytics"
  /// settings entries; off by default until the dialer + billing path is
  /// verified in staging.
  static bool get campaignsEnabled => _b('campaignsEnabled', false);
  /// [INSTANT-CALL-MOUNT-1] When ON, tapping the audio/video call icon in a 1:1
  /// chat thread opens the CallScreen IMMEDIATELY and runs POST /api/call in the
  /// BACKGROUND (instead of awaiting the ~server round-trip before showing any
  /// UI, which made the call screen take seconds to appear). The optimistically-
  /// mounted session runs the honest guard flow (connecting + searching tone, no
  /// fake ringback) and the reachability/glare outcome is fed back once the POST
  /// resolves. Kill switch: flip to false in KV to restore the awaited path
  /// everywhere with no rebuild. Mirrors config.ts.
  static bool get instantCallMountEnabled => _b('instantCallMountEnabled', true);
  /// [BUSY-CARD-1] Personalized busy card (Cancel / Notify me / Leave a message
  /// for Ava) shown when a call resolves to 'busy'. Client kill switch mirroring
  /// the server's busy-card flag. The card ALSO requires the server to send a
  /// `busy_reason` on the busy status — so even with this ON, an old server that
  /// sends no reason falls back to the plain "User is busy" line. Default ON;
  /// flip to false in KV to force legacy behaviour everywhere. Mirrors config.ts.
  static bool get busyCardEnabled => _b('busyCardEnabled', true);
  /// CALL OUTCOME MENU (Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md): one unified
  /// caller-facing menu for every non-answered call (declined / no-answer /
  /// unreachable / busy). Talk to Ava, voice note, text note, See Listings.
  /// Ships DARK (default false); flip callMenuEnabled=true in KV to activate.
  /// Mirrors config.ts.
  static bool get callMenuEnabled => _b('callMenuEnabled', false);
  /// "See Listings" button on the call outcome menu — OFF until the marketplace
  /// goes public (owner 2026-07-09). Mirrors config.ts.
  static bool get callMenuListingsEnabled => _b('callMenuListingsEnabled', false);
  /// MKT-LANG (AI Messenger Batch, STREAM A): the "Marketplace Agent" settings
  /// surface (default language/voice/tone + negotiation guardrails). Default ON;
  /// the settings tile hides when false. Mirrors config.ts.
  static bool get marketplaceAgentSettingsEnabled => _b('marketplaceAgentSettingsEnabled', true);
  /// MKT-LANG-3: English-canonical negotiation + per-recipient translation +
  /// quiet-hours/floor/ask-before-commit guardrails. Default ON. Mirrors config.ts.
  static bool get mktI18nNegotiationEnabled => _b('mktI18nNegotiationEnabled', true);
  /// P1 call-reliability: gate the caller's Ava-takeover countdown on the server's
  /// ring-ack (incoming-call FCM push outcome). Ships dark (default OFF); flip in
  /// KV after a device test. Mirrors config.ts `receptTakeoverGuard`.
  static bool get receptTakeoverGuard => _b('receptTakeoverGuard', false);
  /// [AVA-PREWARM-1] Pre-warm the AI receptionist (HTTP /start + WS + mic +
  /// engine) in the background while the outgoing ringback is still playing,
  /// so a taken-over call's audio is already flowing instead of starting cold
  /// after the ring window ends — the fix for the 10-11.5s silent gap between
  /// ringback stopping and Ava's first audio (prod ava_recept_first_audio
  /// ms=9801/11461). Declared in worker/src/routes/config.ts (PlatformConfig +
  /// DEFAULTS, per the fake-flag rule) so it is a real, flippable switch.
  /// Default TRUE; flip false in KV to fall back to the cold post-ring start
  /// with no rebuild.
  static bool get avaPrewarmEnabled => _b('avaPrewarmEnabled', true);
  /// P4: require video-liveness verification before creating/publishing a listing.
  /// Ships dark (default OFF); flip ON at launch. Mirrors config.ts.
  static bool get listingLivenessGate => _b('listingLivenessGate', false);
  /// Liveness V2 (Specs/LIVENESS-V2-PLAN.md): the ML-Kit-gated, detection-driven
  /// selfie-video flow that replaces the timer-script V1. Ships DARK (default
  /// OFF); while off the V1 [LivenessCheckScreen] is used unchanged. Flip
  /// `livenessV2Enabled: true` in KV `platform_config` once V2 pass-rate is
  /// proven. Mirrors config.ts.
  static bool get livenessV2Enabled => _b('livenessV2Enabled', false);
  /// Liveness V3 (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-DRAFT.md): the voice-guided
  /// flow — language picker, on-device ML Kit coaching with pre-recorded Ava voice
  /// packs, server-randomized challenges, per-stage no-dead-screen watchdog, and
  /// background upload to presigned R2. Ships DARK (default OFF); while off the V2
  /// [LivenessV2Screen] (or V1) is used unchanged. Flip `livenessV3Enabled: true`
  /// in KV `platform_config` once V3 pass-rate is proven. Mirrors config.ts. Takes
  /// precedence over V2 when both are on.
  static bool get livenessV3Enabled => _b('livenessV3Enabled', false);
  /// [LIVE-DIDIT-1] didit.me-hosted liveness (owner decision 2026-07-09) — THE
  /// live path; takes precedence over v3/v2/v1. Default TRUE (this is the
  /// pipeline now); the flag exists only as a kill switch. Mirrors config.ts.
  static bool get diditLivenessEnabled => _b('diditLivenessEnabled', true);
  // [AVA-IDGATE-1] livenessOnboardingGate getter REMOVED. The onboarding/app-open
  // liveness gate (HumanCheckPage + _landOrGate) is gone; liveness fires at the first
  // public action, enforced server-side. Nothing on the client reads this any more.
  /// P11: mandatory + AI-vetted profile completion. Default ON: an incomplete
  /// or unapproved profile is routed to the Profile screen
  /// before the app, and the save shows a hold state while the server vets. Mirrors config.ts.
  static bool get profileCompletionGate => _b('profileCompletionGate', true);
  /// P8 Stage 3: daily auto-backup to the user's OWN Google Drive — ON for ALL
  /// users (no premium gate). Flip OFF in KV to disable the daily job.
  static bool get driveAutoBackup => _b('driveAutoBackup', true);
  /// P8 Stage 2: lazily page older history from R2 beyond the hot window. Dark.
  static bool get restoreV2 => _b('restoreV2', false);
  /// ChatAVA "talk to Ava by voice" — the hands-free Gemini Live call
  /// (LiveVoiceController). Owner kill switch (2026-06-27): default OFF so the
  /// feature stays dark after a config-fetch failure and can't burn the shared
  /// Gemini Live quota. NOTE: distinct from [avavoiceEnabled] (the AvaVoice
  /// studio/agents app). [AI-FLAG-CONTRACT-1] 2026-07-25: `aiVoiceCallEnabled`
  /// is now declared in the Worker's `PlatformConfig`/DEFAULTS (routes/config.ts,
  /// default false) — it was previously a fake flag (this docstring told the
  /// reader to flip it in KV, but `putConfig` 400'd `unknown key` because the
  /// Worker never declared it; see CLAUDE.md "FAKE FLAGS", ROOT-CAUSE §18). It
  /// is a genuinely flippable switch now: `scripts/flags.sh set
  /// aiVoiceCallEnabled=true` re-enables it. Premium still applies on top of
  /// this when the switch is on.
  static bool get aiVoiceCallEnabled => _b('aiVoiceCallEnabled', false);
  /// AvaAffiliate (PROPOSAL-AVA-AFFILIATE) — default OFF until launch, so a
  /// config-fetch failure never advertises a program the Worker isn't serving.
  static bool get avaAffiliateEnabled => _b('avaAffiliateEnabled', false);
  /// v2 marketing-asset kit (Gemini Nano Banana 2 promo images) — default OFF.
  static bool get affiliateAssetKitEnabled => _b('affiliateAssetKitEnabled', false);
  /// AI Ringback Tones + Busy Tone — master switch (server panic off). Default
  /// mirrors kRingbackEnabledDefault so a fetch failure keeps the feature on.
  static bool get ringbackEnabled => _b('ringbackEnabled', kRingbackEnabledDefault);
  /// Call-reliability program (Specs, 2026-07-24) — rollout flags for the
  /// call-audio/ICE/relay-migration/receptionist-reconnect work. All default
  /// OFF; flipped one at a time per milestone via KV once device-verified.
  static bool get callAudioControllerV2 => _b('callAudioControllerV2', false);
  static bool get callPlayoutHealthV2 => _b('callPlayoutHealthV2', false);
  static bool get callIceRecoveryV2 => _b('callIceRecoveryV2', false);
  static bool get callRelayMigrationV1 => _b('callRelayMigrationV1', false);
  static bool get callQosAdaptV1 => _b('callQosAdaptV1', false);
  static bool get callCellPresetV1 => _b('callCellPresetV1', false);
  static bool get callQualityIndicatorV1 => _b('callQualityIndicatorV1', false);
  static bool get callAudioRedExperimentV1 => _b('callAudioRedExperimentV1', false);
  static bool get callVideoDegradeV1 => _b('callVideoDegradeV1', false);
  /// [CALL-VIDEO-RENDER-WATCH-1] Self-heal a frozen remote video: when inbound
  /// video is decoding but the renderer holds a different (stale) track for two
  /// consecutive health samples, rebind the renderer to the live track.
  /// Declared in worker config.ts DEFAULTS (true) — kill switch for the heal.
  static bool get callVideoRenderHealV1 => _b('callVideoRenderHealV1', true);
  /// [CALL-AUDIO-OWNER-1 2026-08-07] `CallAudioController` becomes THE single
  /// owner of call route/mode/speaker, replacing the hardcoded `selectRoute`
  /// at the end of `_bootMedia` and the flag-off `Helper.setSpeakerphoneOn`
  /// branch that raced the user's own Speaker press. Defaults ON — this is a
  /// bug fix (loud→quiet→loud outgoing tone), not an experiment; flip to
  /// false only to roll back if a device regresses. The server key
  /// `callAudioOwnerV1` IS now declared in `worker/src/routes/config.ts`
  /// (PlatformConfig + DEFAULTS, added under [CALL-RING-FASTPATH-1]), so this
  /// is a real flag: until then it was a FAKE one — `putConfig` would have
  /// 400'd `unknown key` and the `true` fallback below was its permanent value.
  static bool get callAudioOwnerV1 => _b('callAudioOwnerV1', true);

  /// [CALL-AUDIBLE-1 2026-08-17] Honest user-visible "connected" state.
  /// `_connected` (media path established) and everything it triggers today —
  /// timers, watchdogs, ringback stop, talk-time start, receptionist abort,
  /// glare clear — is UNCHANGED by this flag. It only gates a later,
  /// presentational milestone (`CallSession.audibleReady`) that the UI reads
  /// to show "Connecting audio…" and hold the call timer until real inbound
  /// audio is confirmed. Declared in `worker/src/routes/config.ts`
  /// (PlatformConfig + DEFAULTS, default false — see [CALL-AUDIO-OWNER-1]
  /// comment above for why an undeclared key is a fake flag). Default false:
  /// flag-off mirrors `_connected` immediately, so this is a no-op today.
  static bool get callAudibleStateV1 => _b('callAudibleStateV1', false);

  /// [CALL-PRESENCE-1 2026-08-07] Presence-first call routing + the device
  /// heartbeat that feeds it.
  ///
  /// Before this there was NO heartbeat anywhere: "presence" was a side effect
  /// of the call ring landing on an open InboxDO socket, discovered ~3.6 s into
  /// placing a call and then thrown away. The 25 s SyncHub ping does not help —
  /// the DO answers it from its hibernation auto-response, so it never wakes the
  /// DO and refreshes nothing.
  ///
  /// When true the device POSTs `/api/presence/beat` on connect, resume, FCM
  /// receipt and every ping tick, and `/api/call` reads that record BEFORE its
  /// Durable Object round-trips. All three keys are declared in
  /// `worker/src/routes/config.ts` (PlatformConfig + DEFAULTS, and the two
  /// numeric ones in `numericKeys`), so they are genuinely flippable.
  static bool get callPresenceRouting => _b('callPresenceRouting', true);

  /// How long a beat counts as fresh, seconds. Server mirror: `presenceFreshSec`.
  static int get presenceFreshSec =>
      (_asNum(_cfg['presenceFreshSec'])?.toInt()) ?? 90;

  /// Beat cadence, seconds. The beat rides the existing 25 s SyncHub ping tick,
  /// so values below 25 simply beat on every tick. Server: `presenceHeartbeatSec`.
  static int get presenceHeartbeatSec =>
      (_asNum(_cfg['presenceHeartbeatSec'])?.toInt()) ?? 25;

  /// [CALL-4RINGS-1 2026-08-08] Report EVERY ring cycle, so Ava takes over after
  /// four REAL rings instead of at a wall-clock alarm.
  ///
  /// The callee side of this: `PushService.reportRinging` stops being a one-shot
  /// and repeats with a monotonic `ringIndex` while the incoming-call UI is
  /// genuinely ringing. The CallRoom counts the audible ones and hands over at
  /// `receptionistRings`. With this false the receipt is a one-shot exactly as
  /// before and the server falls back to the 20 s deadline.
  ///
  /// Declared in `worker/src/routes/config.ts` (PlatformConfig + DEFAULTS), and
  /// [ringCycleMs] additionally in `numericKeys`, so neither is a fake flag.
  static bool get callRealRingCount => _b('callRealRingCount', true);

  /// Assumed length of one ring cycle, ms. Android exposes no per-cycle callback
  /// for the OS ringtone, so this is what the cycle timer is seeded with and why
  /// those receipts are stamped `derived: true`. Server mirror: `ringCycleMs`.
  static int get ringCycleMs => (_asNum(_cfg['ringCycleMs'])?.toInt()) ?? 6000;

  /// [STREAM-RECEPTIONIST-1 2026-08-24] How many unanswered ring cycles before
  /// Ava takes the call. The LEGACY lane never needed this client-side — the
  /// CallRoom DO owns the count there and tells the client via the
  /// `device-ringing` frame's `ringsRequired`. The Stream lane has no CallRoom
  /// and no ring receipts, so the CALLER's phone has to time the ring window
  /// itself, and that needs the number locally.
  ///
  /// Declared server-side in `worker/src/routes/config.ts` (PlatformConfig,
  /// DEFAULTS = 4, and `numericKeys` because it is numeric), so this is a real
  /// flag and not a fake one — `flags.sh set receptionistRings=6` works.
  /// Clamped so a bad override can neither hand off instantly nor never.
  static int get receptionistRings {
    final v = (_asNum(_cfg['receptionistRings'])?.toInt()) ?? 4;
    return v < 1 ? 1 : (v > 12 ? 12 : v);
  }

  /// [CALL-VIDEO-CODEC-1] Express a video codec preference (AV1 > VP9 > VP8 >
  /// H264) and request temporal SVC (L1T3) on the 1:1 video sender.
  ///
  /// Ships dark. Video is currently a second-class path here — every
  /// `CallConfig` construction in the app passes `video: false` — so this
  /// changes the wire format of a feature with almost no traffic, and the blast
  /// radius of a bad codec ordering (a call that negotiates a codec the device
  /// cannot hardware-encode) is a black or frozen picture. Turn it on
  /// deliberately, after a real video call has been verified end to end.
  static bool get callVideoCodecPrefV1 => _b('callVideoCodecPrefV1', false);
  static double get callVideoLossDegradePct => (_asNum(_cfg['callVideoLossDegradePct']) ?? 8).toDouble();
  static double get callVideoLossPausePct => (_asNum(_cfg['callVideoLossPausePct']) ?? 20).toDouble();
  static int get callVideoStableSamples => (_asNum(_cfg['callVideoStableSamples'])?.toInt()) ?? 3;
  static double get callQosHeadroomFactor => (_asNum(_cfg['callQosHeadroomFactor']) ?? 1.5).toDouble();
  static double get callQosLossDownshiftPct => (_asNum(_cfg['callQosLossDownshiftPct']) ?? 8).toDouble();
  static double get callQosStableLossPct => (_asNum(_cfg['callQosStableLossPct']) ?? 1).toDouble();
  static int get callQosStableRttMs => (_asNum(_cfg['callQosStableRttMs'])?.toInt()) ?? 180;
  static int get callQosStableSamples => (_asNum(_cfg['callQosStableSamples'])?.toInt()) ?? 3;
  static bool get receptionistReconnectV1 => _b('receptionistReconnectV1', false);
  static bool get callRingAudibilityV1 => _b('callRingAudibilityV1', false);
  /// [CALL-SURVIVE-1 2026-08-04] Handover-survival tunables. Declared in the
  /// Worker's DEFAULTS + numericKeys in the SAME change (fake-flag rule) so
  /// they are flippable from KV without a client build. Defaults mirror the
  /// server: 12s ICE-recovery deadline, 8s relay-migration deadline, 5 retry
  /// attempts (2/4/8/16/30s backoff) before the ladder rests in `reconnecting`.
  static int get callRecoveryDeadlineSec =>
      (_asNum(_cfg['callRecoveryDeadlineSec'])?.toInt()) ?? 12;
  static int get callMigrationDeadlineSec =>
      (_asNum(_cfg['callMigrationDeadlineSec'])?.toInt()) ?? 8;
  static int get callRecoveryMaxAttempts =>
      (_asNum(_cfg['callRecoveryMaxAttempts'])?.toInt()) ?? 5;
  /// In-chat AI image generation (ChatAVA "make an image"). Server kill switch —
  /// reads the Worker's key EXACTLY, `generativeEnabled` (routes/config.ts,
  /// enforced in routes/ava_image.ts). [AI-FLAG-CONTRACT-1] 2026-07-25: this
  /// getter used to read a client-only key, `imageGenEnabled`, which the Worker
  /// never declared in DEFAULTS — `putConfig` rejected it (`unknown key`, 400),
  /// so it could never be flipped and every tap made a real POST straight into a
  /// 503 `generative_disabled` (see CLAUDE.md "FAKE FLAGS", ROOT-CAUSE §18). Do
  /// NOT reintroduce a differently-named alias. When false the client
  /// short-circuits every image request to a canned "coming soon" reply WITHOUT
  /// a network call (see ava_generative/image_tool.dart). Compile-time fallback
  /// [kGenerativeEnabledDefault] only applies on a config-fetch failure.
  static bool get generativeEnabled => _b('generativeEnabled', kGenerativeEnabledDefault);
  /// [PIVOT-AI-SWITCHES-1] "Discuss this chat with Ava" — the entry point in the
  /// thread overflow menu (features/avatok/chat_thread/menus.dart). Until
  /// 2026-08-27 this was gated ONLY by the compile-time const
  /// [kDiscussWithAvaEnabled], so turning it off needed a new APK and a store
  /// rollout — there was no KV path at all. The marketplace-first pivot requires
  /// AI-in-chat to go dark remotely, so it now has a real declared flag.
  /// Default TRUE deliberately: shipping the switch must not by itself change
  /// behaviour. The dark-ing is a separate, explicit prod flip.
  /// The compile const stays as the config-fetch-failure fallback, and the menu
  /// keeps its existing AvaBrain DM/group consent check at use — this flag is a
  /// third gate on top, never a replacement for consent.
  static bool get discussWithAvaEnabled =>
      _b('discussWithAvaEnabled', kDiscussWithAvaEnabled);
  /// [PIVOT-AI-SWITCHES-1] AskAva — the standalone Ava surface mounted from
  /// shell/shell_v2.dart. It had NO flag of any kind and was only accidentally
  /// dark because `shellV2` is false in prod. That made it a live hazard for the
  /// pivot: flipping `shellV2` on to put Marketplace on the landing screen would
  /// have shipped AskAva with no way to turn it off. Default TRUE for the same
  /// reason as above — the switch itself is behaviour-neutral; the flip is not.
  static bool get askAvaEnabled => _b('askAvaEnabled', true);
  /// Guardian (scam/grooming/deepfake safety) surfaces + settings section.
  /// Mirrors the compile default [kGuardianEnabledDefault]. When false the
  /// Guardian settings section is not registered and the per-chat shield icon is
  /// hidden. Live (pro) build sets `guardianEnabled:false` in prod KV.
  static bool get guardianEnabled => _b('guardianEnabled', kGuardianEnabledDefault);
  /// U1-lite (Guardian Sentinel §U1): MANUAL "Require verification" gate. When ON,
  /// the guardian settings sheet shows a "Require verification" row for 1:1 chats
  /// that asks the peer to complete a live face check (Trust Engine liveness).
  /// Fully DARK by default (server modes 403 `feature_off`; the client row is
  /// hidden). Mirrors config.ts `guardianGateEnabled`. Flip ON in KV platform_config.
  static bool get guardianGateEnabled => _b('guardianGateEnabled', false);
  /// AvaMarketplace (buy/sell/social + agent negotiation, Specs/AVAMARKETPLACE-
  /// FINAL-PROPOSAL.md). Default OFF so the feature stays dark after a config
  /// fetch failure and during phased rollout — flip `marketplaceEnabled: true`
  /// in KV `platform_config` to surface the Marketplace menu + agent calls.
  static bool get marketplaceEnabled => _b('marketplaceEnabled', false);

  /// [MKT2] AI-chat listing creation (PLAN-2026-07-17 §3). When ON, "Create
  /// listing" opens the AI compose chat instead of the 6-step form. Default OFF
  /// (mirrors config.ts `aiComposeEnabled`); the form stays as the fallback (M-D7)
  /// until the compose funnel proves out. Separate from `marketplaceEnabled` on
  /// purpose — compose can be dark while the marketplace itself is live.
  static bool get aiComposeEnabled => _b('aiComposeEnabled', false);

  /// Effective Marketplace visibility for the CURRENT account. The global
  /// `marketplaceEnabled` KV flag stays false during the phased/pro launch, so
  /// ordinary testers never see the Marketplace. Admins (see [isAdmin]) get it
  /// regardless, so the operator can dogfood + fix it in production while it
  /// stays hidden for everyone else. Toggle it per-tester by adding/removing
  /// their uid from the server ADMIN_UIDS var; flip `marketplaceEnabled: true`
  /// in KV `platform_config` for the eventual full launch to all users.
  static bool get marketplaceVisible => marketplaceEnabled || _isAdmin;
  /// DNS-over-HTTPS fallback (PERF-DNS-2): resolve our hostnames via 1.1.1.1 when
  /// the device resolver fails. Default ON (works before the first config fetch);
  /// this is a kill switch — set `dohFallbackEnabled: false` in KV to force pure
  /// OS resolution if the fallback ever misbehaves. Applied to [AvaDns] in refresh().
  static bool get dohFallbackEnabled => _b('dohFallbackEnabled', true);
  /// Link previews + inline YouTube (AI Messenger Batch — STREAM C). Mirrors the
  /// KV `linkPreviewsEnabled` flag. Default ON. When false the chat renders raw
  /// link text only and never calls /api/unfurl. Mirrors [kLinkPreviewsEnabledDefault].
  static bool get linkPreviewsEnabled => _b('linkPreviewsEnabled', kLinkPreviewsEnabledDefault);
  /// WhatsApp-parity rich input bar + emoji/GIF/sticker panel (AI Messenger
  /// Batch — STREAM E). Mirrors the KV `richInputEnabled` flag. Default ON. When
  /// false the chat falls back to the legacy composer row (no emoji/GIF/sticker
  /// panel, no GIF/sticker send). Add `richInputEnabled: true` to the config.ts
  /// PlatformConfig interface + defaults so it can be flipped from KV.
  static bool get richInputEnabled => _b('richInputEnabled', true);
  /// STREAM B (stranger safety gate). When false the whole feature is hidden: a
  /// new non-contact thread renders the normal composer (no gate), no Message
  /// requests grouping, no media blur. Default OFF: every sender lands in the
  /// ordinary chat list. Mirrors
  /// config.ts `strangerGateEnabled`.
  static bool get strangerGateEnabled => _b('strangerGateEnabled', false);
  // DIALPAD BUSINESS CALLS + AVA VOICE AGENT (Specs/PLAN-2026-07-11-dialpad-
  // business-calls-ava-voice-agent.md §8/§15.6). One kill switch per phase;
  // all default OFF so a config-fetch failure keeps today's behaviour exactly
  // as-is. Staging first; prod flipped one at a time on the owner's say-so.
  /// Phase A — the friend/business channel split: email-only new-chat search,
  /// tappable AvaTOK numbers → dialpad, the no-answer card, and the named
  /// incoming-business-call screen. Mirrors config.ts `businessCallUx`.
  static bool get businessCallUx => _b('businessCallUx', false);
  /// [AVACALL-INUI-1] Use the branded IncomingBusinessCallScreen (avatar +
  /// Accept/Decline/Block/Send-to-Ava) for ALL AvaTOK incoming calls — friend
  /// AND business — instead of only dialpad business calls, and raise it over
  /// the lock screen via a full-screen intent when the app isn't foregrounded.
  /// Default TRUE (owner decision 2026-07-20 — the cheap native CallKit green
  /// screen was the "friend call looks unbranded" tell). Flip false in KV to
  /// fall back to native CallKit everywhere. Mirrors config.ts `brandedIncomingUi`.
  static bool get brandedIncomingUi => _b('brandedIncomingUi', true);
  /// [ONERING-1 2026-08-02] When the app is ALREADY FOREGROUNDED and we push the
  /// branded incoming-call screen onto the live navigator, skip registering the
  /// native CallKit ring so the OS heads-up banner (its own Decline/Answer pair)
  /// does not appear on top of our own screen. Two call UIs for one call, each
  /// with its own Decline, is the "why do I have to decline twice" report.
  ///
  /// ONLY affects the foreground case. Locked / backgrounded / screen-off rings
  /// are untouched: CallKit still owns those, and it remains the fallback
  /// wherever a full-screen intent is denied — that is load-bearing and must
  /// stay. Mirrors config.ts `suppressOsRingInForeground`.
  ///
  /// Kill switch: set false in KV to restore the double-surface behaviour
  /// instantly, with no build.
  static bool get suppressOsRingInForeground =>
      _b('suppressOsRingInForeground', true);

  /// [CALL-REL-R4-B 2026-08-03] Relaxed "is the app actually in front" test.
  ///
  /// [suppressOsRingInForeground] only ever fires when we believe the branded
  /// screen is about to own the surface, and that belief used to be the exact
  /// equality `lifecycle == 'resumed'`. Android does not cooperate: the moment
  /// CallKit's own full-screen-intent activity starts launching over an open
  /// app, MainActivity reports `paused` — so on a real prod call the ring saw
  /// `os_ring_suppressed=false lifecycle=paused`, registered CallKit *and*
  /// showed the branded screen, and the OS notification was still sitting in the
  /// shade when the user accepted. That is the "ring appears in the header after
  /// I answer" report.
  ///
  /// V2 accepts `inactive` and a briefly-`paused` app as still-in-front, and —
  /// because guessing wrong here would mean NO ring at all — arms a short
  /// verification fallback that registers CallKit after all if the app turns out
  /// not to be in front. Worst case is a slightly late OS ring, never a silent
  /// one. Mirrors config.ts `foregroundRingDetectionV2`.
  ///
  /// Kill switch: set false in KV to restore the strict equality, no build.
  static bool get foregroundRingDetectionV2 =>
      _b('foregroundRingDetectionV2', true);

  /// [NOTIF-STYLE-1 2026-08-17] Draw incoming chat messages as a per-conversation
  /// Android MessagingStyle stack — one notification per chat, bundled under a
  /// "N messages from M chats" summary, each expandable on its own chevron with
  /// the sender's photo — instead of the single shared banner AvaTOK posted under
  /// the one hardcoded id 8000 (where a second person's message REPLACED the
  /// first rather than stacking beside it).
  ///
  /// Default TRUE; false restores the legacy single BigText banner exactly.
  /// Read from the BACKGROUND isolate too, which is why push_service.dart calls
  /// [hydrateFromDisk] before consulting it — nothing else hydrates config there,
  /// so the getter would otherwise always return this compile-time default on the
  /// path that matters most. Mirrors config.ts `notifMessagingStyle`.
  static bool get notifMessagingStyle =>
      _b('notifMessagingStyle', true);

  /// [NOTIF-ACTIONS-1 2026-08-17] Put Reply / Mark as read / Mute on message
  /// notifications, so a message can be answered from the shade without opening
  /// AvaTOK — and, as a side effect, so Android's on-device Smart Reply offers
  /// its "Okay / Thanks" chips (it only does so for a MessagingStyle
  /// notification that carries a RemoteInput reply action).
  ///
  /// The reply is posted from a headless isolate via bootstrapBackgroundIsolate,
  /// so this is also the brake if that path ever misbehaves in the field.
  /// Default TRUE; false renders the same stacked cards with no buttons.
  /// Mirrors config.ts `notifQuickActions`.
  static bool get notifQuickActions =>
      _b('notifQuickActions', true);

  /// [NOTIF-REACT-1 2026-08-17] Notify the AUTHOR of a message when someone
  /// reacts to it. Owner decision 2026-08-17: every reaction, 1:1 and groups
  /// alike, foreground and background — no throttling. Mute (NOTIF-ACTIONS-1) is
  /// the escape hatch if a busy group gets noisy.
  ///
  /// Before this, reactions were a transient socket frame only: they were never
  /// persisted and never pushed, so a reaction to a sleeping phone simply did
  /// not exist. Default TRUE. Mirrors config.ts `notifReactions`.
  static bool get notifReactions =>
      _b('notifReactions', true);

  /// Phase B — the server-side voicemail bot (5-rings → prompt → 25s record).
  /// Mirrors config.ts `voicemailBot`.
  static bool get voicemailBot => _b('voicemailBot', false);
  /// Legacy compatibility getter. Owner decision 2026-08-02 permanently made
  /// human audio/video calls free; stale cached config must never reopen the
  /// paid-call prompt before the next remote-config refresh.
  static bool get paidCalls => false;
  /// Phase C — the Ava AI Voice Agent (Grok realtime session). Gates the
  /// "Send to Ava AI Agent" option on the incoming-business-call screen.
  /// Mirrors config.ts `voiceAgent`.
  static bool get voiceAgent => _b('voiceAgent', false);
  /// Phase C — additional caller-pays AvaTOK service numbers (Mode B only).
  /// Mirrors config.ts `serviceNumbers`.
  static bool get serviceNumbers => _b('serviceNumbers', false);
  /// Home · AvaDial · AvaTalk · Services 4-root shell (Specs/PLAN-2026-07-12-home-
  /// ava-tok-services-shell.md, Phase 1). Ships DARK (default false): while off the
  /// app renders today's messenger-first [AvaShell] byte-for-byte. Flip
  /// `shellV2: true` in KV `platform_config` (staging first) to switch to
  /// [ShellV2]. Mirrors config.ts `shellV2`.
  static bool get shellV2 => _b('shellV2', false);

  /// AvaDial PSTN dialer (Specs/PLAN-2026-07-12-home-ava-tok-services-shell.md §4,
  /// Phase 2b + Specs/SPIKE-2026-07-12-avadial-telecom.md). Ships DARK (default
  /// false): while off the AvaDial tabs render the Phase-1 placeholder empty states
  /// and NO telecom role is ever requested. Flip `avaDialer: true` in KV
  /// `platform_config` (staging first) to surface the device Contacts/Logs tabs, the
  /// block list, the "Make Ava your phone app" onboarding, the red/green/blue PSTN
  /// call screens and the CallScreeningService. Mirrors config.ts `avaDialer` (served
  /// by the worker). Default false so a config-fetch failure keeps AvaDial inert.
  static bool get avaDialer => _b('avaDialer', false);

  /// [AVADIAL-NATIVE-INCALL-1] Native in-call screen (owner decision 2026-07-15).
  /// Mirrors config.ts `nativeInCallUi`. While FALSE, answering a PSTN call hands
  /// off to MainActivity and [InCallScreen] exactly as today. While TRUE the native
  /// InCallActivity takes over and Flutter never enters the call path — no engine
  /// boot, no Keystore, no Firebase/PostHog init, no 3s shell gate.
  ///
  /// Native cannot read this class (it runs with no engine), so ShellV2 mirrors the
  /// resolved value to <filesDir>/avadial/native_ui.json via
  /// [AvaDialChannel.setNativeInCallEnabled]. A missing mirror reads as OFF.
  ///
  /// Default OFF: this is the answer path that broke prod testers on 2026-07-14.
  static bool get nativeInCallUi => _b('nativeInCallUi', false);

  /// [CALL-NATIVE-ANSWER-1] Interactive native "ring screen" (caller name +
  /// Accept/Decline) MainActivity paints the instant the incoming-call
  /// notification is tapped, while Flutter is still cold-starting — measured
  /// production gap was 5.61s (`call_incoming_shown` → `call_branded_fsi_routed`,
  /// call avatok-1204d417, 2026-08-17) during which the owner could not press
  /// Accept. Mirrors config.ts `callNativeAnswerV1`.
  ///
  /// Native has no engine on a cold notification tap and so cannot read this
  /// class directly — [refresh] mirrors the resolved value to
  /// `<filesDir>/callnative/answer_flags.json` on every fetch, same disk-mirror
  /// pattern as [nativeInCallUi]/`AvaDialPlugin.nativeUiFile`. A missing/corrupt
  /// mirror reads as OFF natively, and this getter itself defaults OFF so a
  /// config-fetch failure keeps today's passive-overlay-only behaviour.
  static bool get callNativeAnswerV1 => _b('callNativeAnswerV1', false);

  // [PLAY-SCOPE-1 2026-08-05] The `missedCallOverlay` getter is REMOVED — the
  // Truecaller-style missed-call overlay it gated is gone (AvaTOK is
  // AvaTOK-to-AvaTOK calling only). The KV key itself is deliberately KEPT in
  // worker/src/routes/config.ts: it is still the SERVER-side master kill switch
  // for phone-presence matching (/api/contacts/match, /api/missedcall/token,
  // /api/missedcall/lookup all check it), so the 2026-06-27 privacy lock can
  // still be re-applied with one flag flip. Do not delete it there.

  /// AvaDial default-SMS-app layer (Specs/PLAN-2026-07-12-home-ava-tok-services-shell
  /// .md, AVA-SMS; owner decision 2026-07-12). Ships DARK (default false): while off
  /// the AvaDial Messages tab renders its Phase-1 placeholder, NO SMS role is ever
  /// requested and the native SMS receivers/send service stay inert. Flip
  /// `avaSms: true` in KV `platform_config` (staging first) to surface the "Make
  /// AvaTOK your messages app" onboarding, the SMS conversation list + composer and
  /// the AI Inbox/Spam filter over carrier SMS. Requires ROLE_SMS at runtime
  /// (independent of the dialer role). Mirrors config.ts `avaSms` (served by the
  /// worker). Default false so a config-fetch failure keeps AvaDial's SMS surfaces
  /// inert.
  static bool get avaSms => _b('avaSms', false);

  /// [DEFAULT-APPS-REPROMPT-1] One-time re-prompt sending existing users who never
  /// onboarded to Settings → "Default phone & messages" (owner request
  /// 2026-07-15). Mirrors config.ts `defaultAppsReprompt`, which DECLARES this key
  /// in both PlatformConfig and DEFAULTS — without that declaration putConfig
  /// would 400 `unknown key` and this kill switch could never actually be pulled
  /// (the inAppUpdateEnabled trap, CLAUDE.md 2026-07-15).
  ///
  /// Defaults TRUE here to match the server default: unlike avaDialer/avaSms this
  /// gates a prompt, not a capability, so a config-fetch failure falling back to
  /// "show it" is safe — the once-per-account key still bounds it.
  static bool get defaultAppsReprompt => _b('defaultAppsReprompt', true);

  /// [AVADIAL-BACKUP-DAILY] Client mirror of config.ts `contactsDailyBackup` —
  /// the kill switch for the ~24h WorkManager contact-book backup
  /// (features/avadial/contacts_daily_backup.dart), re-read on every wake.
  ///
  /// Defaults TRUE, unlike every other flag here. That is deliberate and it cuts
  /// against the usual "fail dark" instinct: the daily job runs in a headless
  /// isolate where a config fetch can fail for boring reasons (no network yet,
  /// DNS still cold), and defaulting false would mean a flaky fetch silently
  /// stops backing up the contacts of the exact users this feature exists for.
  /// The failure modes are not symmetric — a redundant upload of an unchanged
  /// book costs a round-trip the change-detector usually skips anyway; a skipped
  /// backup costs someone their contacts. To truly stop the lane, set the KV flag
  /// false: clients that CAN reach config (the only ones that can upload at all)
  /// will honour it.
  static bool get contactsDailyBackup => _b('contactsDailyBackup', true);

  /// AvaDial community spam shield (client mirror of config.ts `spamShield`).
  /// Gates community lookups/reports from the SMS + call surfaces; while false
  /// those degrade to local-only labels (the worker also 403s every /api/spam/*
  /// route, so this mirror is a UX nicety — the server stays the security gate).
  static bool get spamShield => _b('spamShield', false);

  /// [AVA-RCPT-5/6/7] PSTN voicemail forwarding (Specs/PLAN-2026-07-16-ava
  /// -receptionist-guardian-FINAL.md, v1 = voicemail-only, everything else
  /// dark). Mirrors config.ts `pstnVoicemail`. While false: no reject/missed
  /// "expect" ping fires, the hidden-caller-ID auto-route in
  /// AvaCallScreeningService stays fail-open exactly as today, and the
  /// forwarding setup screen is hidden. Default false — this is a live-traffic
  /// PSTN feature and must be opted into per environment.
  static bool get pstnVoicemail => _b('pstnVoicemail', false);

  /// Max voicemail recording length in seconds (owner UX spec: greeting → beep
  /// → 25s recording → "Thank you" → hangup). Mirrors config.ts
  /// `pstnVoicemailRecordSec`. Informational on the device lane today (the
  /// Vobiz XML template that actually enforces it lives in the worker) — kept
  /// here so the forwarding setup screen can show the right expectation copy
  /// without a second flag round-trip.
  static int get pstnVoicemailRecordSec =>
      (_asNum(_cfg['pstnVoicemailRecordSec'])?.toInt()) ?? 25;

  /// [AVA-VM-PAID-1] Mirrors config.ts `pstnPaidConditionsUnlocked`. FALSE (the
  /// default and the launch state) = the "missed calls" and "declined / busy"
  /// forwarding conditions are a PAID upgrade: greyed, no "Turn on", green PAID
  /// pill — and one-time-cancelled at the carrier for users who already had them
  /// on. Only "phone off / unreachable" is free, because every forwarded call
  /// costs ~55 paisa (owner decision 2026-07-17).
  ///
  /// TRUE unlocks both for EVERYONE. This is a global switch, not a per-user
  /// entitlement — wire real billing before flipping it.
  static bool get pstnPaidConditionsUnlocked =>
      _b('pstnPaidConditionsUnlocked', false);

  static int get minAppBuild => (_asNum(_cfg['minAppBuild'])?.toInt()) ?? 0;

  /// The versionCode this install ACTUALLY carries, resolved once at [start]
  /// from PackageInfo. Falls back to the compile-time [kAppBuild] until then.
  ///
  /// [AVA-UPDATE-AUTO] This exists because comparing against `kAppBuild` was a
  /// live footgun. CI stamps the real versionCode with
  /// `--build-number=$((10000 + run_number))`, so every shipped build is ~10000+
  /// while the constant sits frozen at 28. That made [updateRequired] not merely
  /// wrong but DANGEROUS: the moment the owner set `minAppBuild` to a real CI
  /// build number to force an upgrade, `minAppBuild > 28` would be true on every
  /// device INCLUDING ones already running the newest build — bricking the whole
  /// user base behind an un-passable "please update" wall, with the only exit
  /// being a KV edit. Resolving the real number removes that trap.
  static int _installedBuild = kAppBuild;
  static int get installedBuild => _installedBuild;

  static Future<void> _resolveInstalledBuild() async {
    try {
      final n = int.tryParse((await PackageInfo.fromPlatform()).buildNumber);
      // [BOOT-FLASH-1] Bump ONLY on a real change. This used to bump
      // unconditionally on every launch, and since RootFlow's build is wrapped in
      // a ValueListenableBuilder on [revision] that was one guaranteed
      // whole-tree rebuild per cold start, even though the resolved versionCode
      // is identical every single time for a given install.
      if (n != null && n > 0 && n != _installedBuild) {
        _installedBuild = n;
        revision.value++; // re-evaluate the gate with the true number
      }
    } catch (_) {/* keep the kAppBuild fallback */}
  }

  /// Installed build too old? → callers show the blocking "please update" screen.
  static bool get updateRequired => minAppBuild > _installedBuild;

  /// Newest build published to the store (KV `latestAppBuild`). When it is
  /// greater than the build the user actually has installed, [UpdateService]
  /// shows the dismissible "new version available" popup that opens the Google
  /// Play listing. 0 (default) = never prompt. Owner bumps this in KV per
  /// release. Distinct from [minAppBuild] (the hard, blocking floor).
  static int get latestAppBuild => (_asNum(_cfg['latestAppBuild'])?.toInt()) ?? 0;

  /// Kill switch for the automatic in-app update flow (the on-launch Play check,
  /// the background flexible download + auto-install, the "Update" sidebar row and
  /// the fallback popup — see core/update_service.dart). Default ON; set
  /// `inAppUpdateEnabled: false` in KV to stop every device update-checking.
  ///
  /// [AVA-UPDATE-AUTO] That KV flip only actually works as of 2026-07-15. This
  /// docstring previously promised it while the key was NOT declared in the
  /// Worker's `config.ts` DEFAULTS — and the PUT handler rejects any undeclared
  /// key with `unknown key` / 400. So the brake was documented but unusable: the
  /// client defaulted true and nothing could turn it off. The key is now declared
  /// server-side (default true), so the switch is real. If this ever regresses,
  /// the symptom is a 400 from `scripts/flags.sh set inAppUpdateEnabled=false`.
  static bool get inAppUpdateEnabled => _b('inAppUpdateEnabled', true);

  /// [AVAGRP-SEENBY-1 / AVAGRP-BUBBLE-2] Per-message group read/delivered
  /// receipts (the "Info" sheet seen-by data, chat_thread.dart's
  /// `_showMessageInfo`). Mirrors config.ts `groupReceiptsEnabled`, already
  /// declared in both `PlatformConfig` and `DEFAULTS` (config.ts:206/373) —
  /// this getter was the missing client half; without it the flag could be
  /// read on the server but never checked here, so the dark-launched receipt
  /// pipeline had no way to actually turn on. Default false (dark launch);
  /// flip `groupReceiptsEnabled: true` in KV once the per-message ingest +
  /// hydrate path (`sync_hub.dart` `_ingestMsgReceipt`, `group_dm.dart`
  /// `sendMsgReceipt`) is device-verified.
  static bool get groupReceiptsEnabled => _b('groupReceiptsEnabled', false);

  /// [AVA-VOICE-PLAINTEXT-1] MVP voice notes (owner decision 2026-07-25,
  /// CLAUDE.md "Part A"): whether DM voice notes are end-to-end encrypted.
  /// Mirrors config.ts `voiceNoteEncryptionEnabled` EXACTLY — same key name,
  /// same default (`false`, worker/src/routes/config.ts DEFAULTS) — a client
  /// getter reading a key the server never declares is a fake flag
  /// (`imageGenEnabled` was the last one, CLAUDE.md "FAKE FLAGS"). Default
  /// FALSE: recorded voice notes upload PLAINTEXT via the private,
  /// server-readable path (`x-encrypted: 0`, `MediaService.uploadPlaintext`)
  /// so Ava can transcribe/translate them; sending stays authorization-gated
  /// to the conversation membership — unencrypted never means public. Flip
  /// `voiceNoteEncryptionEnabled: true` in KV to restore client-side AES-GCM
  /// encryption (`MediaService.encryptAndUpload`) with NO rebuild — both
  /// paths stay live in `chat_thread.dart`'s `_stopAndSendRecording`/`_upload`.
  static bool get voiceNoteEncryptionEnabled => _b('voiceNoteEncryptionEnabled', false);

  /// [BOOT-FLASH-1] Load the last-known-good server config from disk into [_cfg]
  /// BEFORE the first frame, so the app paints the flags it is actually going to
  /// run with instead of the compile-time defaults. One small local file read
  /// (same critical-path budget as `FontScale.load()`); NEVER a network call.
  ///
  /// Idempotent, and never throws — a missing, truncated, corrupt or
  /// wrong-shaped file simply leaves [_cfg] empty so every getter falls back to
  /// its hardcoded default, exactly as before this cache existed.
  ///
  /// KILL-SWITCH NOTE: this makes a cached value outlive the process. For a
  /// device that CAN reach `/api/config`, [refresh] overwrites it within a second
  /// of launch, so the exposure window is the same one we already had. For a
  /// device that cannot, the cache is honoured for at most [_cfgCacheMaxAgeMs]
  /// and then expires back to defaults. Server-side enforcement (every gated
  /// route re-checks the live flag) remains the real gate; these getters are UX.
  /// Memoised so concurrent callers await the SAME read (and so a later call can
  /// never clobber a config that [refresh] has since fetched from the network).
  static Future<void> hydrateFromDisk() => _hydrated ??= _hydrateFromDisk();

  static Future<void> _hydrateFromDisk() async {
    try {
      final raw = await DiskCache.readGlobal(_kCfgCache);
      if (raw == null || raw.isEmpty) return;
      final env = jsonDecode(raw);
      if (env is! Map) return;
      final Object? at = env['at'];
      final Object? cfg = env['cfg'];
      if (at is! num) return;
      if (cfg is! Map) return;
      final age = DateTime.now().millisecondsSinceEpoch - at.toInt();
      // A negative age means the device clock moved backwards — treat as unusable
      // rather than trusting a snapshot we cannot date.
      if (age < 0 || age > _cfgCacheMaxAgeMs) return;
      final typed = Map<String, dynamic>.from(cfg);
      _cfg = typed;
      _cfgSig = jsonEncode(typed);
      // Cheap, pure-Dart field — safe to apply before runApp. PartyHub is
      // deliberately NOT touched here: it starts a realtime layer and belongs in
      // [refresh], off the critical path.
      AvaDns.dohEnabled = dohFallbackEnabled;
    } catch (e) {
      // Corrupt/unreadable cache must never brick a launch. _cfg is left exactly
      // as it was (empty on the boot path), so every getter falls back to its
      // hardcoded default — the pre-cache behaviour.
      AvaLog.I.log('config', 'config cache hydrate failed: $e');
    }
  }

  /// Fetch now + poll every 15 min. Never throws.
  static Future<void> start() async {
    // Safety net: main() hydrates before runApp, but start() may also be reached
    // from a path that didn't (tests, a future entry point). Guarded + idempotent.
    await hydrateFromDisk();
    // Paint the active account's cached admin flag first so admin-only surfaces
    // (Marketplace) render correctly on cold boot before the network probe lands.
    await _loadAdminCache();
    // [AVA-UPDATE-AUTO] Resolve the real versionCode BEFORE the first refresh, so
    // the minAppBuild gate never evaluates against the stale kAppBuild constant.
    await _resolveInstalledBuild();
    await refresh();
    // Resolve admin status alongside config so admin-only surfaces (Marketplace)
    // appear on this launch. Fire-and-forget: never blocks app start.
    unawaited(refreshAdmin());
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(minutes: 15), (_) {
      refresh();
      refreshAdmin();
    });
  }

  /// Probe whether the active account is an admin (signed /admin/recon → 200).
  /// Bumps [revision] on change so drawers/menus re-evaluate [marketplaceVisible].
  /// Never throws. Call again after an account switch to re-resolve.
  static Future<void> refreshAdmin() async {
    final scope = AccountScope.id; // capture: an account switch may race this probe
    // [ADMIN-GATE] For an account NOT already known to be an admin, throttle the
    // /admin/recon probe to at most once/week. A known admin (_isAdmin, painted
    // from the scoped cache) is exempt and re-probes every cycle. A last-probe of
    // 0 (never probed on this account) always probes, so a real admin is still
    // discovered on first launch. Only a COMPLETED probe writes the timestamp, so
    // a transient network failure is retried next cycle rather than throttled.
    if (!_isAdmin) {
      int last = 0;
      try {
        last = int.tryParse(await DiskCache.read(_kAdminProbeAtKey) ?? '') ?? 0;
      } catch (_) {/* best-effort — treat as never-probed */}
      final now = DateTime.now().millisecondsSinceEpoch;
      if (last != 0 && now - last < _adminProbeThrottleMs) {
        Analytics.capture('admin_probe_skipped',
            {'account': scope ?? '', 'reason': 'throttled', 'age_ms': now - last});
        return;
      }
    }
    try {
      final was = _isAdmin;
      final v = await MoneyApi.isAdmin();
      // If the active account changed while the probe was in flight, a newer
      // switch owns the admin state now — discard this (stale) result so we never
      // write one account's admin flag into another's scoped cache.
      if (AccountScope.id != scope) return;
      _isAdmin = v;
      if (_isAdmin != was) revision.value++;
      // Persist per-account so the next switch to this account paints instantly.
      try { await DiskCache.write(_kAdminCache, v ? '1' : '0'); } catch (_) {/* best-effort */}
      // [ADMIN-GATE] Record the probe time so a non-admin result throttles the
      // next probe(s) to once/week (see _kAdminProbeAtKey).
      try {
        await DiskCache.write(_kAdminProbeAtKey, '${DateTime.now().millisecondsSinceEpoch}');
      } catch (_) {/* best-effort */}
      Analytics.capture('admin_probe', {'is_admin': v, 'account': scope ?? ''});
    } catch (e) {
      AvaLog.I.log('config', 'admin probe failed: $e');
    }
  }

  /// [CALL-NATIVE-ANSWER-1] Android-only, best-effort. `avatok/incoming_call_tap`
  /// is already registered by MainActivity.configureFlutterEngine for every
  /// build (the getPending/clearPending pair) — reused here rather than
  /// standing up a new channel/plugin for one boolean. Older builds without
  /// the `setCallNativeAnswerV1` handler simply drop the call (caught below),
  /// which is exactly the fail-closed/OFF outcome we want.
  static const MethodChannel _callNativeAnswerChannel =
      MethodChannel('avatok/incoming_call_tap');

  static Future<void> _mirrorCallNativeAnswerV1() async {
    if (!Platform.isAndroid) return;
    try {
      await _callNativeAnswerChannel.invokeMethod(
        'setCallNativeAnswerV1',
        {'enabled': callNativeAnswerV1},
      );
      await _callNativeAnswerChannel.invokeMethod(
        'setCallPrewarmNativeV1',
        {'enabled': callNativeAnswerV1 && callSilentTransportPrewarmV1},
      );
    } catch (e) {
      AvaLog.I.log('config', 'callNativeAnswerV1 disk mirror failed: $e');
    }
  }

  static Future<void> refresh() async {
    try {
      final res = await http
          .get(Uri.parse(kConfigUrl))
          .timeout(const Duration(seconds: 6));
      if (res.statusCode == 200) {
        final m = jsonDecode(res.body);
        if (m is Map<String, dynamic>) {
          final sig = jsonEncode(m);
          _cfg = m;
          // The network answer supersedes any disk hydrate: mark hydration done
          // so a late [hydrateFromDisk] can never overwrite it with older values.
          _hydrated ??= Future.value();
          // PERF-DNS-2 kill switch: let KV disable the DoH fallback if needed.
          AvaDns.dohEnabled = dohFallbackEnabled;
          // PartyKit realtime layer master switch (replaces Ably). Ships dark
          // until the PartyDO is deployed + this flag flipped on server-side.
          PartyHub.I.setEnabled(m['partyEnabled'] == true);
          // [CALL-NATIVE-ANSWER-1] Mirror the resolved flag to disk for
          // MainActivity, which has no engine to read this class from on a
          // cold notification tap. Same disk-mirror pattern as
          // AvaDialChannel.setNativeInCallEnabled → native_ui.json. Fire-
          // and-forget: a mirror failure just means the native ring screen
          // stays off (fail-closed, matches the getter's own default) until
          // the next successful refresh.
          unawaited(_mirrorCallNativeAnswerV1());
          // [BOOT-FLASH-1] Bump ONLY when the values actually changed. RootFlow's
          // build listens to this notifier, so an unconditional bump rebuilt the
          // whole widget tree on every 15-minute poll AND on the first fetch after
          // a cold start that had already hydrated the identical config from disk.
          if (sig != _cfgSig) {
            _cfgSig = sig;
            revision.value++;
          }
          // [BOOT-FLASH-1] Persist for the next cold start. Written on every
          // successful fetch (not only on change) so the `at` timestamp stays
          // fresh and an unchanged-but-still-valid config doesn't age out.
          try {
            await DiskCache.writeGlobal(
              _kCfgCache,
              jsonEncode({'at': DateTime.now().millisecondsSinceEpoch, 'cfg': m}),
            );
          } catch (_) {/* best-effort — a write failure just costs one flash */}
        }
      }
    } catch (e) {
      AvaLog.I.log('config', 'remote config fetch failed: $e');
    }
  }
}
