import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter/widgets.dart' show AppLifecycleState, WidgetsBinding, WidgetsBindingObserver;

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/remote_config.dart';
import '../../core/voice/native_voice_audio.dart';
import 'call_translation_audio_bridge.dart';
import 'call_translation_device_nonce.dart';
import 'call_translation_last_lang.dart';
import 'translation_api.dart';

/// [CALL-TRANSLATE-2B-1] The call-translation lifecycle.
///
/// Replaces the old 6-value status enum (off/preparing/active/fundsStopped/
/// unavailable/error), which conflated "why did it stop" with "where is it now"
/// and had no vocabulary for a session that is degraded but alive. Every native
/// event maps onto exactly one transition here; see [_legalTransitions] for the
/// matrix and [_onBridgeEvent] for the event → transition mapping.
///
/// ```
/// idle ──tap──▶ starting ──setup ok──▶ warming ──activate ok──▶ active
///   ▲              │                      │                    │  ▲
///   │              │                  (Phase C: language       │  │
///   │              │                   switch re-enters        │  │
///   │              │                   warming from active)    │  │
///   │              ▼                      ▼                    ▼  │
///   └── stopping ◀─┴──────────────────────┴──── stalled ───────────┘
///          │                                     │
///          │                                  recovering
///          ▼                                     │
///        idle                                    ▼
///                                            failed (terminal for this call
///                                            once the breaker opens)
/// ```
enum CallTranslationState {
  /// Nothing running. The only state from which a session may be started.
  idle,

  /// `/call/start` in flight — no money has moved, no audio has been touched.
  starting,

  /// Provider socket + playback proven, `/call/activate` crossing the paid
  /// boundary. Phase C re-enters this state for a language cutover.
  warming,

  /// Translating. Original decoded audio is muted by the plugin.
  active,

  /// The native dead-air guard fired: no translated PCM for ~2 s while input
  /// audio was flowing. The PLUGIN has already un-muted the original audio, so
  /// the call is audible; this state exists to tell the user why.
  stalled,

  /// Re-establishing the provider socket (resume token mint + resume).
  recovering,

  /// Tear-down in flight: bridge stopped, session row being released.
  stopping,

  /// Stopped because something failed. See [failure]. When the circuit breaker
  /// has opened this is TERMINAL for the call — no further start is accepted.
  failed,
}

/// Why the machine is in [CallTranslationState.failed] — kept separate from the
/// state so the UI can render the right copy and the right recovery action
/// without the state machine growing a branch per error class.
enum CallTranslationFailure {
  none,
  disabled,
  insufficientTokens,
  sourceUnavailable,
  playbackUnavailable,
  providerUnavailable,
  network,

  /// Three provider failures inside one call — translation is off for the rest
  /// of this call and re-tapping will not retry.
  circuitOpen,
}

/// Call-only lifecycle. The Android bridge consumes decoded incoming WebRTC
/// playback; it never opens another microphone capture.
///
/// THE INVARIANT: translation may fail, stall, or be unavailable; the
/// underlying call must remain usable and original audio must be restored
/// automatically on every path — provider failure, token expiry, crash,
/// force-stop, funds exhaustion, widget disposal, call teardown. Every early
/// return below either leaves the plugin un-muted or routes through
/// [_stopInternal], which does.
///
/// OWNERSHIP: exactly ONE instance owns the bridge and the playback route for a
/// given call. Ownership is claimed on the `idle → starting` transition and
/// released on the transition into `idle`/`failed`. Nothing outside the state
/// machine may call `bridge.prepare/activate/commitPaid/resume`.
class CallTranslationController with WidgetsBindingObserver {
  CallTranslationController({required this.callRef, required this.bridge}) {
    _bridgeEvents = bridge.events.listen(_onBridgeEvent, onError: (Object e) {
      // An EventChannel error is indistinguishable from a dead plugin.
      unawaited(_failFromProvider('bridge_stream_error'));
    });
    WidgetsBinding.instance.addObserver(this);
    _watchAudioRoute();
    _watchTelephony();
  }

  final String callRef;
  final CallTranslationAudioBridge bridge;

  // ── observable surface ────────────────────────────────────────────────────
  final state = ValueNotifier(CallTranslationState.idle);
  final failure = ValueNotifier(CallTranslationFailure.none);
  final targetLanguage = ValueNotifier<String?>(null);
  final billedTokens = ValueNotifier<int>(0);
  final elapsedSeconds = ValueNotifier<int>(0);

  /// True once the plugin reported `stall_degraded` (2+ stall/recover cycles in
  /// a 60 s window) — the UI shows a quality warning but keeps translating.
  final qualityDegraded = ValueNotifier<bool>(false);

  /// True while the ORIGINAL call audio is being played instead of the
  /// translation (dead-air guard, route change, focus blip, Phase C cutover).
  ///
  /// Read-only mirror of the PLUGIN's actual mute state — see the fallback
  /// owner model in [_raiseFallback]. Never write it directly.
  final fallbackToOriginal = ValueNotifier<bool>(false);

  /// [CALL-TRANSLATE-2C-2] The language a mid-call switch is cutting over TO,
  /// or null when no switch is in flight. The pill renders "Switching to X…"
  /// off this; it is a separate notifier from [state] because a switch has to
  /// be distinguishable from a cold start, and both sit in `warming`.
  final switchingTo = ValueNotifier<String?>(null);

  /// Captions were deferred by the owner; the plugin no longer emits them and
  /// [_onBridgeEvent] no longer has a `caption` branch. Retained only so any
  /// out-of-tree widget still binding to it keeps compiling; it is never set.
  @Deprecated('captions deferred — the plugin no longer emits caption events')
  final caption = ValueNotifier<String>('');

  // ── internals ─────────────────────────────────────────────────────────────
  static const int kMaxProviderFailuresPerCall = 3;

  /// [CALL-TRANSLATE-2D-4 / L-6] Provider resumes allowed in ONE call, whether
  /// they succeed or fail. A `goAway` is normal housekeeping once or twice in a
  /// long call; a session that needs six is not working, and every resume is an
  /// audible gap. Bounding it here is what stops a succeed-then-goAway provider
  /// looping until `/token`'s hourly rate limit happens to catch it.
  static const int kMaxResumesPerCall = 6;
  static const int _kMaxWriteAttempts = 3;
  static const Duration _kDefaultRetryAfter = Duration(milliseconds: 750);

  /// A pre-minted token is single-use and short-lived server-side. Anything
  /// older than this is thrown away rather than gambled on mid-cutover.
  static const Duration _kWarmTokenMaxAge = Duration(seconds: 60);

  /// Ceiling on how long we wait to observe the FIRST translated PCM of a new
  /// language before giving up on measuring `switch_gap_ms`. The switch itself
  /// is already complete by then — this only bounds the telemetry probe.
  static const Duration _kSwitchGapTimeout = Duration(seconds: 12);

  /// [CALL-TRANSLATE-2C-4] Deadline on a make-before-break cutover: how long the
  /// pending socket may take to reach `setupComplete` before we give up, stay on
  /// the (still live) old session and toast. Matches the plugin's own 15 s setup
  /// timeout for `prepare`; `switchLanguage` has no native timer of its own.
  static const Duration _kSwitchCutoverTimeout = Duration(seconds: 15);

  /// [CALL-TRANSLATE-2D-5] CEILING ON THE DART-OWNED 'switching' FALLBACK.
  ///
  /// A successful cutover raises `setFallback(true, 'switching')` so the user
  /// hears the real speaker across the new pipeline's refill (see
  /// [_onLanguageSwitched]). The plugin's dead-air guard is gated on
  /// `!fallbackActive`, so while that reason is held the guard CANNOT fire — and
  /// the only thing that lowers it is the guard's own `recovered`, which needs
  /// translated PCM that a dead new session never produces. Held forever, the
  /// user hears the original speaker indefinitely, the pill still says
  /// "translating", and `_renewMinute` keeps charging 5 Tokens/min for nothing.
  ///
  /// So the reason is BOUNDED. On expiry Dart lowers the reason it raised (owner
  /// model unchanged — Dart never lowers the native dead-air reason) and the
  /// plugin returns to its normal armed state, where the guard owns dead air.
  ///
  /// 5 s is deliberate: a make-before-break cutover's first chunk is bounded by
  /// the new pipeline's first-chunk latency (near-zero by design), and the
  /// plugin's own anti-flap floor is 800 ms of fallback + ~200 ms of sustained
  /// PCM — so 5 s is ~5x a healthy release and cannot clip one. It is also well
  /// inside the 12 s [_kSwitchGapTimeout] probe, so the guard gets ≥7 s of armed
  /// time before that probe reports, and the whole detect-then-stop chain
  /// finishes far short of the 60 s billing minute.
  static const Duration _kSwitchFallbackMaxHold = Duration(seconds: 5);

  /// [CALL-TRANSLATE-2D-5] DEAD-TRANSLATION DEADLINE.
  ///
  /// How long the NATIVE dead-air guard may hold the fallback continuously
  /// before we stop the session cleanly instead of billing another minute of it.
  ///
  /// The guard only raises dead air when input audio IS flowing (`inputFlowing`
  /// in the plugin's guard loop: the far end spoke since the last translated
  /// chunk, or is speaking now), so this timer can never be tripped by ordinary
  /// silence on the call — it means someone is talking and nothing is coming
  /// back. 20 s is long enough to ride out a provider hiccup and a full resume
  /// (mint + socket), short enough that a stall can at worst carry one more
  /// minute boundary rather than an unbounded number of them.
  ///
  /// This is the general backstop, not a switch-specific one: it also bounds a
  /// cold start, a route change and a focus blip that end in dead translation.
  static const Duration _kDeadTranslationDeadline = Duration(seconds: 20);

  Timer? _renew;
  Timer? _clock;
  Timer? _firstAudioPoll;
  Timer? _fallbackRelease;
  Timer? _switchGapPoll;

  /// [CALL-TRANSLATE-2D-5] Bounds the Dart-owned 'switching' reason — see
  /// [_kSwitchFallbackMaxHold].
  Timer? _switchFallbackCeiling;

  /// [CALL-TRANSLATE-2D-5] Armed while the native dead-air guard holds the
  /// fallback — see [_kDeadTranslationDeadline].
  Timer? _deadTranslation;
  StreamSubscription<CallTranslationAudioEvent>? _bridgeEvents;
  StreamSubscription<CallAudioRouteResult>? _routeEvents;
  StreamSubscription<Map<String, dynamic>>? _telephonyEvents;

  String? _id;
  String? _lease;
  String? _nonce;
  String? _lastResumeHandle;
  bool _resumingProvider = false;
  bool _disposed = false;
  int _providerFailures = 0;

  /// [L-6] Provider resumes attempted in this call — see [kMaxResumesPerCall].
  /// Deliberately NOT reset by a successful resume: the budget is per call.
  int _resumeCount = 0;
  int _tapAtMs = 0;
  int? _firstAudioMs;
  int _firstAudioPolls = 0;
  bool _deviceBound = false;

  /// [CALL-TRANSLATE-2D-4 / L-5] The Worker now echoes `call_ref` on EVERY
  /// response, success and error alike, precisely so the client and server
  /// PostHog timelines for one call can be joined (Dart used to stamp
  /// `session_id` only, which does not exist yet at /start-failure time and is
  /// different per session when a call has more than one). We already know our
  /// own [callRef]; this holds the server's echo so a mismatch is visible rather
  /// than assumed away.
  String? _serverCallRef;

  // ── paid-only refusal detail (402) ────────────────────────────────────────
  //
  // OWNER DECISION 2026-08-04: live call translation is PAID-ONLY. The 100-token
  // welcome grant and the daily free grant are deliberately NOT spendable here,
  // because this is a metered third-party provider lane. The Worker's 402 now
  // says so explicitly (`paid_only: true`) and reports BOTH balances, so the
  // client can tell "you have no tokens" apart from "you have tokens, but not
  // the kind this feature spends". Telling a user with a visibly non-empty
  // wallet that they have no tokens is the bug this exists to prevent.
  int _paidBalance = 0;
  int _spendableBalance = 0;
  bool _paidOnlyRefusal = false;

