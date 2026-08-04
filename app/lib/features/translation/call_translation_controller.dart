import 'dart:async';

import 'package:flutter/foundation.dart';
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
  static const int _kMaxWriteAttempts = 3;
  static const Duration _kDefaultRetryAfter = Duration(milliseconds: 750);

  /// A pre-minted token is single-use and short-lived server-side. Anything
  /// older than this is thrown away rather than gambled on mid-cutover.
  static const Duration _kWarmTokenMaxAge = Duration(seconds: 60);

  /// Ceiling on how long we wait to observe the FIRST translated PCM of a new
  /// language before giving up on measuring `switch_gap_ms`. The switch itself
  /// is already complete by then — this only bounds the telemetry probe.
  static const Duration _kSwitchGapTimeout = Duration(seconds: 12);

  Timer? _renew;
  Timer? _clock;
  Timer? _firstAudioPoll;
  Timer? _fallbackRelease;
  Timer? _switchGapPoll;
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
  int _tapAtMs = 0;
  int? _firstAudioMs;
  int _firstAudioPolls = 0;
  bool _deviceBound = false;

  // Native counters, last-known values from `stats` (monotonic within a call).
  int _stallCount = 0;
  int _stallMsTotal = 0;
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
      'session_id': _id ?? '',
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
    failure.value = CallTranslationFailure.none;
    qualityDegraded.value = false;
    if (!_transition(CallTranslationState.starting, 'user_tap')) return 'busy';
    targetLanguage.value = lang;

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
    final activateStatus = (activate['status'] as num?)?.toInt() ?? 0;
    if (activateStatus != 200) {
      // A2: past this point the payer MAY already have been charged (the race
      // this retry loop exists for). Never leak the row — stop it explicitly
      // even though the charge is not refunded.
      await _stopInternal('activate_failed_$activateStatus', toFailed: false);
      if (activateStatus == 402 || TranslationApi.isInsufficientTokens(activate)) {
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
        'session_id': _id ?? '',
      });
    }

    try {
      await bridge.commitPaid();
    } catch (_) {
      await _stopInternal('commit_paid_failed', toFailed: false);
      _enterFailed(CallTranslationFailure.playbackUnavailable, 'commit_paid_failed');
      return 'playback_unavailable';
    }

    billedTokens.value = (activate['billed_tokens'] as num?)?.toInt() ?? TranslationApi.ratePerMin;
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
      'session_id': _id ?? '',
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
  Future<String?> _openSession(String lang, {required bool warm, int warmGeneration = 0}) async {
    _nonce = await CallTranslationDeviceNonce.ensure();

    Map<String, dynamic> pending;
    try {
      pending = await TranslationApi.callStart(
        callRef: callRef,
        targetLang: lang,
        sourceCapability: CallTranslationAudioBridge.sourceCapability,
        deviceNonce: _nonce,
      );
    } catch (_) {
      if (!warm) _enterFailed(CallTranslationFailure.network, 'start_unreachable');
      return 'network_unavailable';
    }
    final status = (pending['status'] as num?)?.toInt() ?? 0;
    if (status != 200) {
      if (status == 402 || TranslationApi.isInsufficientTokens(pending)) {
        if (!warm) _enterFailed(CallTranslationFailure.insufficientTokens, 'start_402');
        return 'insufficient_tokens';
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
      Analytics.capture('call_translation_nonce_unbound', {'session_id': sid});
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
  Future<void> _releaseRow(String id) async {
    try {
      await TranslationApi.callStop(id);
    } catch (_) {}
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
          'session_id': _id ?? '',
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
          'session_id': _id ?? '',
        });
        await Future<void>.delayed(_kDefaultRetryAfter * attempt);
      }
      if (_disposed) return last;
    }
    return last;
  }

  Future<void> _renewMinute() async {
    final id = _id;
    if (id == null || !active) return;
    final r = await _writeWithRetry(
      'renew',
      () => TranslationApi.callRenew(id, deviceNonce: _nonce),
    );
    final status = (r['status'] as num?)?.toInt() ?? 0;
    if (status == 200) {
      final reconciled = r['reconciled']?.toString();
      if (reconciled != null) {
        // `already_billed` → the response's billed_minute/billed_tokens are
        // AUTHORITATIVE. Do not add 5 locally on top of them.
        Analytics.capture('call_translation_reconciled', {
          'op': 'renew',
          'reconciled': reconciled,
          'session_id': id,
        });
      }
      billedTokens.value = (r['billed_tokens'] as num?)?.toInt() ??
          billedTokens.value + TranslationApi.ratePerMin;
      return;
    }
    if (status == 402 || TranslationApi.isInsufficientTokens(r)) {
      await _stopInternal('funds_exhausted', toFailed: false);
      _enterFailed(CallTranslationFailure.insufficientTokens, 'renew_402');
      Analytics.capture('call_translation_funds_stopped', {'reason': 'balance_exhausted'});
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
        fallbackToOriginal.value = true;
        // A Phase C cutover raises the SAME fallback deliberately ('switching').
        // Reporting that as a stall would both lie to the user and spam the
        // illegal-transition counter, since a switch sits in `warming`.
        if (!_isSwitchFallback(event)) {
          _transition(CallTranslationState.stalled, 'native_stalled_${event.value ?? 'unknown'}');
        }
        break;

      case 'recovered':
        _stallCount = event.intOf('stallCount', _stallCount);
        _stallMsTotal = event.intOf('stallMsTotal', _stallMsTotal);
        fallbackToOriginal.value = false;
        if (_isSwitchFallback(event)) {
          // First SUSTAINED translated PCM from the new language — the plugin
          // re-muted the original by itself. This is the far edge of the gap.
          _resolveSwitchGap('native_recovered');
        } else {
          _transition(CallTranslationState.active, 'native_recovered');
        }
        break;

      case 'stall_degraded':
        // 2+ stall/recover cycles in the window. Still translating — warn only.
        qualityDegraded.value = true;
        _stallCount = event.intOf('stallCount', _stallCount);
        _stallMsTotal = event.intOf('stallMsTotal', _stallMsTotal);
        Analytics.capture('call_translation_degraded', {
          'session_id': _id ?? '',
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

      case 'resume_failed':
        // [CALL-TRANSLATE-2A-3] Previously ignored: the pill showed "active" on
        // a dead provider session. The resume socket is gone; the breaker
        // decides whether one more attempt is allowed.
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
    _pcmDropCount = event.intOf('pcmDropCount', _pcmDropCount);
    _uplinkFailCount = event.intOf('uplinkFailCount', _uplinkFailCount);
    _shortWriteCount = event.intOf('shortWriteCount', _shortWriteCount);
    _queuePeak = event.intOf('queuePeak', _queuePeak);
    fallbackToOriginal.value = event.boolOf('fallbackActive', fallbackToOriginal.value);

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
        extra: {'session_id': _id ?? '', 'language': targetLanguage.value ?? ''},
      ));
    }

    // Far edge of `switch_gap_ms`: the first translated chunk produced by the
    // NEW language's socket. `prepare` resets the native counters, so a non-zero
    // count after a cutover can only come from the new session.
    if (_switchGapStartMs > 0 && event.intOf('translatedChunkCount') > 0) {
      _resolveSwitchGap('stats');
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
      'session_id': _id ?? '',
      'language': targetLanguage.value ?? '',
      'stall_count': _stallCount,
      'stall_ms': _stallMsTotal,
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
      'session_id': _id ?? '',
    });
  }

  Future<void> _resumeProvider(String handle, {bool alreadyRecovering = false}) async {
    final id = _id;
    if (id == null || _resumingProvider) return;
    if (!alreadyRecovering) {
      if (!active) return;
      if (!_transition(CallTranslationState.recovering, 'resume_token_needed')) return;
    }
    _resumingProvider = true;
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
    failure.value = why;
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
      failure.value = CallTranslationFailure.none;
    }
    if (hadSession) {
      Analytics.capture('call_translation_stopped', {
        'billed_tokens': billedTokens.value,
        'session_id': sessionId,
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
    _renew = null;
    _clock = null;
    _firstAudioPoll = null;
    _switchGapPoll = null;
    // A switch in flight is over the moment the session is: nothing may be left
    // holding `warming` semantics or an unresolved gap measurement.
    _switchTarget = null;
    _switchGapStartMs = 0;
    _queuedSwitch = null;
    switchingTo.value = null;
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
    await bridge.stop();
    fallbackToOriginal.value = false;
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
    await bridge.stop();
    final id = _id;
    _id = null;
    _lease = null;
    if (id != null) {
      try {
        await TranslationApi.callStop(id);
      } catch (_) {}
    }
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
            'session_id': _id ?? '',
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
          'session_id': _id ?? '',
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
            'session_id': _id ?? '',
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
        'session_id': _id ?? '',
      });
      unawaited(_setFallback(true, 'audio_focus_lost'));
    };
    _ourFocusRegained = () {
      _prevFocusRegained?.call();
      if (_disposed || !active) return;
      unawaited(_setFallback(false, 'audio_focus_regained'));
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

  Future<void> _setFallback(bool enabled, String reason) async {
    fallbackToOriginal.value = enabled;
    await bridge.setFallback(enabled: enabled, reason: reason);
  }

  /// Fall back to the original audio for [window], then re-mute. Used for
  /// transient events (route swap) where the stream is briefly unusable.
  void _fallbackAcross(Duration window, String reason) {
    _fallbackRelease?.cancel();
    unawaited(_setFallback(true, reason));
    _fallbackRelease = Timer(window, () {
      if (_disposed || !active) return;
      unawaited(_setFallback(false, reason));
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
  // HOW CLOSE TO MAKE-BEFORE-BREAK THIS ACTUALLY GETS — read before changing it
  // ---------------------------------------------------------------------------
  // The native plugin CAN hold two provider sockets at once: `resume` opens a
  // `pendingSocket` while the live `socket` keeps translating, and swaps on the
  // new socket's `setupComplete`. That is textbook make-before-break — but it is
  // unusable for a LANGUAGE switch, because the setup frame the pending socket
  // sends is built from the plugin's `this.targetLanguage`, which is only ever
  // assigned by `prepare`. The new socket would therefore announce the OLD
  // language against a token whose `liveConnectConstraints` pin the NEW one, and
  // the provider rejects the mismatch. Teaching `resume` to take a language
  // means editing CallTranslationAudioPlugin.java, which is out of scope here.
  //
  // So the cutover is SEQUENTIAL, and the gap is covered rather than hidden:
  //   1. `/language` runs while the OLD session is still translating normally.
  //   2. `bridge.prepare(newToken, newLang)` tears the old socket down. The
  //      plugin's own teardown un-mutes the original audio, so from this instant
  //      the user hears the real speaker — never silence.
  //   3. `activate` → `setFallback(true, 'switching')` → `commitPaid`. The
  //      fallback flag MUST be raised before `commitPaid`, because `commitPaid`
  //      re-applies the mute; with the flag up, `applyOutputMute()` evaluates
  //      `paid && active && !fallbackActive` to false and the original keeps
  //      playing through the new pipeline's refill.
  //   4. Nothing re-mutes by hand. The A4 dead-air guard drops the fallback on
  //      the new session's first SUSTAINED translated PCM and emits `recovered`,
  //      which is also the far edge of `switch_gap_ms`.
  // Net effect: continuous audio throughout, with an audible language gap of one
  // socket handshake instead of the silence a naive stop/start would produce.
  // ───────────────────────────────────────────────────────────────────────────

  String? _switchTarget;
  int _switchStartedAtMs = 0;

  /// Non-zero while a `switch_gap_ms` measurement is open.
  int _switchGapStartMs = 0;
  String _switchGapLang = '';
  int _switchGapPolls = 0;

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
        'session_id': _id ?? '',
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
    final from = targetLanguage.value ?? '';
    if (!_beginLanguageSwitch(lang)) return 'busy';

    // ── step 1: row update + token mint (old session still translating) ──────
    String? token = _claimWarmToken(lang);
    if (token == null) {
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
        _speculativeRowLang = null;
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
      // Everything up to here is reversible: the OLD socket has not been
      // touched, so we simply stay on it (restoring the row if 502 moved it).
      await _abortLanguageSwitch('mint_failed', restoreRow: true);
      return 'switch_failed';
    }

    // ── step 2: the cutover. Past this line the old socket is gone. ──────────
    _switchStartedAtMs = DateTime.now().millisecondsSinceEpoch;
    final cutOver = await _cutOverTo(lang, token);
    if (cutOver) {
      await _completeLanguageSwitch(lang, from: from);
      return null;
    }

    // The new pipeline would not come up AND the old socket is already down, so
    // "stay on the old session" is no longer physically available. One bounded
    // recovery attempt puts the ORIGINAL language back on the same billing
    // session; if even that fails, the invariant takes over (bridge stopped →
    // original audio restored → call untouched).
    final recovered = await _recoverToLanguage(from);
    _switchTarget = null;
    switchingTo.value = null;
    Analytics.capture('call_translation_language_switch_failed', {
      'session_id': _id ?? '',
      'from_language': from,
      'to_language': lang,
      'reason': 'cutover_failed',
      'recovered_to_previous': recovered,
    });
    if (!recovered) {
      await _failFromProvider('language_switch_cutover_failed');
      return 'switch_lost';
    }
    _transition(CallTranslationState.active, 'language_switch_recovered');
    return 'switch_failed';
  }

  /// Brings the native pipeline up on [lang] with [token] and hands playback
  /// over, holding the original audio open across the refill. Returns false if
  /// any leg failed (the plugin is then stopped and the original is audible).
  Future<bool> _cutOverTo(String lang, String token) async {
    try {
      // Tears the old socket down and opens the new one. The plugin's teardown
      // un-mutes the original audio, so the user is never in silence here.
      await bridge.prepare(token: token, targetLanguage: lang);
      await bridge.activate();
      // BEFORE commitPaid — see the header comment. Order is load-bearing.
      await bridge.setFallback(enabled: true, reason: 'switching');
      fallbackToOriginal.value = true;
      await bridge.commitPaid();
      return true;
    } catch (_) {
      await bridge.stop();
      fallbackToOriginal.value = false;
      return false;
    }
  }

  /// Last-ditch: put [lang] (the language we came FROM) back on the same billing
  /// session after a failed cutover. One attempt, no retry loop.
  Future<bool> _recoverToLanguage(String lang) async {
    final id = _id;
    if (id == null || lang.isEmpty || _disposed) return false;
    try {
      final r = await TranslationApi.callLanguage(id, targetLang: lang, deviceNonce: _nonce);
      final status = (r['status'] as num?)?.toInt() ?? 0;
      final token = status == 200 ? r['token']?.toString() : await _mintForCurrentRow(id);
      if (token == null || token.isEmpty) return false;
      _speculativeRowLang = null;
      return _cutOverTo(lang, token);
    } catch (_) {
      return false;
    }
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
    switchingTo.value = lang;
    return true;
  }

  Future<void> _completeLanguageSwitch(String lang, {required String from}) async {
    _switchTarget = null;
    switchingTo.value = null;
    targetLanguage.value = lang;
    unawaited(CallTranslationLastLang.write(lang));
    // NO setFallback(false) here on purpose: the native dead-air guard drops the
    // fallback itself on the new session's first sustained translated PCM. Doing
    // it by hand would re-mute the original before any translated audio exists —
    // manufacturing the exact dead air this whole design avoids.
    _transition(CallTranslationState.active, 'language_switched_$lang');
    _armSwitchGapProbe(lang, from);
  }

  /// Nothing has been cut over yet — stay on the OLD session. [restoreRow] puts
  /// the server row back on the live language when a 502 already moved it, so a
  /// later `/token` cannot mint for a language the plugin is not speaking.
  Future<void> _abortLanguageSwitch(String reason, {required bool restoreRow}) async {
    final target = _switchTarget;
    _switchTarget = null;
    switchingTo.value = null;
    if (restoreRow) await _restoreSpeculativeRow();
    _transition(CallTranslationState.active, 'language_switch_aborted_$reason');
    Analytics.capture('call_translation_language_switch_failed', {
      'session_id': _id ?? '',
      'from_language': targetLanguage.value ?? '',
      'to_language': target ?? '',
      'reason': reason,
      'recovered_to_previous': true,
    });
  }

  // ── switch_gap_ms ─────────────────────────────────────────────────────────
  //
  // Defined as old-session-last-PCM → new-session-first-PCM. The old session
  // produces its last chunk the instant `prepare` tears its socket down, so
  // [_switchStartedAtMs] (stamped immediately before the cutover) IS that edge;
  // the far edge is the plugin's `recovered` for the 'switching' fallback, or a
  // `stats` sample showing a non-zero translated-chunk count on the new session.

  bool _isSwitchFallback(CallTranslationAudioEvent event) {
    if (_switchGapStartMs == 0 && !isSwitchingLanguage) return false;
    final reason = event.data['reason']?.toString() ?? event.value ?? '';
    return reason == 'switching';
  }

  void _armSwitchGapProbe(String lang, String from) {
    _switchGapStartMs = _switchStartedAtMs;
    _switchGapLang = lang;
    _switchGapPolls = 0;
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
    _switchGapFrom = from;
  }

  String _switchGapFrom = '';

  void _resolveSwitchGap(String via, {bool measured = true}) {
    if (_switchGapStartMs == 0) return;
    final gap = DateTime.now().millisecondsSinceEpoch - _switchGapStartMs;
    _switchGapStartMs = 0;
    _switchGapPoll?.cancel();
    _switchGapPoll = null;
    Analytics.capture('call_translation_language_switched', {
      'session_id': _id ?? '',
      'language': _switchGapLang,
      'from_language': _switchGapFrom,
      'via': via,
      'gap_measured': measured,
      if (measured) 'switch_gap_ms': gap,
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
      'session_id': _id ?? '',
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
        'session_id': id,
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
    _warmGeneration++;
    WidgetsBinding.instance.removeObserver(this);
    _unhookAudioFocus();
    unawaited(_bridgeEvents?.cancel());
    unawaited(_routeEvents?.cancel());
    unawaited(_telephonyEvents?.cancel());
    // Widget disposal is one of the invariant's named paths: the bridge MUST be
    // stopped (restoring the original audio) even though nothing is listening.
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
