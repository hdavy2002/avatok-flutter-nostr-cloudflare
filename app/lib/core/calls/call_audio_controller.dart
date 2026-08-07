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

  /// The user's/current desired route. Seeded at call start from
  /// `config.video ? speaker : earpiece`; updated by every user toggle
  /// BEFORE the apply that carries it out, so a press is never overwritten
  /// by a slower in-flight apply that started with the old intent.
  CallAudioRoute intent = CallAudioRoute.earpiece;

  CallAudioRoute? _lastConfirmed;

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
    _callId = callId;
    intent = route;
    _lastConfirmed = null;
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
    _callId = null;
    onRouteConfirmed = null;
    _lastConfirmed = null;
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
    final requestedIntent = intent;
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
    final changed = _lastConfirmed != result.active;
    _lastConfirmed = result.active;
    onRouteConfirmed?.call(result.active == CallAudioRoute.speaker);
    Analytics.capture('call_audio_owner_apply', {
      'call_id': callId,
      'intent': requestedIntent.name,
      'source': source,
      'confirmed_route': result.active.name,
      'backend': result.backend,
      'reason': source,
      'changed': changed,
    });
    if (result.active != requestedIntent) {
      Analytics.capture('call_audio_owner_conflict', {
        'call_id': callId,
        'intent': requestedIntent.name,
        'confirmed_route': result.active.name,
        'source': source,
      });
    }
    return result;
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