  /// True when the last 402 was refused for lack of PAID tokens while the user
  /// still holds free/bonus tokens. The copy must say "top up", not "empty".
  bool get needsPaidTopUp => _paidOnlyRefusal && _spendableBalance > _paidBalance;

  /// Tokens the user holds that this feature cannot spend (free + bonus).
  int get nonPaidTokens =>
      _spendableBalance > _paidBalance ? _spendableBalance - _paidBalance : 0;

  void _absorbPaidOnlyRefusal(Map<String, dynamic> body) {
    _paidOnlyRefusal = body['paid_only'] == true;
    _paidBalance = (body['balance'] as num?)?.toInt() ?? _paidBalance;
    _spendableBalance = (body['spendable'] as num?)?.toInt() ?? _spendableBalance;
    Analytics.capture('call_translation_insufficient_tokens', {
      ..._tags,
      // `paid_balance_required` (start/activate) or `balance_exhausted` (renew).
      'reason': body['reason']?.toString() ?? '',
      'paid_only': _paidOnlyRefusal,
      'balance': _paidBalance,
      'spendable': _spendableBalance,
      'has_non_paid_tokens': needsPaidTopUp,
    });
  }

  /// Stamped on every client event for this call. `call_ref` is the join key.
  Map<String, dynamic> get _tags => <String, dynamic>{
        'session_id': _id ?? '',
        'call_ref': _serverCallRef ?? callRef,
      };

  /// Records the server's `call_ref` from any response that carries one.
  void _absorbCallRef(Map<String, dynamic> response) {
    final ref = response['call_ref']?.toString();
    if (ref == null || ref.isEmpty) return;
    if (_serverCallRef != null && _serverCallRef != ref) {
      AvaLog.I.log('calltranslate', 'call_ref echo changed');
    }
    _serverCallRef = ref;
  }

  /// [CALL-TRANSLATE-2D-4 / D-8] Every notifier write goes through this.
  /// [dispose] sets `_disposed` and then disposes the notifiers synchronously,
  /// while `_stopInternal` is still resuming after `await bridge.stop()` — the
  /// resulting write to a disposed ValueNotifier tripped a debug assertion and
  /// reported a spurious `$exception` on EVERY teardown while translating.
  void _notify<T>(ValueNotifier<T> notifier, T value) {
    if (_disposed) return;
    notifier.value = value;
  }

  // Native counters, last-known values from `stats` (monotonic within a call).
  //
  // [CALL-TRANSLATE-2D-4] `stallCount`/`stallMsTotal` are now DEAD-AIR ONLY. A
  // deliberate fallback (language switch, route change, focus blip) lands in
  // `fallbackCount`/`fallbackMsTotal` instead. The launch-gate p95 stall
  // thresholds are derived from the stall pair, so the two must never be merged
  // back together — a clean language switch is not a quality incident.
  int _stallCount = 0;
  int _stallMsTotal = 0;
  int _fallbackCount = 0;
  int _fallbackMsTotal = 0;
  int _pcmDropCount = 0;
  int _uplinkFailCount = 0;
  int _shortWriteCount = 0;
  int _queuePeak = 0;

  // Audio-focus hook bookkeeping — see [_hookAudioFocus].
  void Function()? _prevFocusLost;
  void Function()? _prevFocusRegained;
  void Function()? _ourFocusLost;
  void Function()? _ourFocusRegained;

  bool get available => RemoteConfig.translationEnabled && RemoteConfig.callTranslationEnabled;
  bool get active => state.value == CallTranslationState.active || state.value == CallTranslationState.stalled;

  /// Any state where the pill should show a spinner rather than an action.
  bool get preparing =>
      state.value == CallTranslationState.starting ||
      state.value == CallTranslationState.warming ||
      state.value == CallTranslationState.recovering ||
      state.value == CallTranslationState.stopping;

  /// True once the breaker has tripped: translation is done for this call.
  bool get circuitOpen => _providerFailures >= kMaxProviderFailuresPerCall;

  /// Live session id — a Phase C language switch needs it for `/call/:id/language`.
  String? get sessionId => _id;

  /// The device nonce this session was created with. Phase C must send the SAME
  /// value on `/language`, or the Worker answers 403 `device_nonce_mismatch`.
  String? get deviceNonce => _nonce;

  // ───────────────────────────────────────────────────────────────────────────
  // state machine
  // ───────────────────────────────────────────────────────────────────────────

  /// The full legal-transition matrix. Anything not listed is illegal and is
  /// logged + dropped — never thrown. A state machine that throws on a race
  /// would take the CALL down with it, which the invariant forbids.
  static const Map<CallTranslationState, Set<CallTranslationState>> _legalTransitions = {
    CallTranslationState.idle: {
      CallTranslationState.starting,
      CallTranslationState.failed,
    },
    CallTranslationState.starting: {
      CallTranslationState.warming,
      CallTranslationState.stopping,
      CallTranslationState.failed,
    },
    CallTranslationState.warming: {
      CallTranslationState.active,
      CallTranslationState.recovering,
      CallTranslationState.stopping,
      CallTranslationState.failed,
    },
    CallTranslationState.active: {
      CallTranslationState.stalled,
      CallTranslationState.recovering,
      // Phase C: a language switch is active → warming(new) → active.
      CallTranslationState.warming,
      CallTranslationState.stopping,
      CallTranslationState.failed,
    },
    CallTranslationState.stalled: {
      CallTranslationState.active,
      CallTranslationState.recovering,
      CallTranslationState.warming,
      CallTranslationState.stopping,
      CallTranslationState.failed,
    },
    CallTranslationState.recovering: {
      CallTranslationState.active,
      CallTranslationState.stalled,
      CallTranslationState.warming,
      CallTranslationState.stopping,
      CallTranslationState.failed,
    },
    CallTranslationState.stopping: {
      CallTranslationState.idle,
      CallTranslationState.failed,
    },
    CallTranslationState.failed: {
      // A non-provider failure (e.g. a 402 that the user then topped up) may be
      // retried; the circuit breaker is what makes `failed` terminal, not the
      // matrix. See [start].
      CallTranslationState.starting,
      CallTranslationState.stopping,
      CallTranslationState.idle,
    },
  };

