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
import 'package:flutter_webrtc/flutter_webrtc.dart';

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

class _Entry {
  _Entry({
    required this.callId,
    required this.startedAtMs,
    required this.nonce,
    required this.generation,
    required this.networkIdentity,
    this.deviceId = '',
  });
  final String callId;
  final int startedAtMs;
  final String nonce;
  final int? generation;
  String? networkIdentity;
  final String deviceId;
  StreamSubscription<List<ConnectivityResult>>? networkSub;
  Future<CallSfuJoinResult?>? joinFuture;
  Future<List<Map<String, dynamic>>>? iceFuture;
  CallSfuJoinResult? join;
  RTCPeerConnection? transportPc;
  RTCDataChannel? transportChannel;
  Future<void>? transportFuture;
  bool transportReady = false;
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

  /// Fire-and-forget. Idempotent for one call generation/nonce, and always
  /// best-effort so it cannot delay or suppress a ring.
  void start(
    String callId, {
    String nonce = '',
    int? generation,
    String? networkIdentity,
    bool transportOnly = false,
    String deviceId = '',
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
    );
    _entry = e;
    _capture('call_prewarm_started', {
      'call_id': callId,
      'trigger': 'fcm_background',
      if (nonce.isNotEmpty) 'nonce': nonce,
      if (generation != null) 'generation': generation,
    });
    e.iceFuture = IceCache.get().catchError((_) => <Map<String, dynamic>>[]);
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
  }) async {
    start(callId,
      nonce: nonce,
      generation: generation,
      networkIdentity: networkIdentity,
      transportOnly: true,
      deviceId: deviceId,
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
  }) async {
    if (!RemoteConfig.callSilentTransportPrewarmV1) return;
    var e = _entry;
    if (e == null || e.callId != callId || e.discarded) {
      start(callId, nonce: nonce, generation: generation,
          networkIdentity: networkIdentity, transportOnly: true,
          deviceId: deviceId);
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
      if (e.discarded || join == null || join.sessionId.isEmpty) return;
      pc = await createPeerConnection({
        'iceServers': join.iceServers,
        'iceCandidatePoolSize': 2,
      });
      if (e.discarded) {
        await pc.close();
        return;
      }
      e.transportPc = pc;
      // Must match the Cloudflare Connection API's server-events establish
      // contract. This carries no microphone or media track.
      e.transportChannel = await pc.createDataChannel('server-events', RTCDataChannelInit());
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
      final answer = await CallSfuApi.prepare(e.callId, join.sessionId, offer.sdp ?? '');
      if (answer == null || answer['sdp'] == null || e.discarded) {
        throw StateError('transport_prepare_no_answer');
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
      );
      e.readyPosted = true;
      _capture('call_prewarm_transport_ready', {
        'call_id': e.callId,
        'transport': 'datachannel_only',
        'ready_truth': 'ice_dtls_connected',
      });
    } catch (error) {
      _capture('call_prewarm_transport_failed', {
        'call_id': e.callId,
        'failure': error.toString(),
      });
      e.transportReady = false;
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
        try { await CallSfuApi.close(e.callId, failedJoin.sessionId, const []); } catch (_) {}
      }
      await _deleteHandoff(e);
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
    final request = CallSfuApi.join(e.callId);
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
      try { await CallSfuApi.close(e.callId, join.sessionId, const []); } catch (_) {}
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
