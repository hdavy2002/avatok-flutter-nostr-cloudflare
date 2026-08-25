/// Safe, best-effort pre-warm for an incoming 1:1 call.
///
/// The incoming ring path may authenticate and reserve one Cloudflare SFU
/// session. It must never acquire a microphone, create a MediaStream, publish,
/// pull, or attach remote audio before Accept. Any failure falls through to the
/// normal cold call path.
library;

import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:stream_webrtc_flutter/stream_webrtc_flutter.dart';

import '../analytics.dart';
import '../ice_cache.dart';
import '../disk_cache.dart';
import '../remote_config.dart';
import 'call_sfu_api.dart';
import 'call_sfu_transport.dart';

/// Result adopted by CallSession after Accept. The old preroll members are
/// retained as inert compatibility fields for staged rollouts; they are always
/// null/false in the safe implementation.
class CallPrewarmedData {
  CallPrewarmedData({
    required this.join,
    required this.iceServers,
    this.nonce = '',
    this.generation,
    this.transportPc,
    this.transportReady = false,
    this.transportAudioSender,
    this.transportAudioMid,
    this.transportAudioTrackName,
    this.prerollStream,
    this.prerollTransport,
    this.prerollPc,
    this.prerollEarlyTracks = const <RTCTrackEvent>[],
    this.prerollPublished = false,
    this.prerollPulled = false,
  });

  final CallSfuJoinResult? join;
  final List<Map<String, dynamic>> iceServers;
  final String nonce;
  final int? generation;
  final RTCPeerConnection? transportPc;
  final bool transportReady;
  /// Retained send-only sender. It has no track until Accept calls
  /// replaceTrack(realMicTrack), so the prewarm cannot read the microphone.
  final RTCRtpSender? transportAudioSender;
  final String? transportAudioMid;
  final String? transportAudioTrackName;
  @Deprecated('Pre-accept media is retired; always null.')
  final MediaStream? prerollStream;
  @Deprecated('Pre-accept media is retired; always null.')
  final CallSfuTransport? prerollTransport;
  @Deprecated('Pre-accept media is retired; always null.')
  final RTCPeerConnection? prerollPc;
  @Deprecated('Pre-accept media is retired; always empty.')
  final List<RTCTrackEvent> prerollEarlyTracks;
  @Deprecated('Pre-accept media is retired; always false.')
  final bool prerollPublished;
  @Deprecated('Pre-accept media is retired; always false.')
  final bool prerollPulled;

  bool get hasFullPreroll => false;
  bool get hasJoin => join != null && join!.sessionId.isNotEmpty;
  bool get hasPrepublishedAudio =>
      transportPc != null &&
      transportAudioSender != null &&
      (transportAudioMid?.isNotEmpty ?? false) &&
      (transportAudioTrackName?.isNotEmpty ?? false);
}

enum CallPrewarmPhase { idle, prewarming, ready, adopted, cancelled, failed }

/// Missing legacy ring metadata is a wildcard, not a new lease. The native and
/// Flutter ring paths can converge after an FCM lease has already been created;
/// they must not supersede that nonce/generation with empty compatibility data.
bool callPrewarmLeaseMatches({
  required String existingCallId,
  required String incomingCallId,
  required String existingNonce,
  required String incomingNonce,
  required int? existingGeneration,
  required int? incomingGeneration,
}) =>
    existingCallId == incomingCallId &&
    (incomingNonce.isEmpty || existingNonce == incomingNonce) &&
    (incomingGeneration == null || existingGeneration == incomingGeneration);

/// Resolve the audio m-section mid from an offer without requiring a WebRTC
/// runtime. This is the fallback after setLocalDescription when the plugin has
/// not surfaced transceiver.mid yet.
String? callPrewarmAudioMidFromSdp(String? sdp) {
  if (sdp == null || sdp.isEmpty) return null;
  var inAudio = false;
  for (final line in sdp.split(RegExp(r'\r?\n'))) {
    if (line.startsWith('m=')) {
      inAudio = line.startsWith('m=audio ');
      continue;
    }
    if (inAudio && line.startsWith('a=mid:')) {
      final mid = line.substring('a=mid:'.length).trim();
      return mid.isEmpty ? null : mid;
    }
  }
  return null;
}

