/// CallAudioController — [CALL-AUDIO-OWNER-1 2026-08-07]
///
/// THE single owner of "what route/mode is this call's audio in right now".
/// Everything that used to independently poke `AudioManager` (the hardcoded
/// `selectRoute` at the end of `_bootMedia`, the flag-off
/// `Helper.setSpeakerphoneOn` branch, the ringback tone player's own context
/// write, the receptionist native engine's `startEngine`) raced each other —
/// whichever wrote last won, regardless of what the user actually asked for.
/// Confirmed in prod telemetry: `call_audio_route_requested source=user_toggle`
/// at +5.2s with no matching `call_audio_route_result`, because the boot-media
/// hardcoded `selectRoute` landed after it in the same serialized native queue
/// and silently overwrote the user's Speaker press.
///
/// This class does not talk to the platform directly — it drives the existing
/// `NativeVoiceAudio.selectRoute` (which already serializes + confirms native
/// writes) with ONE thing: the current `intent`. Nothing else may call
/// `selectRoute` for a call while `RemoteConfig.callAudioOwnerV1` is on.
///
/// Gated behind `RemoteConfig.callAudioOwnerV1` (default true). Flag off
/// leaves every existing call site exactly as it was.
library;

import 'dart:async';

import '../analytics.dart';
import '../remote_config.dart';
import '../voice/native_voice_audio.dart';

class CallAudioController {
  CallAudioController._();
  static final CallAudioController instance = CallAudioController._();

  /// The call this controller currently owns. `apply`/`reassert` are no-ops
  /// once a different call's [seed] has taken over, so a straggling await
  /// from a just-ended call can never reach into the next one's route.
  String? _callId;
  int _generation = 0;

  /// The user's/current desired route. Seeded at call start from
  /// `config.video ? speaker : earpiece`; updated by every user toggle
  /// BEFORE the apply that carries it out, so a press is never overwritten
  /// by a slower in-flight apply that started with the old intent.
  CallAudioRoute intent = CallAudioRoute.earpiece;

  CallAudioRoute? _lastConfirmed;
  CallAudioRouteResult? _lastResult;

  /// Native confirmed an actual output device, even if Android had to use a
  /// safe fallback (for example an emulator has no earpiece and uses speaker).
  bool get hasUsableConfirmedRoute =>
      _lastResult != null &&
      _lastResult!.active != CallAudioRoute.unknown &&
      _lastResult!.fallbackReason != 'invoke_failed';

  String get confirmedRouteName => _lastResult?.active.name ?? 'unknown';

  /// Serializes [apply] calls so two callers (e.g. `boot_media` and a fast
  /// user tap) can never race each other into native writes out of order.
  Future<void> _queue = Future<void>.value();

  /// Installed once per call by `CallSession`: re-asserts every collaborator
  /// that must agree with the confirmed route — `speakerOn`, the ringback
  /// tone player's audio context, the receptionist's `speaker` flag.
  void Function(bool speakerOn)? onRouteConfirmed;

  /// Begin owning [callId]'s audio. [route] is the call's starting intent
  /// (`config.video ? speaker : earpiece`).
  void seed({required String callId, required CallAudioRoute route}) {
    _generation++;
    _callId = callId;
    intent = route;
    _lastConfirmed = null;
    _lastResult = null;
  }

  /// Update the desired route — call this BEFORE `apply` so a fast repeat
  /// toggle always carries the latest intent, never a stale one queued
  /// behind an earlier apply.
  void setIntent(CallAudioRoute route) {
    intent = route;
  }

  /// Release ownership of [callId]'s audio. No-op if another call already
  /// took over (mirrors `NativeVoiceAudio.endP2pSession`'s holder guard) —
  /// a straggling teardown must never clear the NEW call's callback.
  void release(String callId) {
    if (_callId != callId) return;
    _generation++;
    _callId = null;
    onRouteConfirmed = null;
    _lastConfirmed = null;
    _lastResult = null;
  }

  /// Apply [intent] to the native route. Serialized, safe to call
  /// concurrently from multiple sites (boot media, user toggle, a reassert
  /// after a disturbing transition) — always ends up requesting whatever
  /// `intent` is AT THE TIME the request actually runs, never a captured
  /// stale value.
  Future<CallAudioRouteResult?> apply({required String source}) {
    final op = _queue.then((_) => _applyInternal(source));
    // Swallow errors in the chain link itself so one failed apply cannot
    // permanently wedge the queue for subsequent callers.
    _queue = op.then((_) => null, onError: (_) => null);
    return op;
  }

