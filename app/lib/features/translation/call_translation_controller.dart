import 'dart:async';
import 'package:flutter/foundation.dart';

import '../../core/analytics.dart';
import '../../core/remote_config.dart';
import 'call_translation_audio_bridge.dart';
import 'translation_api.dart';

enum CallTranslationState { off, preparing, active, fundsStopped, unavailable, error }

/// Call-only lifecycle. The Android bridge consumes decoded incoming WebRTC
/// playback; it never opens another microphone capture.
class CallTranslationController {
  CallTranslationController({required this.callRef, required this.bridge}) {
    _bridgeEvents = bridge.events.listen(_onBridgeEvent);
  }
  final String callRef;
  final CallTranslationAudioBridge bridge;
  final state = ValueNotifier(CallTranslationState.off);
  final targetLanguage = ValueNotifier<String?>(null);
  final caption = ValueNotifier<String>('');
  final billedTokens = ValueNotifier<int>(0);
  final elapsedSeconds = ValueNotifier<int>(0);
  Timer? _renew;
  Timer? _clock;
  bool _resumingProvider = false;
  StreamSubscription<CallTranslationAudioEvent>? _bridgeEvents;
  String? _id;
  String? _lease;
  bool _disposed = false;

  bool get available => RemoteConfig.translationEnabled && RemoteConfig.callTranslationEnabled;
  bool get active => state.value == CallTranslationState.active;
  bool get preparing => state.value == CallTranslationState.preparing;

  Future<String?> start(String lang) async {
    if (!RemoteConfig.translationEnabled || !RemoteConfig.callTranslationEnabled) {
      state.value = CallTranslationState.unavailable;
      return 'disabled';
    }
    state.value = CallTranslationState.preparing;
    targetLanguage.value = lang;
    Map<String, dynamic> pending;
    try {
      pending = await TranslationApi.callStart(
        callRef: callRef,
        targetLang: lang,
        sourceCapability: CallTranslationAudioBridge.sourceCapability,
      );
    } catch (_) {
      state.value = CallTranslationState.error;
      return 'network_unavailable';
    }
    final status = (pending['status'] as num?)?.toInt() ?? 0;
    if (status != 200) {
      state.value = status == 402 ? CallTranslationState.fundsStopped : CallTranslationState.error;
      return status == 402 ? 'insufficient_avacoins' : 'failed';
    }
    _id = pending['session_id']?.toString();
    _lease = pending['source_lease']?.toString();
    final token = pending['token']?.toString();
    if (_id == null || _lease == null || token == null || token.isEmpty) return _fail('failed');
    try {
      // Gemini setupComplete is required before the backend may charge minute 1.
      await bridge.prepare(token: token, targetLanguage: lang);
    } catch (_) {
      await _stopUnbilledPending();
      state.value = CallTranslationState.unavailable;
      return 'source_capture_unavailable';
    }
    try {
      // Prove decoded capture, provider input, and translated playback can all
      // start before crossing the paid boundary. This creates only a brief
      // unbilled setup interval while /activate performs the first debit.
      await bridge.activate();
    } catch (_) {
      await _stopUnbilledPending();
      state.value = CallTranslationState.unavailable;
      return 'playback_unavailable';
    }
    if (state.value != CallTranslationState.preparing || _id == null || _lease == null) {
      await _stopUnbilledPending();
      return 'provider_unavailable';
    }
    Map<String, dynamic> active;
    try {
      active = await TranslationApi.callActivate(_id!, _lease!);
    } catch (_) {
      // The Worker charge operation is idempotent. Retry once so an ambiguous
      // network timeout cannot leave a successful debit looking like a failure.
      try {
        active = await TranslationApi.callActivate(_id!, _lease!);
      } catch (_) {
        await _stopUnbilledPending();
        state.value = CallTranslationState.error;
        return 'network_unavailable';
      }
    }
    final activeStatus = (active['status'] as num?)?.toInt() ?? 0;
    if (activeStatus != 200) {
      await bridge.stop();
      if (activeStatus == 402) {
        state.value = CallTranslationState.fundsStopped;
        return 'insufficient_avacoins';
      }
      return _fail('source_not_ready');
    }
    try {
      await bridge.commitPaid();
    } catch (_) {
      await bridge.stop();
      await TranslationApi.callStop(_id!).catchError((_) => <String, dynamic>{});
      _id = null;
      _lease = null;
      state.value = CallTranslationState.error;
      return 'playback_unavailable';
    }
    billedTokens.value = 5;
    state.value = CallTranslationState.active;
    _renew = Timer.periodic(const Duration(minutes: 1), (_) => _renewMinute());
    _clock = Timer.periodic(const Duration(seconds: 1), (_) => elapsedSeconds.value++);
    Analytics.capture('call_translation_started', {'language': lang, 'rate_per_min': 5});
    return null;
  }

