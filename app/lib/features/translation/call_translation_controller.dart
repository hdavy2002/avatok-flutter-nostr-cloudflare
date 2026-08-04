import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState, WidgetsBinding, WidgetsBindingObserver;

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/remote_config.dart';
import '../../core/voice/native_voice_audio.dart';
import 'call_translation_audio_bridge.dart';
import 'call_translation_device_nonce.dart';
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

  /// Captions were deferred by the owner; the plugin no longer emits them and
  /// [_onBridgeEvent] no longer has a `caption` branch. Retained only so any
  /// out-of-tree widget still binding to it keeps compiling; it is never set.
  @Deprecated('captions deferred — the plugin no longer emits caption events')
  final caption = ValueNotifier<String>('');

  // ── internals ─────────────────────────────────────────────────────────────
  static const int kMaxProviderFailuresPerCall = 3;
  static const int _kMaxWriteAttempts = 3;
  static const Duration _kDefaultRetryAfter = Duration(milliseconds: 750);

  Timer? _renew;
  Timer? _clock;
  Timer? _firstAudioPoll;
  Timer? _fallbackRelease;
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
      _enterFailed(CallTranslationFailure.network, 'start_unreachable');
      return 'network_unavailable';
    }
    final status = (pending['status'] as num?)?.toInt() ?? 0;
    if (status != 200) {
      if (status == 402 || TranslationApi.isInsufficientTokens(pending)) {
        _enterFailed(CallTranslationFailure.insufficientTokens, 'start_402');
        return 'insufficient_tokens';
      }
      if (pending['error']?.toString() == 'invalid_device_nonce') {
        // Our stored nonce is unusable. Drop it so the next attempt mints a
        // fresh one rather than failing forever on the same bad value.
        CallTranslationDeviceNonce.invalidate();
        _nonce = null;
      }
      _enterFailed(CallTranslationFailure.providerUnavailable, 'start_$status');
      return 'failed';
    }
    _id = pending['session_id']?.toString();
    _lease = pending['source_lease']?.toString();
    final token = pending['token']?.toString();
    if (_id == null || _lease == null || token == null || token.isEmpty) {
      _enterFailed(CallTranslationFailure.providerUnavailable, 'start_incomplete');
      return 'failed';
    }
    if (pending['device_bound'] == false && _nonce != null) {
      // Not fatal — the session simply is not nonce-bound server-side. Record
      // it so a silently-unbound fleet is visible rather than assumed.
      Analytics.capture('call_translation_nonce_unbound', {'session_id': _id!});
    }

    if (!_transition(CallTranslationState.warming, 'session_created')) {
      await _stopInternal('warming_rejected', toFailed: false);
      return 'busy';
    }

    try {
      // Gemini setupComplete is required before the backend may charge minute 1.
      await bridge.prepare(token: token, targetLanguage: lang);
    } catch (_) {
      await _stopUnbilledPending();
      _enterFailed(CallTranslationFailure.sourceUnavailable, 'prepare_failed');
      return 'source_capture_unavailable';
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
    Analytics.capture('call_translation_started', {
      'language': lang,
      'rate_per_min': TranslationApi.ratePerMin,
      'session_id': _id ?? '',
      'device_bound': pending['device_bound'] == true,
    });
    return null;
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
        _transition(CallTranslationState.stalled, 'native_stalled_${event.value ?? 'unknown'}');
        break;

      case 'recovered':
        _stallCount = event.intOf('stallCount', _stallCount);
        _stallMsTotal = event.intOf('stallMsTotal', _stallMsTotal);
        fallbackToOriginal.value = false;
        _transition(CallTranslationState.active, 'native_recovered');
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
    _renew = null;
    _clock = null;
    _firstAudioPoll = null;
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
  // Phase C seams — DO NOT wire UI to these yet.
  //
  // A language switch is `active → warming(new) → active`, make-before-break:
  //   1. [beginLanguageSwitch] — enters `warming` and drops to original audio
  //      so the user hears the real speaker, never silence, during the cutover.
  //   2. Caller mints via `TranslationApi.callLanguage(sessionId, targetLang:,
  //      deviceNonce: deviceNonce)` — SAME billing session, SAME nonce. On 502
  //      `provider_unavailable` the row is ALREADY updated server-side, so stay
  //      on the old socket and call [abortLanguageSwitch].
  //   3. Caller opens the second socket, and on the new `setupComplete` cuts
  //      playback over and closes the old one.
  //   4. [completeLanguageSwitch] — back to `active`, re-mute, emit switch_gap_ms.
  // Guardrails the caller owns: one in-flight switch at a time (guarded here by
  // [isSwitchingLanguage]), queue only the latest requested language, debounce.
  // ───────────────────────────────────────────────────────────────────────────

  String? _switchTarget;
  int _switchStartedAtMs = 0;

  bool get isSwitchingLanguage => _switchTarget != null;

  /// True when a switch may start right now.
  bool get canSwitchLanguage =>
      state.value == CallTranslationState.active && _id != null && !isSwitchingLanguage;

  /// Step 1 of a Phase C cutover. Returns false if the machine refused.
  Future<bool> beginLanguageSwitch(String lang) async {
    if (!canSwitchLanguage) return false;
    if (!_transition(CallTranslationState.warming, 'language_switch_$lang')) return false;
    _switchTarget = lang;
    _switchStartedAtMs = DateTime.now().millisecondsSinceEpoch;
    await _setFallback(true, 'switching');
    return true;
  }

  /// Step 4 — the new session is producing translated PCM.
  Future<void> completeLanguageSwitch(String lang) async {
    if (_switchTarget == null) return;
    _switchTarget = null;
    targetLanguage.value = lang;
    await _setFallback(false, 'switched');
    _transition(CallTranslationState.active, 'language_switched_$lang');
    Analytics.capture('call_translation_language_switched', {
      'session_id': _id ?? '',
      'language': lang,
      'switch_gap_ms': DateTime.now().millisecondsSinceEpoch - _switchStartedAtMs,
    });
  }

  /// New-session setup failed — stay on the OLD session, restore the mute.
  Future<void> abortLanguageSwitch(String reason) async {
    if (_switchTarget == null) return;
    _switchTarget = null;
    await _setFallback(false, 'switch_aborted');
    _transition(CallTranslationState.active, 'language_switch_aborted_$reason');
    Analytics.capture('call_translation_language_switch_failed', {
      'session_id': _id ?? '',
      'reason': reason,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────

  void dispose() {
    _disposed = true;
    _renew?.cancel();
    _clock?.cancel();
    _firstAudioPoll?.cancel();
    _fallbackRelease?.cancel();
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
    // ignore: deprecated_member_use_from_same_package
    caption.dispose();
  }
}