  Future<CallAudioRouteResult?> _applyInternal(String source) async {
    if (!RemoteConfig.callAudioOwnerV1) return null;
    final callId = _callId ?? '';
    final generation = _generation;
    var requestedIntent = intent;
    CallAudioRouteResult result;
    try {
      result = await NativeVoiceAudio.instance
          .selectRoute(requestedIntent, source: source);
    } catch (e) {
      Analytics.capture('call_audio_owner_apply', {
        'call_id': callId,
        'intent': requestedIntent.name,
        'source': source,
        'confirmed_route': 'error',
        'backend': 'unknown',
        'reason': source,
        'changed': false,
        'error': e.toString(),
      });
      return null;
    }
    if (_callId != callId || _generation != generation) {
      Analytics.capture('call_audio_owner_stale_result_dropped', {
        'call_id': callId,
        'source': source,
      });
      return null;
    }
    if (result.active == CallAudioRoute.unknown ||
        result.fallbackReason == 'invoke_failed') {
      Analytics.capture('call_audio_route_recovery_started', {
        'call_id': callId,
        'intent': requestedIntent.name,
        'source': source,
        'first_active_route': result.active.name,
        'first_fallback_reason': result.fallbackReason ?? 'unknown',
      });
      await Future<void>.delayed(const Duration(milliseconds: 150));
      if (_callId != callId || _generation != generation) return null;
      // A speaker toggle may have landed while the recovery delay was running.
      // Retry the current intent, never the stale one captured above.
      requestedIntent = intent;
      try {
        final retry = await NativeVoiceAudio.instance.selectRoute(
          requestedIntent,
          source: '${source}_recovery',
        );
        result = retry;
        Analytics.capture('call_audio_route_recovery_result', {
          'call_id': callId,
          'intent': requestedIntent.name,
          'source': source,
          'active_route': retry.active.name,
          'exact': retry.exact,
          'usable': retry.active != CallAudioRoute.unknown &&
              retry.fallbackReason != 'invoke_failed',
          'backend': retry.backend,
          'fallback_reason': retry.fallbackReason ?? 'none',
          'attempts': 2,
        });
      } catch (e) {
        Analytics.capture('call_audio_route_recovery_result', {
          'call_id': callId,
          'intent': requestedIntent.name,
          'source': source,
          'active_route': result.active.name,
          'exact': false,
          'usable': false,
          'backend': result.backend,
          'fallback_reason': 'retry_exception',
          'attempts': 2,
          'error': e.toString(),
        });
      }
    }
    if (_callId != callId || _generation != generation) return null;
    final changed = _lastConfirmed != result.active;
    _lastConfirmed = result.active;
    _lastResult = result;
    onRouteConfirmed?.call(result.active == CallAudioRoute.speaker);
    Analytics.capture('call_audio_owner_apply', {
      'call_id': callId,
      'intent': requestedIntent.name,
      'source': source,
      'confirmed_route': result.active.name,
      'backend': result.backend,
      'reason': source,
      'changed': changed,
      'route_usable': hasUsableConfirmedRoute,
      'exact': result.exact,
      'fallback_reason': result.fallbackReason ?? 'none',
    });
    if (result.active != requestedIntent) {
      // [CALL-ROUTE-AVAIL-1 2026-08-21] Landing somewhere other than the intent
      // is only a CONFLICT if the intent was reachable. A device with no
      // built-in earpiece (every Android emulator, and some tablets) can only
      // ever answer "speaker" to an earpiece request, and reporting that as a
      // conflict on every single apply buries the real thing this event exists
      // to catch: a device that HAS the requested route and still did not get
      // it. On 2026-08-20 an emulator produced `intent=earpiece
      // confirmed_route=speaker` on all three test calls and was read as a bug.
      final available = await _routeIsAvailable(requestedIntent);
      if (available == false) {
        Analytics.capture('call_audio_route_unavailable', {
          'call_id': callId,
          'intent': requestedIntent.name,
          'confirmed_route': result.active.name,
          'source': source,
          'fallback_reason': result.fallbackReason ?? 'none',
        });
      } else {
        Analytics.capture('call_audio_owner_conflict', {
          'call_id': callId,
          'intent': requestedIntent.name,
          'confirmed_route': result.active.name,
          'source': source,
          // 'unknown' when the platform did not report an output-device
          // inventory (iOS today), in which case this stays a conflict as
          // before. Analytics maps are Map<String, Object>, so a raw bool?
          // does not compile — same convention as fallback_reason below.
          'intent_available': available ?? 'unknown',
          'fallback_reason': result.fallbackReason ?? 'none',
        });
      }
    }
    return result;
  }

  /// Android `AudioDeviceInfo` output types that satisfy each route.
  static const Map<CallAudioRoute, List<int>> _routeOutputDeviceTypes = {
    CallAudioRoute.earpiece: [1], // TYPE_BUILTIN_EARPIECE
    CallAudioRoute.speaker: [2], // TYPE_BUILTIN_SPEAKER
    // SCO, A2DP, BLE headset, BLE speaker
    CallAudioRoute.bluetooth: [7, 8, 26, 27],
    // wired headset, wired headphones, USB headset
    CallAudioRoute.wiredHeadset: [3, 4, 22],
  };

  /// [CALL-ROUTE-AVAIL-1] Whether [route] physically exists on this device.
  ///
  /// Returns null when the platform gives us no output-device inventory to
  /// judge by — the honest "don't know", which callers must treat as "assume
  /// it was available" so this can never HIDE a real conflict. Only consulted
  /// on the rare apply that missed its intent, so the extra native read costs
  /// nothing on the happy path.
  Future<bool?> _routeIsAvailable(CallAudioRoute route) async {
    final wanted = _routeOutputDeviceTypes[route];
    if (wanted == null) return null;
    try {
      final diagnostics = await NativeVoiceAudio.instance.getAudioDiagnostics();
      final raw = diagnostics?['output_device_types'];
      if (raw == null) return null;
      final text = raw.toString();
      if (text.isEmpty || text == 'unknown') return null;
      final present = text
          .split(',')
          .map((part) => int.tryParse(part.trim()))
          .whereType<int>()
          .toSet();
      if (present.isEmpty) return null;
      return wanted.any(present.contains);
    } catch (_) {
      return null;
    }
  }

  /// Re-assert the CURRENT intent after a transition known to disturb
  /// AudioManager underneath us: a tone start/swap, `startP2pAudioMode`, the
  /// receptionist native engine's `startEngine`, or regaining audio focus.
  /// [reason] is telemetry-only, carried as both `source` and `reason` on
  /// the resulting `call_audio_owner_apply` event.
  Future<void> reassert(String reason) async {
    if (!RemoteConfig.callAudioOwnerV1) return;
    await apply(source: reason);
  }
}