  Future<void> _renewMinute() async {
    final id = _id;
    if (id == null || !active) return;
    Map<String, dynamic> r;
    try {
      r = await TranslationApi.callRenew(id);
    } catch (_) {
      await _stopForProviderFailure('billing_unreachable');
      return;
    }
    final status = (r['status'] as num?)?.toInt() ?? 0;
    if (status == 200) billedTokens.value = (r['billed_tokens'] as num?)?.toInt() ?? billedTokens.value + 5;
    if (status == 402) {
      await bridge.stop();
      final stoppedId = _id;
      _id = null;
      _lease = null;
      state.value = CallTranslationState.fundsStopped;
      _renew?.cancel();
      _clock?.cancel();
      if (stoppedId != null) {
        try { await TranslationApi.callStop(stoppedId); } catch (_) {}
      }
      Analytics.capture('call_translation_funds_stopped', {'reason': 'balance_exhausted'});
    } else if (status != 200) {
      await _stopForProviderFailure('renewal_rejected');
    }
  }

  Future<void> stop() async {
    _renew?.cancel(); _clock?.cancel();
    await bridge.stop();
    final id = _id;
    _id = null; _lease = null;
    if (id != null) await TranslationApi.callStop(id).catchError((_) => <String, dynamic>{});
    if (!_disposed) state.value = CallTranslationState.off;
    Analytics.capture('call_translation_stopped', {'billed_tokens': billedTokens.value});
  }

  Future<void> _stopUnbilledPending() async {
    await bridge.stop();
    final id = _id;
    _id = null;
    _lease = null;
    if (id != null) {
      try { await TranslationApi.callStop(id); } catch (_) {}
    }
  }

  void _onBridgeEvent(CallTranslationAudioEvent event) {
    if (_disposed) return;
    if (event.type == 'caption') {
      caption.value = event.value ?? '';
      return;
    }
    if (event.type == 'provider_error' || event.type == 'provider_closed' || event.type == 'bridge_error') {
      unawaited(_stopForProviderFailure(event.type));
    } else if (event.type == 'resume_token_needed' && event.value != null) {
      unawaited(_resumeProvider(event.value!));
    }
  }

  Future<void> _stopForProviderFailure(String reason) async {
    if (!active && state.value != CallTranslationState.preparing) return;
    _renew?.cancel();
    _clock?.cancel();
    await bridge.stop();
    final id = _id;
    _id = null;
    _lease = null;
    if (id != null) {
      try { await TranslationApi.callStop(id); } catch (_) {}
    }
    if (!_disposed) state.value = CallTranslationState.error;
    Analytics.capture('call_translation_provider_stopped', {'reason': reason});
  }

  Future<void> _resumeProvider(String handle) async {
    final id = _id;
    if (id == null || !active || _resumingProvider) return;
    _resumingProvider = true;
    try {
      final response = await TranslationApi.callToken(id);
      if ((response['status'] as num?)?.toInt() != 200) throw StateError('token rejected');
      final token = response['token']?.toString();
      if (token == null || token.isEmpty) throw StateError('token missing');
      await bridge.resume(token: token, handle: handle);
    } catch (_) {
      await _stopForProviderFailure('resume_failed');
    } finally {
      _resumingProvider = false;
    }
  }

  Future<bool> resumeAfterTopUp() async {
    // A stopped lease cannot be resumed silently; the caller must start a new
    // minute/session so each paid boundary is explicit and idempotent.
    return false;
  }

  String _fail(String reason) {
    state.value = CallTranslationState.error;
    unawaited(stop());
    return reason;
  }

  void dispose() {
    _disposed = true;
    unawaited(_bridgeEvents?.cancel());
    unawaited(stop());
    state.dispose(); targetLanguage.dispose(); caption.dispose(); billedTokens.dispose(); elapsedSeconds.dispose();
  }
}