class _Entry {
  _Entry({
    required this.callId,
    required this.startedAtMs,
    required this.nonce,
    required this.generation,
    required this.networkIdentity,
    this.deviceId = '',
    this.billingAuthorizationId,
    this.billingCallId,
    this.billingAttemptId,
    this.billingPriceVersion,
  });
  final String callId;
  final int startedAtMs;
  final String nonce;
  final int? generation;
  String? networkIdentity;
  final String deviceId;
  String? billingAuthorizationId;
  String? billingCallId;
  String? billingAttemptId;
  int? billingPriceVersion;
  StreamSubscription<List<ConnectivityResult>>? networkSub;
  Future<CallSfuJoinResult?>? joinFuture;
  Future<List<Map<String, dynamic>>>? iceFuture;
  CallSfuJoinResult? join;
  RTCPeerConnection? transportPc;
  RTCDataChannel? transportChannel;
  RTCRtpSender? transportAudioSender;
  String? transportAudioMid;
  String? transportAudioTrackName;
  Future<void>? transportFuture;
  bool transportReady = false;
  /// [CALL-PREWARM-TRUTH-1] True once `_prepareTransport` has FINISHED, however
  /// it finished. `transportFuture != null` only says the attempt was started;
  /// it stays non-null forever afterwards, including after a failure, so it
  /// cannot be used to answer "is there a published sender to adopt?".
  bool transportSettled = false;
  /// [CALL-PREWARM-TRUTH-1] False when the SFU itself is switched off
  /// (`callSfuV1`). The seat/publish half of the prewarm is skipped in that
  /// case; only the ICE warm-up runs, and Accept must take the cold path.
  bool sfuPrewarmEligible = true;
  bool readyPosted = false;
  bool discarded = false;
  CallPrewarmPhase phase = CallPrewarmPhase.prewarming;
}

class CallPrewarm {
  CallPrewarm._();
  static final CallPrewarm instance = CallPrewarm._();

  static const int freshWindowMs = 40000;
  static const Duration joinDeadline = Duration(seconds: 12);
  static const Duration teardownWait = Duration(seconds: 2);
  static const Duration transportDeadline = Duration(seconds: 12);

  _Entry? _entry;
  int _now() => DateTime.now().millisecondsSinceEpoch;
  CallPrewarmPhase get phase => _entry?.phase ?? CallPrewarmPhase.idle;
  String? get activeCallId => _entry?.callId;

  /// True while a foreground send-only audio prewarm is available or still
  /// completing. Accept may use an empty local stream during this window;
  /// [adopt] waits for the bounded transport future.
  ///
  /// [CALL-PREWARM-TRUTH-1 2026-08-21] This used to be
  /// `e.transportFuture != null`, which is true from the moment the attempt
  /// STARTS and stays true after it has completed by failing. Production runs
  /// `callSilentTransportPrewarmV1 = true` with `callSfuV1 = false`, so every
  /// incoming ring got `call_sfu_blocked reason=flag_off` /
  /// `CallSfuException(sfu_unavailable, 503)` and then still reported a
  /// published audio sender here. Accept believed it, installed the null-track
  /// protocol-silence stream, deferred `getUserMedia` until after the answer,
  /// and the answering phone transmitted silence for the whole call
  /// (`mic_audio_level = 0.0`, `mic_energy_delta = 0`) while also paying ~2.2s
  /// of post-accept mic acquisition — the exact opposite of instant pickup.
  bool hasPrepublishedAudio(String callId) {
    final e = _entry;
    if (e == null || e.callId != callId || e.discarded) return false;
    if (!e.sfuPrewarmEligible) return false;
    if (e.transportFuture == null) return false;
    if (e.phase == CallPrewarmPhase.failed) return false;
    // Still in flight is a legitimate claim: `adopt` awaits the bounded
    // transport future, so Accept may hold the empty slot for that window.
    if (!e.transportSettled) return true;
    // Settled: the claim only survives if it is backed by a real sender.
    return e.transportReady &&
        e.transportPc != null &&
        e.transportAudioSender != null &&
        (e.transportAudioMid?.isNotEmpty ?? false) &&
        (e.transportAudioTrackName?.isNotEmpty ?? false);
  }