  bool _transition(CallTranslationState next, String reason) {
    if (_disposed) return false;
    final from = state.value;
    if (from == next) return true;
    final allowed = _legalTransitions[from] ?? const <CallTranslationState>{};
    if (!allowed.contains(next)) {
      AvaLog.I.log('calltranslate', 'illegal transition ${from.name} -> ${next.name} ($reason)');
      Analytics.capture('call_translation_illegal_transition', {
        ..._tags,
        'from': from.name,
        'to': next.name,
        'reason': reason,
      });
      return false;
    }
    state.value = next;
    // Breadcrumb: state transitions only — never transcript text, audio bytes,
    // or anything audio-derived (owner-approved narrowing of the telemetry rule).
    Analytics.capture('call_translation_state', {
      'from': from.name,
      'to': next.name,
      'reason': reason,
      ..._tags,
      'provider_failures': _providerFailures,
    });
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // start
  // ───────────────────────────────────────────────────────────────────────────

  /// Returns null on success, else a stable error code the overlay maps to copy.
  Future<String?> start(String lang) async {
    if (!available) {
      _enterFailed(CallTranslationFailure.disabled, 'flags_off');
      return 'disabled';
    }
    if (circuitOpen) {
      // Terminal for this call — do not spend another token proving it again.
      _enterFailed(CallTranslationFailure.circuitOpen, 'circuit_open');
      return 'unavailable_for_call';
    }
    if (state.value != CallTranslationState.idle && state.value != CallTranslationState.failed) {
      return 'busy';
    }
    _tapAtMs = DateTime.now().millisecondsSinceEpoch;
    _firstAudioMs = null;
    _notify(failure, CallTranslationFailure.none);
    _notify(qualityDegraded, false);
    if (!_transition(CallTranslationState.starting, 'user_tap')) return 'busy';
    _notify(targetLanguage, lang);

    // [CALL-TRANSLATE-2C-2] P1 fast start: while the user was still scrolling
    // the language sheet, [warmUp] may have already created the session row AND
    // driven the provider socket to setupComplete for their last-used language.
    // If that is the language they picked, adopt it — no /start round trip and
    // no socket handshake stand between the tap and the paid boundary. Nothing
    // has been billed either way: /activate is the paid boundary, not /start.
    final adopted = await _adoptWarmSession(lang);
    if (!adopted) {
      final openError = await _openSession(lang, warm: false);
      if (openError != null) return openError;
    }
    try {
      // Prove decoded capture, provider input, and translated playback can all
      // start before crossing the paid boundary. This creates only a brief
      // unbilled setup interval while /activate performs the first debit.
      await bridge.activate();
    } catch (_) {
      await _stopUnbilledPending();
      _enterFailed(CallTranslationFailure.playbackUnavailable, 'activate_native_failed');
      return 'playback_unavailable';
    }
    if (state.value != CallTranslationState.warming || _id == null || _lease == null) {
      await _stopUnbilledPending();
      _enterFailed(CallTranslationFailure.providerUnavailable, 'warming_lost');
      return 'provider_unavailable';
    }

    final activate = await _writeWithRetry(
      'activate',
      () => TranslationApi.callActivate(_id!, _lease!, deviceNonce: _nonce),
    );
    _absorbCallRef(activate);
    final activateStatus = (activate['status'] as num?)?.toInt() ?? 0;
    if (activateStatus != 200) {
      // A2: past this point the payer MAY already have been charged (the race
      // this retry loop exists for). Never leak the row — stop it explicitly
      // even though the charge is not refunded.
      await _stopInternal('activate_failed_$activateStatus', toFailed: false);
      if (activateStatus == 402 || TranslationApi.isInsufficientTokens(activate)) {
        _absorbPaidOnlyRefusal(activate);
        _enterFailed(CallTranslationFailure.insufficientTokens, 'activate_402');
        return 'insufficient_tokens';
      }
      if (activateStatus == 0) {
        _enterFailed(CallTranslationFailure.network, 'activate_unreachable');
        return 'network_unavailable';
      }
      _enterFailed(CallTranslationFailure.providerUnavailable, 'activate_$activateStatus');
      return 'source_not_ready';
    }
    final reconciled = activate['reconciled']?.toString();
    if (reconciled != null) {
      // "already_active" / "repaired" are SUCCESS: the Worker re-read the row
      // and converged it. Treat exactly like a clean 200, but record it so the
      // race rate is measurable.
      Analytics.capture('call_translation_reconciled', {
        'op': 'activate',
        'reconciled': reconciled,
        ..._tags,
      });
    }

    try {
      await bridge.commitPaid();
    } catch (_) {
      await _stopInternal('commit_paid_failed', toFailed: false);
      _enterFailed(CallTranslationFailure.playbackUnavailable, 'commit_paid_failed');
      return 'playback_unavailable';
    }

    // [CALL-TRANSLATE-2D-4] activate's 200 now carries `billed_tokens` too (it
    // used to be renew-only, and the client fell back to a hardcoded 5). The
    // server value is authoritative — never add the rate locally on top of it.
    _notify(billedTokens,
        (activate['billed_tokens'] as num?)?.toInt() ?? TranslationApi.ratePerMin);
    if (!_transition(CallTranslationState.active, 'activated')) {
      await _stopInternal('active_rejected', toFailed: false);
      return 'busy';
    }
    _renew = Timer.periodic(const Duration(minutes: 1), (_) => unawaited(_renewMinute()));
    _clock = Timer.periodic(const Duration(seconds: 1), (_) => elapsedSeconds.value++);
    _startFirstAudioProbe();
    unawaited(CallTranslationLastLang.write(lang));
    Analytics.capture('call_translation_started', {
      'language': lang,
      'rate_per_min': TranslationApi.ratePerMin,
      ..._tags,
      'device_bound': _deviceBound,
      'warm_start': adopted,
    });
    return null;
  }

  /// Creates the billing session row and drives the provider socket all the way
  /// to `setupComplete`. **No money moves here** — `/activate` is the paid
  /// boundary — which is exactly why the warm-up may run this speculatively.
  ///
  /// Returns null on success (with `_id`/`_lease` set and the native pipeline
  /// prepared), else the stable error code [start] hands back to the overlay.
  /// On the non-warm path it also enters `warming` and marks [failure]; the warm
  /// path deliberately touches NEITHER, so a speculative attempt that fails is
  /// invisible to the user and to the state machine.
  Future<String?> _openSession(
    String lang, {
    required bool warm,
    int warmGeneration = 0,
    bool afterConflictRepair = false,
  }) async {
    _nonce = await CallTranslationDeviceNonce.ensure();

    Map<String, dynamic> pending;
    try {
      pending = await TranslationApi.callStart(
        callRef: callRef,
        targetLang: lang,
        sourceCapability: CallTranslationAudioBridge.sourceCapability,
        deviceNonce: _nonce,
        // [CALL-TRANSLATE-2D-4] Speculative warm-ups declare themselves so the
        // Worker charges them to the WARM-UP rate bucket (120/h) rather than the
        // real-start one (60/h). Without this flag a few language-sheet opens
        // burn the payer's start budget and the next genuine tap gets a 429
        // rendered as "Live translation could not start."
        warmUp: warm,
      );
    } catch (_) {
      if (!warm) _enterFailed(CallTranslationFailure.network, 'start_unreachable');
      return 'network_unavailable';
    }
    _absorbCallRef(pending);
    final status = (pending['status'] as num?)?.toInt() ?? 0;
    if (status != 200) {
      if (status == 402 || TranslationApi.isInsufficientTokens(pending)) {
        _absorbPaidOnlyRefusal(pending);
        if (!warm) _enterFailed(CallTranslationFailure.insufficientTokens, 'start_402');
        return 'insufficient_tokens';
      }
      // [CALL-TRANSLATE-2D-4 / D-6] A 409 CARRYING A SESSION_ID IS RECOVERABLE.
      //
      // A crash or force-stop mid-session leaves the row `pending`/`activating`/
      // `active`, and so does a warm-up whose teardown `/stop` never landed. The
      // Worker then answers every later `/start` for this (payer, call_ref) with
      // `409 {error, session_id, call_ref}` — and the old code treated any
      // non-200 as fatal and THREW THE SESSION_ID AWAY, so translation was
      // unstartable for the rest of the call. That is the plan's own
      // "kill/relaunch mid-session" test failing.
      //
      // We cannot adopt the row: a 409 carries no `source_lease` and no provider
      // token, both of which `/activate` and `prepare` require. So we do the next
      // best thing — release the abandoned row and start exactly one fresh
      // session. `afterConflictRepair` makes that strictly once: a 409 that
      // survives the repair is a real conflict (another device, a live session)
      // and must not become a retry loop.
      final stale = pending['session_id']?.toString();
      if (status == 409 && stale != null && stale.isNotEmpty && !afterConflictRepair) {
        Analytics.capture('call_translation_start_conflict_repair', {
          ..._tags,
          'stale_session_id': stale,
          'warm': warm,
          'error': pending['error']?.toString() ?? '',
        });
        await _releaseRow(stale);
        return _openSession(
          lang,
          warm: warm,
          warmGeneration: warmGeneration,
          afterConflictRepair: true,
        );
      }
      if (pending['error']?.toString() == 'invalid_device_nonce') {
        // Our stored nonce is unusable. Drop it so the next attempt mints a
        // fresh one rather than failing forever on the same bad value.
        CallTranslationDeviceNonce.invalidate();
        _nonce = null;
      }
      if (!warm) _enterFailed(CallTranslationFailure.providerUnavailable, 'start_$status');
      return 'failed';
    }
    // Locals, not fields: a SUPERSEDED warm-up must never be able to overwrite
    // the id/lease of the real session that superseded it. `_id`/`_lease` are
    // committed only once this attempt is known to still be the current one.
    final sid = pending['session_id']?.toString();
    final lease = pending['source_lease']?.toString();
    final token = pending['token']?.toString();
    if (sid == null || lease == null || token == null || token.isEmpty) {
      if (sid != null) unawaited(_releaseRow(sid));
      if (!warm) _enterFailed(CallTranslationFailure.providerUnavailable, 'start_incomplete');
      return 'failed';
    }

    // A warm-up must never touch a REAL session: `prepare` tears down whatever
    // the plugin is currently running. [_warmGeneration] is bumped the moment
    // anything real starts, and these checks have no `await` between them and
    // the state they protect, so on Dart's single thread they are atomic.
    if (warm && (_warmGeneration != warmGeneration || _disposed)) {
      await _releaseRow(sid);
      return 'superseded';
    }

    _id = sid;
    _lease = lease;
    _deviceBound = pending['device_bound'] == true;
    if (pending['device_bound'] == false && _nonce != null) {
      // Not fatal — the session simply is not nonce-bound server-side. Record
      // it so a silently-unbound fleet is visible rather than assumed.
      Analytics.capture('call_translation_nonce_unbound', {..._tags, 'session_id': sid});
    }

    if (!warm && !_transition(CallTranslationState.warming, 'session_created')) {
      await _stopInternal('warming_rejected', toFailed: false);
      return 'busy';
    }

    try {
      // Gemini setupComplete is required before the backend may charge minute 1.
      await bridge.prepare(token: token, targetLanguage: lang);
    } catch (_) {
      if (warm && _warmGeneration != warmGeneration) {
        // A real `prepare` superseded ours mid-flight — the plugin errored OUR
        // future, not theirs. Release only our row; calling bridge.stop() here
        // would tear down the real session that just took over.
        if (identical(_id, sid)) {
          _id = null;
          _lease = null;
        }
        await _releaseRow(sid);
        return 'superseded';
      }
      await _stopUnbilledPending();
      if (!warm) _enterFailed(CallTranslationFailure.sourceUnavailable, 'prepare_failed');
      return 'source_capture_unavailable';
    }
    if (warm && _warmGeneration != warmGeneration) {
      if (identical(_id, sid)) {
        _id = null;
        _lease = null;
      }
      await _releaseRow(sid);
      return 'superseded';
    }
    return null;
  }

  /// Releases a session row without touching the native pipeline. Used for
  /// speculative rows that must not outlive their warm-up.
  ///
  /// [CALL-TRANSLATE-2D-4 / D-6] Retried, because a `/stop` that quietly fails is
  /// not a lost cleanup — it is a row that stays `pending` for this (payer,
  /// call_ref) and makes EVERY later `/start` answer 409. That is the same defect
  /// D-6 repairs from the other end, and the two together are what make an
  /// abandoned warm-up harmless. Still best-effort: the 409 repair in
  /// [_openSession] is the backstop when even the retries cannot reach the
  /// network.
  Future<void> _releaseRow(String id) async {
    for (var attempt = 1; attempt <= 3; attempt++) {
      try {
        final r = await TranslationApi.callStop(id);
        final status = (r['status'] as num?)?.toInt() ?? 0;
        // 404 = already gone, which is the outcome we wanted.
        if (status == 200 || status == 404) return;
      } catch (_) {}
      if (attempt == 3 || _disposed) break;
      // Short: some callers sit on the start path, and a slow cleanup would be
      // felt as a slow tap→translation.
      await Future<void>.delayed(const Duration(milliseconds: 250) * attempt);
    }
    Analytics.capture('call_translation_row_release_failed', {
      ..._tags,
      'stale_session_id': id,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // A2 — idempotent write retry
  // ───────────────────────────────────────────────────────────────────────────

  /// activate/renew are idempotent BY CONSTRUCTION server-side (deterministic
  /// per-session/per-minute op ids), so a 409 or an ambiguous timeout is safe to
  /// repeat. Without this, the crash-retry race charged the payer and then
  /// reported failure — money moved, no translation.
  ///
  /// Returns the last response; `status: 0` means every attempt threw.
  Future<Map<String, dynamic>> _writeWithRetry(
    String op,
    Future<Map<String, dynamic>> Function() call,
  ) async {
    Map<String, dynamic> last = const {'status': 0};
    for (var attempt = 1; attempt <= _kMaxWriteAttempts; attempt++) {
      try {
        final r = await call();
        last = r;
        final status = (r['status'] as num?)?.toInt() ?? 0;
        if (status != 409) return r;
        if (attempt == _kMaxWriteAttempts) return r;
        final hinted = (r['retry_after_ms'] as num?)?.toInt();
        final wait = hinted != null && hinted > 0
            ? Duration(milliseconds: hinted)
            : _kDefaultRetryAfter;
        Analytics.capture('call_translation_write_retry', {
          'op': op,
          'attempt': attempt,
          'status': status,
          'wait_ms': wait.inMilliseconds,
          ..._tags,
        });
        await Future<void>.delayed(wait * attempt);
      } catch (_) {
        last = const {'status': 0};
        if (attempt == _kMaxWriteAttempts) return last;
        Analytics.capture('call_translation_write_retry', {
          'op': op,
          'attempt': attempt,
          'status': 0,
          'wait_ms': (_kDefaultRetryAfter * attempt).inMilliseconds,
          ..._tags,
        });
        await Future<void>.delayed(_kDefaultRetryAfter * attempt);
      }
      if (_disposed) return last;
    }
    return last;
  }

  Future<void> _renewMinute() async {
    final id = _id;
    // [CALL-TRANSLATE-2C-4] `isSwitchingLanguage` is deliberately allowed: a
    // make-before-break cutover sits in `warming` (so `active` is false) while
    // the OLD session is still translating and still owes its per-minute debit.
    // Skipping the renewal here would silently stop billing a session that never
    // stopped working.
    if (id == null || (!active && !isSwitchingLanguage)) return;
    final r = await _writeWithRetry(
      'renew',
      () => TranslationApi.callRenew(id, deviceNonce: _nonce),
    );
    _absorbCallRef(r);
    final status = (r['status'] as num?)?.toInt() ?? 0;
    if (status == 200) {
      final reconciled = r['reconciled']?.toString();
      if (reconciled != null) {
        // `already_billed` → the response's billed_minute/billed_tokens are
        // AUTHORITATIVE. Do not add 5 locally on top of them.
        Analytics.capture('call_translation_reconciled', {
          'op': 'renew',
          'reconciled': reconciled,
          ..._tags,
        });
      }
      // [CALL-TRANSLATE-2D-4] `billed_tokens` is now re-read from the row
      // server-side and is AUTHORITATIVE on every 200, reconciled or not. The
      // local `+5` is a last-resort fallback for a response that omits it.
      _notify(billedTokens, (r['billed_tokens'] as num?)?.toInt() ??
          billedTokens.value + TranslationApi.ratePerMin);
      return;
    }
    if (status == 402 || TranslationApi.isInsufficientTokens(r)) {
      _absorbPaidOnlyRefusal(r);
      // Captured BEFORE the teardown: `_stopInternal` nulls `_id`, and an event
      // with an empty session_id cannot be lined up against the Worker's.
      Analytics.capture('call_translation_funds_stopped', {
        ..._tags,
        'reason': r['reason']?.toString() ?? 'balance_exhausted',
        'paid_only': _paidOnlyRefusal,
        'has_non_paid_tokens': needsPaidTopUp,
        'billed_tokens': billedTokens.value,
      });
      await _stopInternal('funds_exhausted', toFailed: false);
      _enterFailed(CallTranslationFailure.insufficientTokens, 'renew_402');
      return;
    }
    if (status == 0) {
      await _failFromProvider('billing_unreachable');
      return;
    }
    await _failFromProvider('renewal_rejected_$status');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // native events → transitions
  // ───────────────────────────────────────────────────────────────────────────

  void _onBridgeEvent(CallTranslationAudioEvent event) {
    if (_disposed) return;
    switch (event.type) {
      case 'ready':
        // Informational: the provider socket reached setupComplete. The paid
        // boundary is crossed by /activate, not by this.
        break;

      case 'stalled':
        // The PLUGIN has already un-muted the original audio — Dart is only
        // reflecting it. Do not touch the mute here or the two owners fight.
        _stallCount = event.intOf('stallCount', _stallCount);
        _fallbackCount = event.intOf('fallbackCount', _fallbackCount);
        _notify(fallbackToOriginal, true);
        // [CALL-TRANSLATE-2D-4] `deadAir` is now the authoritative discriminator
        // (the native counters are split on it too). A deliberate fallback — a
        // Phase C cutover, a route swap, a focus blip — is NOT a stall: reporting
        // it as one would lie to the user AND spam the illegal-transition
        // counter, since a switch sits in `warming`.
        if (event.boolOf('deadAir', !_isSwitchFallback(event))) {
          // NATIVE now owns the fallback. Nothing in Dart may lower it.
          _nativeFallbackHeld = true;
          // [CALL-TRANSLATE-2D-5] …but a fallback nobody can lower is not a
          // resting state we may bill indefinitely. The guard fires only while
          // input audio is flowing, so this is "they are speaking and nothing
          // comes back": give it a deadline, then stop cleanly.
          _armDeadTranslationWatchdog();
          _transition(CallTranslationState.stalled, 'native_stalled_${event.value ?? 'unknown'}');
        }
        break;

      case 'recovered':
        _stallCount = event.intOf('stallCount', _stallCount);
        _stallMsTotal = event.intOf('stallMsTotal', _stallMsTotal);
        _fallbackCount = event.intOf('fallbackCount', _fallbackCount);
        _fallbackMsTotal = event.intOf('fallbackMsTotal', _fallbackMsTotal);
        unawaited(_onNativeRecovered(event));
        break;

      case 'switch_cancelled':
        // [CALL-TRANSLATE-2D-4] Acknowledgement that a pending socket was
        // abandoned (by our own `cancelSwitch`, or superseded by another). The
        // live session is untouched, so there is no state change to make — this
        // exists so an abandoned-cutover rate is visible in telemetry.
        Analytics.capture('call_translation_switch_cancelled', {
          ..._tags,
          'reason': event.value ?? '',
          'live_language': event.data['liveLanguage']?.toString() ?? '',
        });
        break;

      case 'stall_degraded':
        // 2+ stall/recover cycles in the window. Still translating — warn only.
        _notify(qualityDegraded, true);
        _stallCount = event.intOf('stallCount', _stallCount);
        _stallMsTotal = event.intOf('stallMsTotal', _stallMsTotal);
        Analytics.capture('call_translation_degraded', {
          ..._tags,
          'cycles_in_window': event.intOf('cyclesInWindow'),
          'window_ms': event.intOf('windowMs'),
          'stall_count': _stallCount,
          'stall_ms_total': _stallMsTotal,
        });
        break;

      case 'stats':
        _absorbStats(event);
        break;

      case 'resume_token_needed':
        final handle = event.value;
        if (handle != null && handle.isNotEmpty) {
          _lastResumeHandle = handle;
          unawaited(_resumeProvider(handle));
        }
        break;

      case 'language_switched':
        // [CALL-TRANSLATE-2C-4] The cutover completed: a pending socket replaced
        // a LIVE one and the language actually changed. Ordering guarantee from
        // the plugin: `ready` fires first, then this.
        _onLanguageSwitched(event);
        break;

      case 'resume_failed':
        if (event.boolOf('switching')) {
          // [CALL-TRANSLATE-2C-4] The PENDING socket died. The plugin commits
          // its language field only at a successful swap, so the live session
          // and the language it is speaking are untouched — this is a failed
          // SWITCH, not a failed session. Stay where we are and toast.
          unawaited(_failSwitch('pending_socket_failed', extra: {
            // Language CODES only, straight from the plugin. Never content.
            'attempted_language': event.data['attemptedLanguage']?.toString() ?? '',
            'live_language': event.data['liveLanguage']?.toString() ?? '',
            // [CALL-TRANSLATE-2D-4] `resume_failed` is now ALSO emitted from the
            // plugin's CLOSE path, where `value` is `closed_<code>` and this
            // extra carries the numeric code. A provider that refuses a switch
            // token answers with a close frame, so this is the common shape.
            // Both are fixed CATEGORIES — never parse them as prose.
            'failure': event.value ?? '',
            'close_code': event.intOf('closeCode', -1),
          }));
          break;
        }
        // [CALL-TRANSLATE-2A-3] Previously ignored: the pill showed "active" on
        // a dead provider session. The resume socket is gone; the breaker
        // decides whether one more attempt is allowed.
        Analytics.capture('call_translation_resume_failed', {
          ..._tags,
          // Fixed category: an exception class name, or `closed_<code>` when the
          // plugin's close path raised it. Never provider prose.
          'failure': event.value ?? '',
          'close_code': event.intOf('closeCode', -1),
          'resumes': _resumeCount,
        });
        unawaited(_handleResumeFailed());
        break;

      case 'provider_error':
      case 'provider_closed':
      case 'bridge_error':
      case 'protocol_error':
        unawaited(_failFromProvider(event.type));
        break;

      default:
        // Unknown/forward-compatible event: log, never throw.
        AvaLog.I.log('calltranslate', 'unhandled bridge event ${event.type}');
    }
  }

  void _absorbStats(CallTranslationAudioEvent event) {
    _stallCount = event.intOf('stallCount', _stallCount);
    _stallMsTotal = event.intOf('stallMsTotal', _stallMsTotal);
    _fallbackCount = event.intOf('fallbackCount', _fallbackCount);
    _fallbackMsTotal = event.intOf('fallbackMsTotal', _fallbackMsTotal);
    _pcmDropCount = event.intOf('pcmDropCount', _pcmDropCount);
    _uplinkFailCount = event.intOf('uplinkFailCount', _uplinkFailCount);
    _shortWriteCount = event.intOf('shortWriteCount', _shortWriteCount);
    _queuePeak = event.intOf('queuePeak', _queuePeak);
    // `fallbackActive` is the PLUGIN's real mute state and therefore the
    // authority. If it says the original is muted again, every owner has been
    // released natively — drop our bookkeeping to match rather than holding a
    // reason that can never be lowered.
    final pluginFallback = event.boolOf('fallbackActive', _fallbackHeld);
    if (!pluginFallback && _fallbackHeld) _clearFallbackOwners();
    _notify(fallbackToOriginal, pluginFallback);

    if (_firstAudioMs == null && event.intOf('translatedChunkCount') > 0 && _tapAtMs > 0) {
      _firstAudioMs = DateTime.now().millisecondsSinceEpoch - _tapAtMs;
      _firstAudioPoll?.cancel();
      _firstAudioPoll = null;
      // tap → first translated audio. p50/p95 are computed in PostHog.
      unawaited(Analytics.uiInteraction(
        'call_translation_first_audio',
        _firstAudioMs!,
        phase: 'interactive',
        source: 'network',
        extra: {..._tags, 'language': targetLanguage.value ?? ''},
      ));
    }

    // Far edge of `switch_gap_ms`: the first translated chunk produced by the
    // NEW language's socket. `switchLanguage` does NOT reset the native counters
    // (only `prepare` does), so this is measured against a baseline sampled at
    // the swap rather than against zero.
    if (_switchGapStartMs > 0) {
      final chunks = event.intOf('translatedChunkCount');
      if (_switchGapBaselineChunks < 0) {
        _switchGapBaselineChunks = chunks;
      } else if (chunks > _switchGapBaselineChunks) {
        _resolveSwitchGap('stats');
      }
    }

    if (event.boolOf('final') || event.value == 'final') {
      _emitQualityTelemetry('native_final', uptimeMs: event.intOf('uptimeMs'));
    }
  }

  /// A `stats` event only arrives every 30 s on its own, which is far too
  /// coarse to time first-audio. Poll for the first few seconds instead; the
  /// plugin serves `stats` synchronously and the poller self-cancels on the
  /// first non-zero translated-chunk count.
  void _startFirstAudioProbe() {
    _firstAudioPolls = 0;
    _firstAudioPoll?.cancel();
    _firstAudioPoll = Timer.periodic(const Duration(milliseconds: 500), (t) {
      _firstAudioPolls++;
      if (_disposed || _firstAudioMs != null || _firstAudioPolls > 60 || !active) {
        t.cancel();
        _firstAudioPoll = null;
        return;
      }
      unawaited(bridge.requestStats());
    });
  }

  void _emitQualityTelemetry(String at, {int? uptimeMs}) {
    Analytics.capture('call_translation_quality', {
      'at': at,
      ..._tags,
      'language': targetLanguage.value ?? '',
      // [CALL-TRANSLATE-2D-4] stall_* is DEAD AIR ONLY (the plugin narrowed the
      // semantics); deliberate fallbacks are reported separately. The launch
      // gate's p95 stall thresholds read the stall pair, so merging them back
      // together would make a clean language switch look like a quality
      // incident and move the threshold for everyone.
      'stall_count': _stallCount,
      'stall_ms': _stallMsTotal,
      'fallback_count': _fallbackCount,
      'fallback_ms': _fallbackMsTotal,
      'resume_count': _resumeCount,
      'pcm_drop_count': _pcmDropCount,
      'uplink_fail_count': _uplinkFailCount,
      'short_write_count': _shortWriteCount,
      'queue_peak': _queuePeak,
      'provider_failures': _providerFailures,
      'degraded': qualityDegraded.value,
      if (_firstAudioMs != null) 'first_audio_ms': _firstAudioMs!,
      if (uptimeMs != null) 'uptime_ms': uptimeMs,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // provider failure + circuit breaker
  // ───────────────────────────────────────────────────────────────────────────

  Future<void> _handleResumeFailed() async {
    _providerFailures++;
    if (circuitOpen) {
      await _stopInternal('resume_failed_native', toFailed: false);
      _enterFailed(CallTranslationFailure.circuitOpen, 'resume_failed_native');
      return;
    }
    final handle = _lastResumeHandle;
    if (handle == null || !_transition(CallTranslationState.recovering, 'resume_failed_retry')) {
      await _stopInternal('resume_failed_native', toFailed: false);
      _enterFailed(CallTranslationFailure.providerUnavailable, 'resume_failed_native');
      return;
    }
    await _resumeProvider(handle, alreadyRecovering: true);
  }

  /// Every provider-side failure lands here. Increments the breaker, stops the
  /// session (restoring original audio), and reports the right failure class.
  Future<void> _failFromProvider(String reason) async {
    if (state.value == CallTranslationState.idle ||
        state.value == CallTranslationState.stopping ||
        state.value == CallTranslationState.failed) {
      return;
    }
    _providerFailures++;
    await _stopInternal(reason, toFailed: false);
    _enterFailed(
      circuitOpen ? CallTranslationFailure.circuitOpen : CallTranslationFailure.providerUnavailable,
      reason,
    );
    Analytics.capture('call_translation_provider_stopped', {
      'reason': reason,
      'provider_failures': _providerFailures,
      'circuit_open': circuitOpen,
      ..._tags,
    });
  }

  Future<void> _resumeProvider(String handle, {bool alreadyRecovering = false}) async {
    final id = _id;
    if (id == null || _resumingProvider) return;
    // [CALL-TRANSLATE-2D-4 / L-6] The circuit breaker counts FAILURES, and a
    // resume that succeeds is not one — so a provider that issues `goAway` after
    // every successful resume never trips it. The only thing that stopped the
    // loop was `/token`'s 24/hour rate limit, i.e. ~24 reconnects an hour before
    // the user saw anything, each one a gap in their call. Resumes are therefore
    // budgeted per call in their own right; exhausting the budget is a provider
    // failure like any other and opens the breaker.
    if (_resumeCount >= kMaxResumesPerCall) {
      Analytics.capture('call_translation_resume_budget_exhausted', {
        ..._tags,
        'resumes': _resumeCount,
        'budget': kMaxResumesPerCall,
      });
      _providerFailures = kMaxProviderFailuresPerCall;
      await _failFromProvider('resume_budget_exhausted');
      return;
    }
    if (!alreadyRecovering) {
      if (!active) return;
      if (!_transition(CallTranslationState.recovering, 'resume_token_needed')) return;
    }
    _resumingProvider = true;
    _resumeCount++;
    try {
      // [CALL-TRANSLATE-2C-2] `/token` mints against whatever language the ROW
      // holds. If a sheet-open pre-mint speculatively moved the row, that is NOT
      // the language the plugin is speaking, and the resumed socket would
      // announce the old language against a token constrained to the new one —
      // which the provider rejects. Repair the row before minting.
      await _restoreSpeculativeRow();
      final response = await TranslationApi.callToken(id, deviceNonce: _nonce);
      final status = (response['status'] as num?)?.toInt() ?? 0;
      if (status != 200) throw StateError('token rejected');
      final token = response['token']?.toString();
      if (token == null || token.isEmpty) throw StateError('token missing');
      await bridge.resume(token: token, handle: handle);
      _transition(CallTranslationState.active, 'resumed');
    } catch (_) {
      await _failFromProvider('resume_failed');
    } finally {
      _resumingProvider = false;
    }
  }

  void _enterFailed(CallTranslationFailure why, String reason) {
    _notify(failure, why);
    _transition(CallTranslationState.failed, reason);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // stop / teardown
  // ───────────────────────────────────────────────────────────────────────────

  /// User-initiated stop.
  Future<void> stop() async {
    final hadSession = _id != null;
    final sessionId = _id ?? '';
    await _stopInternal('user_stop', toFailed: false);
    if (!_disposed && state.value != CallTranslationState.failed) {
      _transition(CallTranslationState.idle, 'stopped');
      _notify(failure, CallTranslationFailure.none);
    }
    if (hadSession) {
      Analytics.capture('call_translation_stopped', {
        ..._tags,
        'session_id': sessionId,
        'billed_tokens': billedTokens.value,
      });
    }
  }

  /// The single tear-down path. ALWAYS stops the bridge first (which restores
  /// the original decoded audio) and only then releases the server row, so a
  /// hung network call can never leave the user listening to silence.
  Future<void> _stopInternal(String reason, {required bool toFailed}) async {
    _renew?.cancel();
    _clock?.cancel();
    _firstAudioPoll?.cancel();
    _fallbackRelease?.cancel();
    _switchGapPoll?.cancel();
    _switchCutoverTimer?.cancel();
    _switchFallbackCeiling?.cancel();
    _deadTranslation?.cancel();
    _renew = null;
    _clock = null;
    _firstAudioPoll = null;
    _switchGapPoll = null;
    _switchCutoverTimer = null;
    _switchFallbackCeiling = null;
    _deadTranslation = null;
    // A switch in flight is over the moment the session is: nothing may be left
    // holding `warming` semantics, an unresolved gap measurement, or a caller
    // awaiting a cutover that can no longer happen.
    _switchTarget = null;
    _switchGapStartMs = 0;
    _switchGapBaselineChunks = -1;
    _queuedSwitch = null;
    _notify(switchingTo, null);
    final pendingSwitch = _switchCompleter;
    _switchCompleter = null;
    if (pendingSwitch != null && !pendingSwitch.isCompleted) {
      // NOT 'switch_failed': the session is going away for its own reasons (user
      // stop, teardown, provider failure) and each of those already has its own
      // UI. A "could not switch language" toast on top would be noise.
      pendingSwitch.complete('stopped');
    }
    _warmGeneration++;
    _warmToken = null;
    _warmLang = null;
    _warmSessionReady = false;
    _speculativeRowLang = null;
    if (state.value != CallTranslationState.idle &&
        state.value != CallTranslationState.failed) {
      _transition(CallTranslationState.stopping, reason);
    }
    if (_id != null) _emitQualityTelemetry(reason);
    // `stop` restores the original audio unconditionally and resets the plugin's
    // own fallback state, so every owner is released by definition.
    _clearFallbackOwners();
    await bridge.stop();
    _notify(fallbackToOriginal, false);
    final id = _id;
    _id = null;
    _lease = null;
    _lastResumeHandle = null;
    if (id != null) {
      // Stop is never nonce-gated and its failure is never fatal — but the row
      // must not leak, so it is always attempted.
      try {
        await TranslationApi.callStop(id);
      } catch (_) {}
    }
    if (toFailed) _transition(CallTranslationState.failed, reason);
  }

  Future<void> _stopUnbilledPending() async {
    _clearFallbackOwners();
    await bridge.stop();
    final id = _id;
    _id = null;
    _lease = null;
    // [CALL-TRANSLATE-2D-4 / D-6] Retried in the BACKGROUND. The native stop is
    // what the caller must wait for (a new `prepare` cannot run over a live
    // pipeline); the row release only has to happen, not to happen now — and
    // this runs on the start path, where blocking on a retrying HTTP call would
    // be felt directly as a slow tap→translation.
    if (id != null) unawaited(_releaseRow(id));
  }

  /// A stopped lease cannot be resumed silently; the caller must start a new
  /// minute/session so each paid boundary is explicit and idempotent.
  Future<bool> resumeAfterTopUp() async => false;

  // ───────────────────────────────────────────────────────────────────────────
  // B2 — Android lifecycle matrix
  //
  //  screen lock / backgrounding  → SURVIVE. The call runs under the call
  //      foreground service; translation keeps streaming and keeps billing.
  //      `detached` is the exception: the process is going away, so stop
  //      cleanly and release the row rather than leaking it.
  //  Bluetooth / wired route change → SURVIVE, riding NativeVoiceAudio's
  //      confirmed `routeEvents` (never a parallel route path of our own). The
  //      device swap silences the stream for a beat, so fall back to original
  //      audio across the swap and re-mute once it settles.
  //  audio-focus loss → SURVIVE degraded: fall back to original audio so the
  //      user is not left with a muted original AND a translation the OS has
  //      ducked. Re-mute on regain.
  //  incoming cellular call → STOP cleanly. Our call audio is gone entirely;
  //      continuing to bill 5 Tokens/min for a stream nobody hears is wrong.
  // ───────────────────────────────────────────────────────────────────────────

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    switch (state) {
      case AppLifecycleState.detached:
        unawaited(stop());
        break;
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
        if (active) {
          Analytics.capture('call_translation_lifecycle', {
            'event': state.name,
            'action': 'survive',
            ..._tags,
          });
        }
        break;
      case AppLifecycleState.resumed:
      case AppLifecycleState.inactive:
        break;
    }
  }

  void _watchAudioRoute() {
    try {
      _routeEvents = NativeVoiceAudio.instance.routeEvents.listen((result) {
        if (_disposed || !active) return;
        Analytics.capture('call_translation_lifecycle', {
          'event': 'audio_route',
          'action': 'fallback_bridge',
          'active_route': result.active.name,
          ..._tags,
        });
        _fallbackAcross(const Duration(milliseconds: 1500), 'route_change');
      });
    } catch (e) {
      AvaLog.I.log('calltranslate', 'route watch unavailable: $e');
    }
    _hookAudioFocus();
  }

  void _watchTelephony() {
    try {
      _telephonyEvents = NativeVoiceAudio.instance.telephonyEventStream.listen((event) {
        if (_disposed) return;
        if (event['state']?.toString() == 'held' && active) {
          Analytics.capture('call_translation_lifecycle', {
            'event': 'cellular_interruption',
            'action': 'stop',
            ..._tags,
          });
          unawaited(stop());
        }
      }, onError: (_) {});
    } catch (e) {
      AvaLog.I.log('calltranslate', 'telephony watch unavailable: $e');
    }
  }

  /// `onAudioFocusLost/Regained` are single-assignment callbacks owned by
  /// CallSession (they drive call hold). We CHAIN rather than replace: the
  /// previous handler is captured and invoked first, and on dispose we restore
  /// it only if ours is still installed — so a later CallSession assignment is
  /// never clobbered.
  void _hookAudioFocus() {
    final nva = NativeVoiceAudio.instance;
    _prevFocusLost = nva.onAudioFocusLost;
    _prevFocusRegained = nva.onAudioFocusRegained;
    _ourFocusLost = () {
      _prevFocusLost?.call();
      if (_disposed || !active) return;
      Analytics.capture('call_translation_lifecycle', {
        'event': 'audio_focus_lost',
        'action': 'fallback_original',
        ..._tags,
      });
      unawaited(_raiseFallback('audio_focus_lost'));
    };
    _ourFocusRegained = () {
      _prevFocusRegained?.call();
      if (_disposed) return;
      // Releases OUR reason by name. If the dead-air guard is holding the
      // fallback, this is a no-op: re-muting here would put the user back into
      // silence on a translation that is still dead (the D-1 bug).
      unawaited(_lowerFallback('audio_focus_lost'));
    };
    nva.onAudioFocusLost = _ourFocusLost;
    nva.onAudioFocusRegained = _ourFocusRegained;
  }

  void _unhookAudioFocus() {
    final nva = NativeVoiceAudio.instance;
    if (identical(nva.onAudioFocusLost, _ourFocusLost)) nva.onAudioFocusLost = _prevFocusLost;
    if (identical(nva.onAudioFocusRegained, _ourFocusRegained)) {
      nva.onAudioFocusRegained = _prevFocusRegained;
    }
    _ourFocusLost = null;
    _ourFocusRegained = null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // [CALL-TRANSLATE-2D-4 / D-1] FALLBACK OWNER MODEL — read this before touching
  // anything that calls setFallback.
  //
  // "Fallback" = the plugin un-mutes the ORIGINAL decoded call audio and stops
  // muting it behind the translation. It is a SINGLE physical switch with TWO
  // classes of owner, and the bug this model exists to kill was a shared boolean
  // with none: `_fallbackAcross`'s 1500 ms timer and `_ourFocusRegained` both
  // called setFallback(false) UNCONDITIONALLY, so a route change or a focus blip
  // during a dead-air stall RE-MUTED the original while translation was still
  // dead — manufactured dead air, repeatable, and needing another 2 s of voiced
  // input before the native guard could fire again.
  //
  // THE RULE: **an owner may lower only a fallback it raised itself.**
  //
  //  • NATIVE owns the dead-air fallback ([_nativeFallbackHeld]). It raises it
  //    (`stalled` with deadAir:true) and lowers it (`recovered` with
  //    deadAir:true) on the new session's first SUSTAINED translated PCM. Dart
  //    NEVER lowers it — there is deliberately no code path that can.
  //  • DART owns its deliberate reasons ([_dartFallbackReasons]): 'switching'
  //    (Phase C cutover), 'route_change', 'audio_focus_lost'. Each is raised and
  //    lowered by name; lowering a reason we do not hold is a no-op.
  //  • The plugin is un-muted only when NOBODY holds a reason. The physical
  //    setFallback(false) is issued exactly once, by whoever releases last.
  //  • The plugin's own guard may also drop a DELIBERATE fallback once translated
  //    PCM resumes (`recovered` with deadAir:false, carrying the tag). That is
  //    authoritative — we drop the matching reason and re-assert only if a
  //    DIFFERENT Dart reason is still outstanding, so the same reason can never
  //    flap against the guard.
  // ───────────────────────────────────────────────────────────────────────────

  /// Deliberate fallback reasons Dart itself raised. Dart may lower ONLY these.
  final Set<String> _dartFallbackReasons = <String>{};

  /// True while the NATIVE dead-air guard holds the fallback. Only a `recovered`
  /// event with `deadAir: true` (or a full teardown) clears it — never Dart.
  bool _nativeFallbackHeld = false;

  bool get _fallbackHeld => _nativeFallbackHeld || _dartFallbackReasons.isNotEmpty;

  /// Raise the fallback for a reason DART owns.
  Future<void> _raiseFallback(String reason) async {
    if (_disposed) return;
    final wasHeld = _fallbackHeld;
    _dartFallbackReasons.add(reason);
    _notify(fallbackToOriginal, true);
    // A duplicate raise is a native no-op, but skipping it keeps the plugin's
    // fallbackReason (and therefore its stall-vs-deliberate accounting) owned by
    // whoever raised FIRST, which is what the counters assume.
    if (!wasHeld) await bridge.setFallback(enabled: true, reason: reason);
  }

  /// Lower a reason DART owns. Lowering something we did not raise — the D-1
  /// bug — is silently ignored, and the plugin stays un-muted as long as ANY
  /// owner still holds it.
  Future<void> _lowerFallback(String reason) async {
    if (!_dartFallbackReasons.remove(reason)) return;
    if (_fallbackHeld) return; // someone else (usually the dead-air guard) holds it
    _notify(fallbackToOriginal, false);
    if (_disposed) return;
    await bridge.setFallback(enabled: false, reason: reason);
  }

  /// The plugin dropped the fallback and re-muted the original by itself. Which
  /// owner it just released is told by `deadAir`, and the release is
  /// AUTHORITATIVE — the plugin is un-muted no matter what our bookkeeping says.
  /// We therefore reconcile rather than argue, and re-assert only if a DIFFERENT
  /// Dart reason is still outstanding (re-asserting the same one would flap
  /// against the guard forever).
  Future<void> _onNativeRecovered(CallTranslationAudioEvent event) async {
    final deadAir = event.boolOf('deadAir', !_isSwitchFallback(event));
    final tag = event.data['reason']?.toString() ?? event.value ?? '';
    if (deadAir) {
      _nativeFallbackHeld = false;
      // [CALL-TRANSLATE-2D-5] Translated PCM is flowing again — the session is
      // producing audio, so it is allowed to keep billing.
      _deadTranslation?.cancel();
      _deadTranslation = null;
    } else if (tag.isNotEmpty) {
      _dartFallbackReasons.remove(tag);
    }
    final remaining = _dartFallbackReasons.isEmpty ? null : _dartFallbackReasons.first;
    if (_nativeFallbackHeld || remaining != null) {
      _notify(fallbackToOriginal, true);
      if (remaining != null && !_nativeFallbackHeld && !_disposed) {
        // The plugin re-muted, but we still owe the user original audio for a
        // different reason. Re-raise it explicitly rather than leaving the
        // notifier and the plugin disagreeing.
        await bridge.setFallback(enabled: true, reason: remaining);
      }
    } else {
      _notify(fallbackToOriginal, false);
    }

    if (!deadAir && _isSwitchFallback(event)) {
      // First SUSTAINED translated PCM from the NEW language — the far edge of
      // the switch gap.
      _resolveSwitchGap('native_recovered');
      return;
    }
    if (deadAir) _transition(CallTranslationState.active, 'native_recovered');
  }

  /// Forget every owner without touching the plugin. Teardown only: `bridge.stop`
  /// restores the original audio unconditionally, so there is nothing to release.
  void _clearFallbackOwners() {
    _dartFallbackReasons.clear();
    _nativeFallbackHeld = false;
    // [CALL-TRANSLATE-2D-5] Both deadlines exist only to bound a HELD fallback.
    // Nobody holds one now (either the plugin says so in `stats`, or we are
    // tearing down), so neither may survive to fire against a later session.
    _switchFallbackCeiling?.cancel();
    _switchFallbackCeiling = null;
    _deadTranslation?.cancel();
    _deadTranslation = null;
  }

  /// [CALL-TRANSLATE-2D-5] Arm the dead-translation deadline. Idempotent-ish by
  /// design: a re-raise restarts the clock, because each raise is a fresh
  /// dead-air episode rather than a continuation of the previous one.
  void _armDeadTranslationWatchdog() {
    if (_disposed) return;
    _deadTranslation?.cancel();
    _deadTranslation = Timer(_kDeadTranslationDeadline, () {
      unawaited(_stopDeadTranslation());
    });
  }

  /// The deadline expired: the guard has been holding the fallback — i.e. the
  /// far end has been speaking and no translated audio has come back — for
  /// [_kDeadTranslationDeadline]. Stop rather than bill another minute of it.
  ///
  /// Routed through [_failFromProvider] on purpose: this IS a provider failure,
  /// so it should count against the circuit breaker, tear down through the one
  /// invariant-respecting path (`bridge.stop` restores the original audio
  /// unconditionally), leave the machine in `failed`/`providerUnavailable` — so
  /// the pill stops claiming it is translating and the overlay surfaces
  /// "Translation stopped … your call is still connected" — and cancel `_renew`,
  /// which is what actually stops the 5 Tokens/min.
  Future<void> _stopDeadTranslation() async {
    _deadTranslation = null;
    if (_disposed || _id == null || !_nativeFallbackHeld) return;
    Analytics.capture('call_translation_dead_translation', {
      ..._tags,
      // Language CODES and timings only — never transcript text or audio.
      'language': targetLanguage.value ?? '',
      'deadline_ms': _kDeadTranslationDeadline.inMilliseconds,
      // True when this dead session is the one a language cutover handed us,
      // which is the case the switch watchdog exists for.
      'after_language_switch': _switchGapStartMs > 0,
      'elapsed_seconds': elapsedSeconds.value,
      'billed_tokens': billedTokens.value,
      'stall_count': _stallCount,
      'resume_count': _resumeCount,
    });
    await _failFromProvider('dead_translation');
  }

  /// Fall back to the original audio for [window], then release OUR reason. Used
  /// for transient events (route swap) where the stream is briefly unusable.
  /// The release is a no-op if the dead-air guard has taken the fallback over in
  /// the meantime — that is the whole point of the owner model.
  void _fallbackAcross(Duration window, String reason) {
    _fallbackRelease?.cancel();
    unawaited(_raiseFallback(reason));
    _fallbackRelease = Timer(window, () {
      if (_disposed) return;
      unawaited(_lowerFallback(reason));
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // [CALL-TRANSLATE-2C-2] Phase C — mid-call language switching
  //
  // The payer changes target language from the ongoing call screen. No stop, no
  // confirm, no second billing session: `/call/:id/language` updates the SAME
  // row and mints a token for the new language. started_at, last_billed_minute
  // and billed_tokens are untouched — the per-minute clock keeps ticking and a
  // switch itself is free.
  //
  // [CALL-TRANSLATE-2C-4] TRUE MAKE-BEFORE-BREAK — read before changing it
  // ---------------------------------------------------------------------------
  // Phase C originally cut over SEQUENTIALLY (`prepare` tore the live socket
  // down before the new one existed) because the plugin's pending-socket path
  // built its setup frame from `this.targetLanguage`, which only `prepare` ever
  // assigned — so a pending socket could not announce a NEW language. Commit
  // 3af9fd72 fixed that natively. The cutover is now:
  //
  //   1. `/language` updates the SAME row and mints a token for the new
  //      language, while the OLD session keeps translating normally.
  //   2. `bridge.switchLanguage(token, lang)` opens a SECOND socket announcing
  //      the new language. The live socket is untouched and still translating —
  //      there is no teardown, no un-mute, and nothing to recover from.
  //   3. The plugin swaps them at the new socket's `setupComplete` (its commit
  //      point for the language field), closes the old socket and emits
  //      `language_switched`. THAT event — not the method future — is the
  //      cutover-completed signal.
  //   4. On `language_switched` Dart raises `setFallback(true, 'switching')` so
  //      the user hears the real speaker across the new pipeline's refill. This
  //      stays the safety net rather than the main mechanism: the A4 dead-air
  //      guard would raise it anyway after 2 s of no translated PCM, and the
  //      guard drops it again on the new session's first SUSTAINED translated
  //      PCM (~200 ms of audio, min 800 ms of fallback — an anti-flap floor, not
  //      a gap). Nothing re-mutes by hand.
  //
  // ORDER STILL LOAD-BEARING: any `setFallback(true)` must precede a `commitPaid`
  // because `applyOutputMute()` evaluates `paid && active && !fallbackActive`.
  // A switch no longer calls activate/commitPaid AT ALL — `switchLanguage` never
  // resets the plugin's `active`/`paid`/telemetry state the way `prepare` does —
  // so the constraint only binds `start()` today. Do not reintroduce a
  // commitPaid here without putting the setFallback before it.
  //
  // FAILURE IS NOW CHEAP: if the pending socket dies the plugin emits
  // `resume_failed` with `switching: true` and leaves the live session and its
  // language untouched, so "stay on the old session + toast" is literally free.
  // The old post-cutover `_recoverToLanguage` re-prepare existed ONLY because
  // the sequential design had already destroyed the old socket; it is gone.
  // ───────────────────────────────────────────────────────────────────────────

  String? _switchTarget;
  int _switchStartedAtMs = 0;

  /// Completes when the in-flight cutover resolves: null on success
  /// (`language_switched`), a stable error code on failure. The native
  /// `switchLanguage` future only means "the second socket is being opened", so
  /// the public [switchLanguage] awaits THIS instead.
  Completer<String?>? _switchCompleter;

  /// `switchLanguage` has no native timeout of its own (unlike `prepare`, which
  /// self-fails after 15 s), and a pending socket that never reaches
  /// `setupComplete` would otherwise block every future switch with
  /// `switch_in_flight`. Dart owns the deadline.
  Timer? _switchCutoverTimer;

  /// Non-zero while a `switch_gap_ms` measurement is open.
  int _switchGapStartMs = 0;
  String _switchGapLang = '';
  int _switchGapPolls = 0;

  /// `translatedChunkCount` observed at the instant of the cutover. Unlike
  /// `prepare`, `switchLanguage` does NOT reset the native counters, so the far
  /// edge of the gap is "count went UP from this baseline", not "count > 0".
  /// -1 means the baseline sample has not landed yet.
  int _switchGapBaselineChunks = -1;

  /// How much pre-switch silence may still be attributed to the switch. The old
  /// session stops producing translated PCM whenever nobody is speaking, so a
  /// `sinceLastAudioMs` larger than this is call silence, not a switch gap.
  static const int _kMaxAttributableSilenceMs = 3000;

  /// Latest-only queue. A user flicking through three languages must produce ONE
  /// more cutover, to the last one they touched — not three.
  String? _queuedSwitch;

  bool get isSwitchingLanguage => _switchTarget != null;

  /// The language a switch is cutting over to, for the pill's "Switching to X…".
  String? get switchTarget => _switchTarget;

  /// True when a switch may start right now.
  bool get canSwitchLanguage =>
      state.value == CallTranslationState.active && _id != null && !isSwitchingLanguage;

  /// PUBLIC ENTRY POINT for a mid-call switch. Returns null on success, else a
  /// stable code the overlay turns into a toast. Never throws, and on every
  /// failure path the call itself is left usable.
  Future<String?> switchLanguage(String lang) async {
    if (_disposed) return 'busy';
    if (lang.isEmpty || lang == targetLanguage.value) return null;
    if (!available) return 'disabled';
    if (isSwitchingLanguage) {
      // Guardrail: exactly one in-flight switch. Remember only the LATEST ask.
      _queuedSwitch = lang;
      Analytics.capture('call_translation_language_switch_queued', {
        ..._tags,
        'language': lang,
      });
      return null;
    }
    if (!canSwitchLanguage) return 'busy';

    final error = await _runSwitch(lang);

    // Drain the latest-only queue once, not recursively — a queued value that is
    // already live, or that arrived while we were failing, is simply dropped.
    final queued = _queuedSwitch;
    _queuedSwitch = null;
    if (queued != null && queued != targetLanguage.value && canSwitchLanguage) {
      return _runSwitch(queued);
    }
    return error;
  }

  Future<String?> _runSwitch(String lang) async {
    final id = _id;
    if (id == null) return 'busy';
    if (!_beginLanguageSwitch(lang)) return 'busy';

    // ── step 1: row update + token mint (old session still translating) ──────
    String? token = _claimWarmToken(lang);
    if (token != null) {
      // The pre-mint already moved the ROW to `lang`. Under make-before-break a
      // failed cutover STAYS on the old session, so the row now disagrees with
      // what the plugin is speaking and must be repairable — record it. It is
      // cleared only when the cutover actually completes.
      _speculativeRowLang = lang;
    } else {
      Map<String, dynamic> r;
      try {
        r = await TranslationApi.callLanguage(id, targetLang: lang, deviceNonce: _nonce);
      } catch (_) {
        await _abortLanguageSwitch('language_unreachable', restoreRow: false);
        return 'network_unavailable';
      }
      final status = (r['status'] as num?)?.toInt() ?? 0;
      if (status == 200) {
        token = r['token']?.toString();
        _speculativeRowLang = lang;
      } else if (status == 502) {
        // TRAP: on 502 the ROW IS ALREADY on the new language; only the mint
        // failed. Retry the mint via /token, which now returns the new language.
        _speculativeRowLang = lang;
        token = await _mintForCurrentRow(id);
      } else if (status == 409 && r['error']?.toString() == 'call_ended') {
        await _abortLanguageSwitch('call_ended', restoreRow: false);
        unawaited(stop());
        return 'call_ended';
      } else {
        await _abortLanguageSwitch('language_$status', restoreRow: false);
        return status == 403
            ? 'device_mismatch'
            : status == 400
                ? 'unsupported_language'
                : 'switch_failed';
      }
    }
    if (token == null || token.isEmpty) {
      // Nothing has been opened yet: the OLD socket has not been touched, so we
      // simply stay on it (restoring the row if /language already moved it).
      await _abortLanguageSwitch('mint_failed', restoreRow: true);
      return 'switch_failed';
    }

    // ── step 2: open the SECOND socket. The live one keeps translating. ──────
    // Past this line NOTHING about the live session has changed, and nothing
    // will until the plugin reports `language_switched`.
    _switchStartedAtMs = DateTime.now().millisecondsSinceEpoch;
    final completer = Completer<String?>();
    _switchCompleter = completer;
    try {
      await bridge.switchLanguage(
        token: token,
        targetLanguage: lang,
        // Deliberately NO resumption handle: it belongs to the OLD-language
        // session, and what a resumed session restores is provider-defined —
        // if it restored the old target language the switch would report
        // success while the user still heard the old language, which nothing
        // client-side can detect. A fresh session's only cost is one handshake,
        // and make-before-break already hides that behind the live socket.
        handle: null,
      );
    } catch (e) {
      _switchCompleter = null;
      final code = e is PlatformException ? e.code : 'switch_channel_error';
      if (code == 'switch_in_flight') {
        // Belt and braces: [canSwitchLanguage] + [_switchTarget] already permit
        // exactly one in-flight switch, so the plugin's own guardrail should be
        // unreachable. Log it and no-op — never crash the call over it.
        AvaLog.I.log('calltranslate', 'switch rejected: pending socket already in flight');
      }
      await _abortLanguageSwitch('switch_$code', restoreRow: true);
      if (code == 'not_prepared') {
        // There is no live session to switch away from — translation is already
        // gone. The invariant path (stop → original audio restored) owns this.
        await _failFromProvider('switch_not_prepared');
        return 'switch_lost';
      }
      return 'switch_failed';
    }

    _switchCutoverTimer?.cancel();
    _switchCutoverTimer = Timer(_kSwitchCutoverTimeout, () {
      unawaited(_failSwitch('cutover_timeout'));
    });
    // Resolved by `language_switched` (success) or `resume_failed`/timeout.
    return completer.future;
  }

  /// `/token` re-mints against whatever language the ROW currently holds — which
  /// after a 502 from `/language` is already the new one.
  Future<String?> _mintForCurrentRow(String id) async {
    try {
      final r = await TranslationApi.callToken(id, deviceNonce: _nonce);
      if (((r['status'] as num?)?.toInt() ?? 0) != 200) return null;
      final token = r['token']?.toString();
      return (token == null || token.isEmpty) ? null : token;
    } catch (_) {
      return null;
    }
  }

  bool _beginLanguageSwitch(String lang) {
    if (!canSwitchLanguage) return false;
    if (!_transition(CallTranslationState.warming, 'language_switch_$lang')) return false;
    _switchTarget = lang;
    _notify(switchingTo, lang);
    return true;
  }

  /// The cutover-completed signal. The plugin has already swapped sockets, moved
  /// its own language field and closed the old socket; by the time this runs the
  /// NEW language is what the user is (about to be) hearing.
  void _onLanguageSwitched(CallTranslationAudioEvent event) {
    final completer = _switchCompleter;
    _switchCompleter = null;
    _switchCutoverTimer?.cancel();
    _switchCutoverTimer = null;

    final value = event.value ?? '';
    final lang = value.isNotEmpty ? value : (_switchTarget ?? '');
    if (lang.isEmpty) {
      // Cannot happen with the current plugin; never throw over it.
      AvaLog.I.log('calltranslate', 'language_switched without a language');
      if (completer != null && !completer.isCompleted) completer.complete(null);
      return;
    }
    final from = event.data['previousLanguage']?.toString().isNotEmpty == true
        ? event.data['previousLanguage']!.toString()
        : (targetLanguage.value ?? '');

    _switchTarget = null;
    _notify(switchingTo, null);
    _notify(targetLanguage, lang);
    // The row was moved to `lang` by /language and the plugin now agrees with
    // it, so there is nothing speculative left to repair.
    _speculativeRowLang = null;
    unawaited(CallTranslationLastLang.write(lang));

    // Arm the gap measurement BEFORE anything can raise a 'switching' fallback:
    // [_isSwitchFallback] keys off it, and a `stalled` event misread as a real
    // stall would both lie to the user and spam the illegal-transition counter.
    _armSwitchGapProbe(lang, from, event.intOf('sinceLastAudioMs'));
    _transition(CallTranslationState.active, 'language_switched_$lang');

    // Safety net over the new pipeline's refill — the user hears the real
    // speaker rather than silence. NO setFallback(false) anywhere: the native
    // dead-air guard drops it on the new session's first sustained translated
    // PCM. Dropping it by hand would re-mute before any translated audio exists,
    // manufacturing the exact dead air this design avoids. Raised as a DART-owned
    // reason ('switching'): the guard drops it and Dart's `recovered` handler
    // reconciles, so no timer and no other owner can clear it early.
    unawaited(_raiseFallback('switching'));
    // [CALL-TRANSLATE-2D-5] …but BOUNDED. See [_kSwitchFallbackMaxHold]: the
    // guard is gated on `!fallbackActive`, so holding this reason indefinitely
    // is exactly what stops the guard from noticing that the new session is
    // producing nothing. Lowering it hands dead-air ownership back to native.
    _armSwitchFallbackCeiling();

    if (completer != null && !completer.isCompleted) completer.complete(null);
  }

  /// [CALL-TRANSLATE-2D-5] Bound the 'switching' fallback raised at a successful
  /// cutover, so a new session that reaches `setupComplete` and then produces no
  /// audio cannot hold the original speaker up — un-noticed, un-lowerable and
  /// still billing — for the rest of the call.
  ///
  /// Lowering our OWN reason is exactly what the owner model permits, and it is
  /// a no-op if the guard already dropped it (`recovered` with `deadAir:false`
  /// removes the reason first) or if a teardown cleared the owners. Nothing here
  /// touches the native dead-air reason.
  ///
  /// The cost of lowering early is at most one guard window (~2 s) of re-mute
  /// before the guard re-raises — the same bounded cost `route_change`'s 1500 ms
  /// release already accepts, and the only way the guard can ever take over.
  void _armSwitchFallbackCeiling() {
    _switchFallbackCeiling?.cancel();
    _switchFallbackCeiling = Timer(_kSwitchFallbackMaxHold, () async {
      _switchFallbackCeiling = null;
      if (_disposed || !_dartFallbackReasons.contains('switching')) return;
      // No translated PCM from the new session yet (the gap probe is still open)
      // — this is the dead-cutover shape rather than a slow-but-alive one.
      final noAudioYet = _switchGapStartMs > 0;
      Analytics.capture('call_translation_switch_fallback_released', {
        ..._tags,
        'language': targetLanguage.value ?? '',
        'held_ms': _kSwitchFallbackMaxHold.inMilliseconds,
        'translated_audio_seen': !noAudioYet,
        'dead_air_held': _nativeFallbackHeld,
      });
      await _lowerFallback('switching');
    });
  }

  /// The cutover failed AFTER the second socket was requested. Under
  /// make-before-break the LIVE session was never touched — it is still
  /// translating in the old language — so recovery is just bookkeeping:
  /// clear the switch, put the server row back on the live language, and let the
  /// overlay toast "Could not switch language. Still translating to X."
  ///
  /// Nothing is un-muted or re-muted here on purpose. A failed switch never
  /// raised the 'switching' fallback (that happens only on success), and a
  /// fallback that IS up belongs to the dead-air guard — clearing it would
  /// re-mute the original during genuine dead air.
  Future<void> _failSwitch(String reason, {Map<String, dynamic> extra = const {}}) async {
    final completer = _switchCompleter;
    final target = _switchTarget;
    _switchCompleter = null;
    _switchCutoverTimer?.cancel();
    _switchCutoverTimer = null;
    if (target == null && completer == null) return;
    _switchTarget = null;
    _notify(switchingTo, null);
    // [CALL-TRANSLATE-2D-4 / D-4] TELL THE PLUGIN. Giving up in Dart alone left
    // `pendingSocket` non-null for the rest of the call, which wedged every later
    // switch with `switch_in_flight` and silently disabled goAway-driven provider
    // resume. Idempotent: false simply means the socket was already gone (the
    // `resume_failed` path nulls it natively before it emits).
    await bridge.cancelSwitch(reason: reason);
    await _restoreSpeculativeRow();
    if (state.value == CallTranslationState.warming) {
      _transition(CallTranslationState.active, 'language_switch_failed_$reason');
    }
    Analytics.capture('call_translation_language_switch_failed', {
      ..._tags,
      'from_language': targetLanguage.value ?? '',
      'to_language': target ?? '',
      'reason': reason,
      // Always true now: the old session is alive by construction.
      'recovered_to_previous': true,
      ...extra,
    });
    if (completer != null && !completer.isCompleted) completer.complete('switch_failed');
  }

  /// Nothing has been cut over yet — stay on the OLD session. [restoreRow] puts
  /// the server row back on the live language when a 502 already moved it, so a
  /// later `/token` cannot mint for a language the plugin is not speaking.
  Future<void> _abortLanguageSwitch(String reason, {required bool restoreRow}) async {
    final target = _switchTarget;
    final completer = _switchCompleter;
    _switchCompleter = null;
    _switchCutoverTimer?.cancel();
    _switchCutoverTimer = null;
    _switchTarget = null;
    _notify(switchingTo, null);
    if (completer != null && !completer.isCompleted) completer.complete('switch_failed');
    // [CALL-TRANSLATE-2D-4 / D-4] Most abort paths run BEFORE `switchLanguage`
    // was ever called, so there is nothing pending; the one that does not is the
    // `switchLanguage` throw, where a socket may already have been opened. Cheap
    // and idempotent either way — never leave a pending socket behind.
    await bridge.cancelSwitch(reason: reason);
    if (restoreRow) await _restoreSpeculativeRow();
    _transition(CallTranslationState.active, 'language_switch_aborted_$reason');
    Analytics.capture('call_translation_language_switch_failed', {
      ..._tags,
      'from_language': targetLanguage.value ?? '',
      'to_language': target ?? '',
      'reason': reason,
      'recovered_to_previous': true,
    });
  }

  // ── switch_gap_ms ─────────────────────────────────────────────────────────
  //
  // Defined as old-session-last-PCM → new-session-first-PCM, measured from the
  // real signals rather than from when Dart asked for the switch.
  //
  // NEAR edge: the old socket translates right up to the swap, so the last
  // chunk it produced is `language_switched.sinceLastAudioMs` before the plugin
  // committed the new language. (The old sequential design had to use "when we
  // called prepare" because that WAS the moment the audio died.) Silence on the
  // call also stops translated PCM, so a `sinceLastAudioMs` beyond
  // [_kMaxAttributableSilenceMs] is not switch-attributable and the swap instant
  // is used instead — the raw value is still reported.
  //
  // FAR edge: the first translated chunk from the NEW socket, seen as
  // `translatedChunkCount` rising above the baseline sampled at the swap
  // (`switchLanguage` does NOT reset the native counters — only `prepare` does,
  // which is why "count > 0" no longer works). The plugin's `recovered` for the
  // 'switching' fallback also closes it, but it carries an 800 ms anti-flap
  // floor, so the 300 ms stats poll normally wins.
  //
  // With true make-before-break this number should now be near-zero (bounded by
  // the new pipeline's first-chunk latency), not a socket handshake.

  bool _isSwitchFallback(CallTranslationAudioEvent event) {
    if (_switchGapStartMs == 0 && !isSwitchingLanguage) return false;
    final reason = event.data['reason']?.toString() ?? event.value ?? '';
    return reason == 'switching';
  }

  void _armSwitchGapProbe(String lang, String from, int sinceLastAudioMs) {
    final now = DateTime.now().millisecondsSinceEpoch;
    // How long the second socket took to come up. This is NOT audible — the old
    // session translated throughout it — but it is what a regression in the
    // provider handshake would show up as.
    _switchCutoverMs = _switchStartedAtMs > 0 ? now - _switchStartedAtMs : 0;
    _switchGapSinceLastAudioMs = sinceLastAudioMs;
    _switchGapStartMs = sinceLastAudioMs > 0 && sinceLastAudioMs <= _kMaxAttributableSilenceMs
        ? now - sinceLastAudioMs
        : now;
    _switchGapLang = lang;
    _switchGapFrom = from;
    _switchGapPolls = 0;
    _switchGapBaselineChunks = -1;
    _switchGapPoll?.cancel();
    _switchGapPoll = Timer.periodic(const Duration(milliseconds: 300), (t) {
      _switchGapPolls++;
      if (_disposed || _switchGapStartMs == 0) {
        t.cancel();
        _switchGapPoll = null;
        return;
      }
      if (_switchGapPolls * 300 >= _kSwitchGapTimeout.inMilliseconds || !active) {
        // Still report the switch — a missing gap number is far less useful than
        // a switch that silently produced no telemetry at all.
        _resolveSwitchGap('timeout', measured: false);
        return;
      }
      unawaited(bridge.requestStats());
    });
    // Sample the baseline immediately: the old socket is already closed, so any
    // chunk counted from here on can only have come from the new one.
    unawaited(bridge.requestStats());
  }

  String _switchGapFrom = '';
  int _switchGapSinceLastAudioMs = 0;
  int _switchCutoverMs = 0;

  void _resolveSwitchGap(String via, {bool measured = true}) {
    if (_switchGapStartMs == 0) return;
    final gap = DateTime.now().millisecondsSinceEpoch - _switchGapStartMs;
    _switchGapStartMs = 0;
    _switchGapBaselineChunks = -1;
    _switchGapPoll?.cancel();
    _switchGapPoll = null;
    Analytics.capture('call_translation_language_switched', {
      ..._tags,
      'language': _switchGapLang,
      'from_language': _switchGapFrom,
      'via': via,
      'gap_measured': measured,
      'make_before_break': true,
      'since_last_audio_ms': _switchGapSinceLastAudioMs,
      'cutover_ms': _switchCutoverMs,
      if (measured) 'switch_gap_ms': gap,
      // [CALL-TRANSLATE-2D-5] `gap_measured:false` used to be the ONLY trace of a
      // cutover that produced no audio, and it made no state change — a dead
      // switch was invisible past this point. These say what the watchdogs saw,
      // so "switch completed, nothing ever came out" is a query rather than an
      // inference: the 'switching' reason should be gone by now
      // (`_kSwitchFallbackMaxHold`), and dead_air_held true means the native
      // guard has taken over and `_kDeadTranslationDeadline` is running.
      if (!measured) 'switching_fallback_held': _dartFallbackReasons.contains('switching'),
      if (!measured) 'dead_air_held': _nativeFallbackHeld,
      if (!measured) 'dead_translation_armed': _deadTranslation != null,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Speculative warm-up (P1 fast start + fast switch)
  //
  // The language sheet is open for a second or two while the user reads or
  // searches. That idle time is spent getting the expensive parts of the next
  // session out of the way for their LAST-USED language (per-account scoped —
  // rulebook rule 1, see call_translation_last_lang.dart):
  //   • idle  → create the session row AND drive the socket to setupComplete.
  //             Unbilled: /activate is the paid boundary, so a discarded warm-up
  //             costs the user nothing.
  //   • active→ pre-mint a token via /language. The socket CANNOT be pre-opened
  //             here (one native pipeline, and opening a second one would kill
  //             the live translation), so this saves the HTTP leg only.
  // Everything is discardable, and every discard path restores whatever it
  // touched — including the server row, which /language moves speculatively.
  // ───────────────────────────────────────────────────────────────────────────

  int _warmGeneration = 0;
  bool _warmingUp = false;
  Future<void>? _warmFuture;
  String? _warmLang;

  /// Set when a warm session row exists AND its socket reached setupComplete.
  bool _warmSessionReady = false;

  /// Pre-minted token for a mid-call switch, and when it was minted.
  String? _warmToken;
  int _warmTokenAtMs = 0;

  /// The language the SERVER ROW was speculatively moved to by a pre-mint. Non
  /// null means the row disagrees with what the plugin is speaking, which must
  /// be repaired before any `/token` mint (see [_resumeProvider]).
  String? _speculativeRowLang;

  /// Called by the overlay once the language sheet has been open ~500 ms.
  /// Fire-and-forget: failures are silent by design.
  Future<void> warmUp() async {
    if (_disposed || !available || circuitOpen || _warmingUp) return;
    final lang = await CallTranslationLastLang.read();
    if (lang == null || lang.isEmpty || _disposed) return;
    if (lang == targetLanguage.value && active) return;
    if (_warmSessionReady && _warmLang == lang) return;
    if (_warmToken != null && _warmLang == lang) return;

    _warmingUp = true;
    _warmLang = lang;
    final generation = _warmGeneration;
    final future = state.value == CallTranslationState.idle
        ? _warmUpStart(lang, generation)
        : _warmUpSwitch(lang);
    _warmFuture = future;
    try {
      await future;
    } catch (_) {
    } finally {
      _warmingUp = false;
      _warmFuture = null;
    }
  }

  Future<void> _warmUpStart(String lang, int generation) async {
    final error = await _openSession(lang, warm: true, warmGeneration: generation);
    if (error != null || _disposed || _warmGeneration != generation) {
      // _openSession already released its own row on every superseded path.
      _warmSessionReady = false;
      return;
    }
    _warmSessionReady = true;
    Analytics.capture('call_translation_warm_ready', {
      'kind': 'session',
      'language': lang,
      ..._tags,
    });
  }

  Future<void> _warmUpSwitch(String lang) async {
    final id = _id;
    // Never speculate on top of an unstable session: a resume in flight would
    // race the row change, and a switch already running owns the row.
    if (id == null || !active || isSwitchingLanguage || _resumingProvider) return;
    try {
      final r = await TranslationApi.callLanguage(id, targetLang: lang, deviceNonce: _nonce);
      final status = (r['status'] as num?)?.toInt() ?? 0;
      if (status == 502) {
        // The row moved even though the mint failed. Record it so the discard
        // path (or a resume) repairs it.
        _speculativeRowLang = lang;
        return;
      }
      if (status != 200) return;
      final token = r['token']?.toString();
      _speculativeRowLang = lang;
      if (token == null || token.isEmpty) return;
      _warmToken = token;
      _warmTokenAtMs = DateTime.now().millisecondsSinceEpoch;
      Analytics.capture('call_translation_warm_ready', {
        'kind': 'token',
        'language': lang,
        ..._tags,
      });
    } catch (_) {}
  }

  /// Adopts a warm session for [lang] if one is ready. Bumps the generation
  /// first so any warm-up still in flight can never reach the plugin.
  Future<bool> _adoptWarmSession(String lang) async {
    _warmGeneration++;
    final inFlight = _warmFuture;
    if (inFlight != null && _warmLang == lang) {
      // The user picked exactly what we are warming — waiting for it is strictly
      // faster than starting over, and it is bounded by the plugin's own 15 s
      // setup timeout.
      try {
        await inFlight;
      } catch (_) {}
    }
    if (_warmSessionReady && _warmLang == lang && _id != null && _lease != null && !_disposed) {
      _warmSessionReady = false;
      _warmLang = null;
      if (!_transition(CallTranslationState.warming, 'warm_session_adopted')) {
        await _stopInternal('warming_rejected', toFailed: false);
        return false;
      }
      return true;
    }
    await _discardWarmUp('not_adopted');
    return false;
  }

  /// Consumes the pre-minted token if it matches [lang] and is still fresh. The
  /// warm token is cleared either way — a token for a language the user did NOT
  /// pick is dead weight, and leaving it would let a later switch grab it.
  String? _claimWarmToken(String lang) {
    final token = _warmToken;
    final warmLang = _warmLang;
    final age = DateTime.now().millisecondsSinceEpoch - _warmTokenAtMs;
    _warmToken = null;
    _warmLang = null;
    if (token == null || warmLang != lang) return null;
    if (age > _kWarmTokenMaxAge.inMilliseconds) return null;
    // The row is already on this language — that is what the pre-mint did.
    _speculativeRowLang = null;
    return token;
  }

  /// Throws away anything the warm-up created and repairs the server row.
  /// Safe to call at any time, including when nothing was warmed.
  Future<void> _discardWarmUp(String reason) async {
    _warmGeneration++;
    _warmToken = null;
    _warmLang = null;
    final hadSession = _warmSessionReady;
    _warmSessionReady = false;
    if (hadSession) {
      // Unbilled by construction (/activate never ran) — release the row and
      // shut the speculative socket so the plugin is idle for the real start.
      // Always, not just while idle: the commonest discard happens INSIDE
      // start() (user picked a different language), where the machine has
      // already moved to `starting`, and skipping it there would leak both the
      // row and a live provider socket.
      await _stopUnbilledPending();
    }
    await _restoreSpeculativeRow();
    if (hadSession) {
      Analytics.capture('call_translation_warm_discarded', {'reason': reason});
    }
  }

  /// Public discard for the overlay (sheet dismissed, or a different language
  /// picked). Best effort; never awaited by the UI.
  Future<void> discardWarmUp(String reason) => _discardWarmUp(reason);

  /// Puts the server row back on the language the plugin is actually speaking.
  /// `mint: false` updates the row only — no token, nothing billed.
  Future<void> _restoreSpeculativeRow() async {
    final stale = _speculativeRowLang;
    final id = _id;
    final live = targetLanguage.value;
    _speculativeRowLang = null;
    if (stale == null || id == null || live == null || live.isEmpty || stale == live) return;
    try {
      await TranslationApi.callLanguage(id, targetLang: live, deviceNonce: _nonce, mint: false);
    } catch (_) {}
  }

  // ───────────────────────────────────────────────────────────────────────────

  void dispose() {
    _disposed = true;
    _renew?.cancel();
    _clock?.cancel();
    _firstAudioPoll?.cancel();
    _fallbackRelease?.cancel();
    _switchGapPoll?.cancel();
    _switchCutoverTimer?.cancel();
    _switchFallbackCeiling?.cancel();
    _deadTranslation?.cancel();
    _warmGeneration++;
    WidgetsBinding.instance.removeObserver(this);
    _unhookAudioFocus();
    unawaited(_bridgeEvents?.cancel());
    unawaited(_routeEvents?.cancel());
    unawaited(_telephonyEvents?.cancel());
    // Widget disposal is one of the invariant's named paths: the bridge MUST be
    // stopped (restoring the original audio) even though nothing is listening.
    //
    // [CALL-TRANSLATE-2D-4 / D-8] This is deliberately NOT awaited — the call is
    // tearing down and must not wait on the network — so `_stopInternal`
    // continues running after the notifiers below are disposed. `_disposed` is
    // already true and every notifier write in this class goes through [_notify],
    // which drops writes once it is, so the resume after `await bridge.stop()`
    // can no longer write to a disposed ValueNotifier. That write used to trip a
    // debug assertion and report a spurious `$exception` on EVERY teardown while
    // translating. Do not "simplify" [_notify] away.
    unawaited(_stopInternal('disposed', toFailed: false));
    state.dispose();
    failure.dispose();
    targetLanguage.dispose();
    billedTokens.dispose();
    elapsedSeconds.dispose();
    qualityDegraded.dispose();
    fallbackToOriginal.dispose();
    switchingTo.dispose();
    // ignore: deprecated_member_use_from_same_package
    caption.dispose();
  }
}