  /// Fire-and-forget. Idempotent for one call generation/nonce, and always
  /// best-effort so it cannot delay or suppress a ring.
  void start(
    String callId, {
    String nonce = '',
    int? generation,
    String? networkIdentity,
    bool transportOnly = false,
    String deviceId = '',
    String? billingAuthorizationId,
    String? billingCallId,
    String? billingAttemptId,
    int? billingPriceVersion,
  }) {
    if (callId.isEmpty) return;
    if (!transportOnly && !RemoteConfig.callPrewarmOnRingV1) return;
    if (transportOnly && !RemoteConfig.callSilentTransportPrewarmV1) return;
    final old = _entry;
    if (old != null &&
        callPrewarmLeaseMatches(
          existingCallId: old.callId,
          incomingCallId: callId,
          existingNonce: old.nonce,
          incomingNonce: nonce,
          existingGeneration: old.generation,
          incomingGeneration: generation,
        ) &&
        !old.discarded) {
      old.billingAuthorizationId ??= billingAuthorizationId;
      old.billingCallId ??= billingCallId;
      old.billingAttemptId ??= billingAttemptId;
      old.billingPriceVersion ??= billingPriceVersion;
      return;
    }
    if (old != null) unawaited(_discardEntry(old, 'superseded'));
    final e = _Entry(
      callId: callId,
      startedAtMs: _now(),
      nonce: nonce,
      generation: generation,
      networkIdentity: networkIdentity,
      deviceId: deviceId,
      billingAuthorizationId: billingAuthorizationId,
      billingCallId: billingCallId,
      billingAttemptId: billingAttemptId,
      billingPriceVersion: billingPriceVersion,
    );
    _entry = e;
    // [CALL-PREWARM-TRUTH-1] The SFU seat cannot be prewarmed while the SFU is
    // off — `join` answers 503 every time. The ICE warm-up below is a separate
    // thing and is what actually makes the P2P answer fast, so it ALWAYS runs;
    // only the join/publish half is skipped.
    final sfuEligible = RemoteConfig.callSfuV1;
    e.sfuPrewarmEligible = sfuEligible;
    _capture('call_prewarm_started', {
      'call_id': callId,
      'trigger': 'fcm_background',
      'sfu_eligible': sfuEligible,
      'warms': sfuEligible ? 'ice_and_sfu_seat' : 'ice_only',
      if (nonce.isNotEmpty) 'nonce': nonce,
      if (generation != null) 'generation': generation,
    });
    e.iceFuture = IceCache.get().catchError((_) => <Map<String, dynamic>>[]);
    if (!sfuEligible) return;
    e.joinFuture = _restoreOrJoin(e);
  }

  /// The FCM background isolate is short-lived. Keep its JOIN alive long
  /// enough to persist the exact seat/ICE handoff, so the foreground isolate
  /// can adopt it without pretending the two Dart heaps are shared.
  Future<void> startJoinOnly(
    String callId, {
    String nonce = '',
    int? generation,
    String? networkIdentity,
    String deviceId = '',
    String? billingAuthorizationId,
    String? billingCallId,
    String? billingAttemptId,
    int? billingPriceVersion,
  }) async {
    start(callId,
      nonce: nonce,
      generation: generation,
      networkIdentity: networkIdentity,
      transportOnly: true,
      deviceId: deviceId,
      billingAuthorizationId: billingAuthorizationId,
      billingCallId: billingCallId,
      billingAttemptId: billingAttemptId,
      billingPriceVersion: billingPriceVersion,
    );
    final e = _entry;
    if (e != null && e.callId == callId) {
      try { await e.joinFuture?.timeout(joinDeadline); } catch (_) {}
    }
  }

  /// Main-isolate-only phase. The background FCM handler never calls this: it
  /// only runs [start], which performs JOIN and no WebRTC work.
  Future<void> startForegroundTransport(
    String callId, {
    String nonce = '',
    int? generation,
    String? networkIdentity,
    String deviceId = '',
    String? billingAuthorizationId,
    String? billingCallId,
    String? billingAttemptId,
    int? billingPriceVersion,
  }) async {
    if (!RemoteConfig.callSilentTransportPrewarmV1) return;
    // [CALL-PREWARM-TRUTH-1] Publishing a send-only section needs a live SFU.
    // With `callSfuV1` off this is a guaranteed 503 that costs the ring a
    // round trip AND leaves a phantom publish claim behind. Stop at the door.
    if (!RemoteConfig.callSfuV1) {
      _capture('call_prewarm_transport_skipped', {
        'call_id': callId,
        'reason': 'sfu_disabled',
      });
      return;
    }
    var e = _entry;
    if (e == null || e.callId != callId || e.discarded) {
      start(callId, nonce: nonce, generation: generation,
          networkIdentity: networkIdentity, transportOnly: true,
          deviceId: deviceId,
          billingAuthorizationId: billingAuthorizationId,
          billingCallId: billingCallId,
          billingAttemptId: billingAttemptId,
          billingPriceVersion: billingPriceVersion);
      e = _entry;
    }
    if (e == null || e.callId != callId || e.discarded) return;
    final currentNetwork = await _currentNetworkIdentity();
    if (e.networkIdentity == null || e.networkIdentity!.isEmpty) {
      e.networkIdentity = currentNetwork;
    }
    if (nonce.isNotEmpty && nonce != e.nonce) {
      await discard(callId, 'stale_nonce');
      return;
    }
    if (generation != null && generation != e.generation) {
      await discard(callId, 'stale_generation');
      return;
    }
    if (networkIdentity != null && e.networkIdentity != null &&
        networkIdentity != e.networkIdentity) {
      await discard(callId, 'network_changed');
      return;
    }
    if (currentNetwork.isNotEmpty && e.networkIdentity != currentNetwork) {
      await discard(callId, 'network_changed');
      return;
    }
    e.networkSub ??= Connectivity().onConnectivityChanged.listen((results) {
      final next = _networkIdentity(results);
      if (next.isNotEmpty && next != e!.networkIdentity) {
        unawaited(discard(callId, 'network_changed'));
      }
    }, onError: (_) {});
    if (e.transportReady) return;
    final existing = e.transportFuture;
    if (existing != null) {
      await existing;
      return;
    }
    final future = _prepareTransport(e);
    e.transportFuture = future;
    await future;
  }

  Future<void> _prepareTransport(_Entry e) async {
    RTCPeerConnection? pc;
    try {
      final join = await _awaitJoin(e);
      if (e.discarded || join == null || join.sessionId.isEmpty) {
        // [CALL-PREWARM-TRUTH-1] This used to be a bare `return`: the future
        // completed normally, nothing was recorded, and the entry kept looking
        // like a prewarm in good standing. A join that never arrived is a
        // failed transport and must say so, or Accept reads the silence.
        if (!e.discarded) {
          e.phase = CallPrewarmPhase.failed;
          _capture('call_prewarm_transport_failed', {
            'call_id': e.callId,
            'failure':
                join == null ? 'join_unavailable' : 'join_missing_session',
          });
        }
        return;
      }
      pc = await createPeerConnection({
        'iceServers': join.iceServers,
        'iceCandidatePoolSize': 2,
      });
      if (e.discarded) {
        await pc.close();
        return;
      }
      e.transportPc = pc;
      // Privacy boundary: negotiate a SENDONLY audio slot with no track. This
      // cannot read from the microphone. Accept later swaps the retained sender
      // to the real mic using replaceTrack(), with no second offer.
      final audioTransceiver = await pc.addTransceiver(
        kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
        init: RTCRtpTransceiverInit(direction: TransceiverDirection.SendOnly),
      );
      e.transportAudioSender = audioTransceiver.sender;
      final connected = Completer<void>();
      pc.onConnectionState = (state) {
        if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected &&
            !connected.isCompleted) {
          connected.complete();
        } else if ((state == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
                state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) &&
            !connected.isCompleted) {
          connected.completeError(StateError('transport_${state.name}'));
        }
      };
      final offer = await pc.createOffer({
        'offerToReceiveAudio': false,
        'offerToReceiveVideo': false,
      });
      await pc.setLocalDescription(offer);
      final audioMid = audioTransceiver.mid.isNotEmpty
          ? audioTransceiver.mid
          : callPrewarmAudioMidFromSdp(offer.sdp);
      if (audioMid == null || audioMid.isEmpty) {
        throw StateError('transport_audio_mid_unresolved');
      }
      e.transportAudioMid = audioMid;
      final audioTrackName = 'audio-${join.sessionId}';
      e.transportAudioTrackName = audioTrackName;
      _capture('call_prewarm_audio_publish_started', {
        'call_id': e.callId,
        'mid': audioMid,
        'track_name': audioTrackName,
        'privacy': 'sendonly_null_track',
      });
      final answer = await CallSfuApi.publishPreAccept(
        e.callId,
        join.sessionId,
        offer.sdp ?? '',
        <Map<String, dynamic>>[{
          'mid': audioMid,
          'kind': 'audio',
          'trackName': audioTrackName,
        }],
        prewarmNonce: e.nonce,
        prewarmGeneration: e.generation ?? 1,
        prewarmDeviceId: e.deviceId,
      );
      if (answer == null || answer['sdp'] == null || e.discarded) {
        throw StateError('transport_publish_no_answer');
      }
      await pc.setRemoteDescription(RTCSessionDescription(
        answer['sdp'].toString(),
        (answer['type'] ?? 'answer').toString(),
      ));
      await connected.future.timeout(transportDeadline);
      if (e.discarded) return;
      e.transportReady = true;
      e.phase = CallPrewarmPhase.ready;
      if (e.deviceId.isEmpty) throw StateError('transport_missing_device_id');
      await CallSfuApi.prewarmReady(
        e.callId,
        nonce: e.nonce,
        generation: e.generation ?? 1,
        sessionId: join.sessionId,
        deviceId: e.deviceId,
        mediaReadyRequired: true,
      );
      e.readyPosted = true;
      _capture('call_prewarm_transport_ready', {
        'call_id': e.callId,
        'transport': 'audio_sendonly_null_track',
        'ready_truth': 'ice_dtls_connected_sfu_published',
      });
      _capture('call_prewarm_audio_publish_ready', {
        'call_id': e.callId,
        'mid': audioMid,
        'privacy': 'protocol_silence_until_accept',
      });
    } catch (error) {
      _capture('call_prewarm_transport_failed', {
        'call_id': e.callId,
        'failure': error.toString(),
      });
      e.transportReady = false;
      e.phase = CallPrewarmPhase.failed;
      final channel = e.transportChannel;
      e.transportChannel = null;
      try { await channel?.close(); } catch (_) {}
      try { await pc?.close(); } catch (_) {}
      e.transportPc = null;
      // The server seat is coupled to this failed negotiation. Retire this
      // exact session before Accept can fall through to a fresh join.
      final failedJoin = e.join;
      e.join = null;
      if (failedJoin != null && failedJoin.sessionId.isNotEmpty) {
        final mids = e.transportAudioMid == null
            ? const <String>[]
            : <String>[e.transportAudioMid!];
        try { await CallSfuApi.close(e.callId, failedJoin.sessionId, mids); } catch (_) {}
      }
      await _deleteHandoff(e);
    } finally {
      // [CALL-PREWARM-TRUTH-1] Every exit from this method — published,
      // failed, or returned early — marks the attempt settled, so
      // `hasPrepublishedAudio` can stop treating "started" as "succeeded".
      e.transportSettled = true;
    }
  }

  Future<CallSfuJoinResult?> _restoreOrJoin(_Entry e) async {
    final restored = await _readHandoff(e);
    if (restored != null) {
      e.join = restored;
      e.phase = CallPrewarmPhase.ready;
      _capture('call_prewarm_handoff_restored', {'call_id': e.callId});
      return restored;
    }
    return _join(e);
  }

  Future<CallSfuJoinResult?> _join(_Entry e) async {
    final started = _now();
    final request = CallSfuApi.join(
      e.callId,
      prewarmNonce: e.nonce,
      prewarmGeneration: e.generation,
      prewarmDeviceId: e.deviceId,
      billingAuthorizationId: e.billingAuthorizationId,
      billingCallId: e.billingCallId,
      billingAttemptId: e.billingAttemptId,
      billingPriceVersion: e.billingPriceVersion,
    );
    try {
      final result = await request.timeout(joinDeadline);
      if (e.discarded) {
        if (result.sessionId.isNotEmpty) {
          unawaited(CallSfuApi.close(e.callId, result.sessionId, const []));
        }
        return null;
      }
      e.join = result;
      e.phase = CallPrewarmPhase.ready;
      await _writeHandoff(e, result);
      _capture('call_prewarm_joined', {
        'call_id': e.callId,
        'elapsed_ms': _now() - started,
        'result': 'ok',
      });
      return result;
    } on TimeoutException {
      e.phase = CallPrewarmPhase.failed;
      _capture('call_prewarm_joined', {
        'call_id': e.callId,
        'elapsed_ms': _now() - started,
        'result': 'timeout',
      });
      // Future.timeout cannot cancel HTTP. Close a late seat when it resolves.
      unawaited(request.then((late) async {
        if (late.sessionId.isNotEmpty) {
          await CallSfuApi.close(e.callId, late.sessionId, const []);
        }
      }).catchError((_) {}));
      return null;
    } catch (error) {
      e.phase = CallPrewarmPhase.failed;
      _capture('call_prewarm_joined', {
        'call_id': e.callId,
        'elapsed_ms': _now() - started,
        'result': 'failed',
        'failure': error.toString(),
      });
      return null;
    }
  }

  /// Retired compatibility hook. It intentionally never returns media.
  MediaStream? peek(String callId) => null;

  /// Claims a join exactly once. A stale nonce/generation/network identity or
  /// lease returns null, causing the caller to execute the cold path.
  Future<CallPrewarmedData?> adopt(
    String callId, {
    String nonce = '',
    int? generation,
    String? networkIdentity,
    MediaStream? currentStream,
  }) async {
    if (callId.isEmpty ||
        (!RemoteConfig.callPrewarmOnRingV1 && !RemoteConfig.callSilentTransportPrewarmV1)) {
      return null;
    }
    final e = _entry;
    if (e == null || e.callId != callId || e.discarded) return null;
    if (nonce.isNotEmpty && nonce != e.nonce) {
      await discard(callId, 'stale_nonce');
      return null;
    }
    if (generation != null && generation != e.generation) {
      await discard(callId, 'stale_generation');
      return null;
    }
    if (networkIdentity != null &&
        e.networkIdentity != null &&
        networkIdentity != e.networkIdentity) {
      await discard(callId, 'network_changed');
      return null;
    }
    final currentNetwork = await _currentNetworkIdentity();
    if (e.networkIdentity != null && e.networkIdentity!.isNotEmpty &&
        currentNetwork.isNotEmpty && currentNetwork != e.networkIdentity) {
      await discard(callId, 'network_changed');
      return null;
    }
    final age = _now() - e.startedAtMs;
    if (age < 0 || age > freshWindowMs) {
      await discard(callId, 'stale');
      return null;
    }
    if (e.transportFuture != null) {
      try { await e.transportFuture!.timeout(transportDeadline); } catch (_) {}
      if (!e.transportReady) {
        _entry = null;
        await _discardEntry(e, 'transport_not_ready');
        return null;
      }
    }
    _entry = null; // first-answer-wins, exactly once
    await e.networkSub?.cancel();
    e.networkSub = null;
    e.phase = CallPrewarmPhase.adopted;
    final join = await _awaitJoin(e);
    final ice = await _awaitIce(e);
    final transportPc = e.transportReady ? e.transportPc : null;
    final transportAudioSender = e.transportReady ? e.transportAudioSender : null;
    final transportAudioMid = e.transportReady ? e.transportAudioMid : null;
    final transportAudioTrackName = e.transportReady ? e.transportAudioTrackName : null;
    await _deleteHandoff(e);
    _capture('call_prewarm_adopted', {
      'call_id': callId,
      'age_ms': age,
      'had_join': join != null && join.sessionId.isNotEmpty,
      'fallback': join == null,
    });
    return CallPrewarmedData(
      join: join,
      iceServers: ice,
      nonce: e.nonce,
      generation: e.generation,
      transportPc: transportPc,
      transportReady: transportPc != null,
      transportAudioSender: transportAudioSender,
      transportAudioMid: transportAudioMid,
      transportAudioTrackName: transportAudioTrackName,
    );
  }

  Future<CallSfuJoinResult?> _awaitJoin(_Entry e) async {
    try {
      return await (e.joinFuture ?? Future<CallSfuJoinResult?>.value(e.join))
          .timeout(joinDeadline);
    } catch (_) {
      return null;
    }
  }

  Future<List<Map<String, dynamic>>> _awaitIce(_Entry e) async {
    try {
      return await (e.iceFuture ??
              Future<List<Map<String, dynamic>>>.value(const []))
          .timeout(const Duration(seconds: 3));
    } catch (_) {
      return const <Map<String, dynamic>>[];
    }
  }

  Future<void> discard(String callId, String reason) async {
    final e = _entry;
    if (e == null || e.callId != callId) return;
    _entry = null;
    await _discardEntry(e, reason);
  }

  Future<void> _discardEntry(_Entry e, String reason) async {
    if (e.discarded) return;
    e.discarded = true;
    e.phase = CallPrewarmPhase.cancelled;
    _capture('call_prewarm_discarded', {
      'call_id': e.callId,
      'reason': reason,
      'age_ms': _now() - e.startedAtMs,
    });
    final pc = e.transportPc;
    e.transportPc = null;
    final channel = e.transportChannel;
    e.transportChannel = null;
    await e.networkSub?.cancel();
    e.networkSub = null;
    try { await channel?.close(); } catch (_) {}
    try { await pc?.close(); } catch (_) {}
    final join = await _awaitJoinBounded(e);
    if (join != null && join.sessionId.isNotEmpty) {
      final mids = e.transportAudioMid == null
          ? const <String>[]
          : <String>[e.transportAudioMid!];
      try { await CallSfuApi.close(e.callId, join.sessionId, mids); } catch (_) {}
    }
    await _deleteHandoff(e);
  }

  Future<String> _handoffKey(_Entry e) async {
    final account = await DiskCache.readGlobal('clerk_account_id') ?? '';
    return 'call_prewarm_handoff_${account}_${e.deviceId}_${e.callId}_${e.nonce}';
  }

  Future<void> _writeHandoff(_Entry e, CallSfuJoinResult join) async {
    if (e.deviceId.isEmpty || e.nonce.isEmpty) return;
    try {
      await DiskCache.writeGlobal(await _handoffKey(e), jsonEncode({
        'call_id': e.callId,
        'nonce': e.nonce,
        'generation': e.generation,
        'network_identity': e.networkIdentity,
        'device_id': e.deviceId,
        'started_at_ms': e.startedAtMs,
        'join': {
          'session_id': join.sessionId,
          'ice_servers': join.iceServers,
          'relay_available': join.relayAvailable,
          'relay_degraded': join.relayDegraded,
          'video_allowed': join.videoAllowed,
          'relay_reason': join.relayReason,
        },
      }));
    } catch (_) {}
  }

  Future<CallSfuJoinResult?> _readHandoff(_Entry e) async {
    if (e.deviceId.isEmpty || e.nonce.isEmpty) return null;
    try {
      final raw = await DiskCache.readGlobal(await _handoffKey(e));
      if (raw == null || raw.isEmpty) return null;
      final j = jsonDecode(raw);
      if (j is! Map || j['call_id']?.toString() != e.callId ||
          j['nonce']?.toString() != e.nonce ||
          j['device_id']?.toString() != e.deviceId) return null;
      final started = int.tryParse((j['started_at_ms'] ?? '').toString());
      final age = started == null ? -1 : _now() - started;
      if (age < 0 || age > freshWindowMs) {
        await DiskCache.deleteGlobal(await _handoffKey(e));
        return null;
      }
      final join = j['join'];
      if (join is! Map) return null;
      final restored = join.cast<String, dynamic>();
      return CallSfuJoinResult(
        sessionId: (restored['session_id'] ?? '').toString(),
        iceServers: ((restored['ice_servers'] as List?) ?? const [])
            .cast<Map>()
            .map((v) => v.cast<String, dynamic>())
            .toList(),
        relayAvailable: restored['relay_available'] == true,
        relayDegraded: restored['relay_degraded'] == true,
        videoAllowed: restored['video_allowed'] != false,
        relayReason: restored['relay_reason']?.toString(),
      );
    } catch (_) {
      return null;
    }
  }

  Future<void> _deleteHandoff(_Entry e) async {
    if (e.deviceId.isEmpty || e.nonce.isEmpty) return;
    await DiskCache.deleteGlobal(await _handoffKey(e));
  }

  Future<CallSfuJoinResult?> _awaitJoinBounded(_Entry e) async {
    try {
      return await (e.joinFuture ?? Future<CallSfuJoinResult?>.value(e.join))
          .timeout(teardownWait);
    } catch (_) {
      return e.join;
    }
  }

  /// SFU ICE credentials and sessions are not portable across interface
  /// changes. Discarding forces a clean, current join on Accept.
  Future<void> notifyNetworkChanged({String? networkIdentity}) async {
    final e = _entry;
    if (e == null) return;
    if (networkIdentity != null && networkIdentity == e.networkIdentity) return;
    await discard(e.callId, 'network_changed');
  }

  static String _networkIdentity(List<ConnectivityResult> results) {
    final names = results.map((r) => r.name).toSet().toList()..sort();
    return names.join('+');
  }

  Future<String> _currentNetworkIdentity() async {
    try {
      return _networkIdentity(await Connectivity().checkConnectivity());
    } catch (_) {
      return '';
    }
  }

  void _capture(String event, Map<String, Object> props) {
    try {
      Analytics.capture(event, props);
    } catch (_) {}
  }
}
