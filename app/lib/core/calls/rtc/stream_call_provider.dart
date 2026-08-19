/// Optional Stream 1:1 call pilot adapter (audio now, video-ready seam).
///
/// This file intentionally has no `stream_video_flutter` import. AvaTOK already
/// ships `flutter_webrtc` and Cloudflare's `realtimekit_core`; Stream ships a
/// separate WebRTC build. Loading all three in the main Android application is
/// not a safe dependency experiment (duplicate `org.webrtc` classes and native
/// audio-session ownership are both possible). The real Stream SDK is therefore
/// an isolated native/plugin boundary for the pilot. Until that bridge is
/// installed, this adapter fails closed and the existing Cloudflare/P2P path is
/// unchanged.
///
/// The boundary deliberately implements the existing provider-neutral
/// [RtcProvider]/[RtcSession] contract. That gives the call code one provider
/// choice and makes a later Stream SDK package swap local to this file/native
/// bridge. No Stream SDK type crosses into AvaTOK call screens.
library;

import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

import '../../analytics.dart';
import '../../disk_cache.dart';
import '../../remote_config.dart';
import 'rtc_provider.dart';

/// Provider selected by the server before a call starts. Selection is sticky
/// for the lifetime of a call; it must never change during a live session.
enum CallMediaProvider {
  cloudflare,
  stream,
}

extension CallMediaProviderWire on CallMediaProvider {
  String get wire => switch (this) {
        CallMediaProvider.cloudflare => 'cloudflare',
        CallMediaProvider.stream => 'stream',
      };

  static CallMediaProvider fromWire(String value) =>
      value.trim().toLowerCase() == 'stream'
          ? CallMediaProvider.stream
          : CallMediaProvider.cloudflare;
}

/// There is no native Stream bridge in the current app build. Keeping this as
/// a named error makes the fallback and its telemetry distinguishable from an
/// actual Stream call rejection or network failure.
class StreamCallUnavailable implements Exception {
  StreamCallUnavailable(this.reason);
  final String reason;

  @override
  String toString() => 'StreamCallUnavailable($reason)';
}

/// Short-lived, server-minted Stream call credentials.
///
/// `token` is a call/user token, never an API secret. The server must mint it
/// for the authenticated account and call id; the client never constructs it.
class StreamCallJoinTicket {
  const StreamCallJoinTicket({
    required this.callId,
    required this.userId,
    required this.token,
    this.apiKey = '',
    this.callType = 'default',
    this.expiresAtMs,
  });

  final String callId;
  final String userId;
  final String token;
  final String apiKey;
  final String callType;
  final int? expiresAtMs;

  Map<String, Object> toBridgePayload({required String deviceId}) => {
        'call_id': callId,
        'user_id': userId,
        'token': token,
        'api_key': apiKey,
        'call_type': callType,
        'device_id': deviceId,
        if (expiresAtMs != null) 'expires_at_ms': expiresAtMs!,
      };
}

/// Account-level credentials used to keep Stream's signalling client warm
/// before a call arrives. These are short-lived user credentials minted by
/// AvaTOK's Worker; the Stream API secret never enters the app.
class StreamClientCredentials {
  const StreamClientCredentials({
    required this.userId,
    required this.token,
    required this.apiKey,
    this.expiresAtMs,
  });

  final String userId;
  final String token;
  final String apiKey;
  final int? expiresAtMs;

  factory StreamClientCredentials.fromTicket(StreamCallJoinTicket ticket) =>
      StreamClientCredentials(
        userId: ticket.userId,
        token: ticket.token,
        apiKey: ticket.apiKey,
        expiresAtMs: ticket.expiresAtMs,
      );
}

/// Account-scoped storage for a Stream token received while ringing in a
/// background isolate. A device may have several AvaTOK accounts, so the
/// account id is an explicit key component instead of relying on the active
/// `AccountScope`, which may be unset or point at another account in that
/// isolate.
class StreamCallTokenStore {
  StreamCallTokenStore._();

  static const FlutterSecureStorage _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static String _key(String callId, String accountId) =>
      'stream_call_token_v1_${_safePart(callId)}_${_safePart(accountId)}';

  static String _safePart(String value) => value.replaceAll(
        RegExp(r'[^A-Za-z0-9_.:-]'),
        '_',
      );

  static Future<void> write(
    String callId,
    String token, {
    required String accountId,
    int? expiresAtMs,
  }) async {
    if (callId.isEmpty || token.isEmpty || accountId.isEmpty) return;
    final value = expiresAtMs == null ? token : '$expiresAtMs\n$token';
    try {
      await _storage.write(key: _key(callId, accountId), value: value);
    } catch (e, st) {
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_provider',
        handled: true,
        extra: {'op': 'token_write', 'call_id': callId},
      );
    }
  }

  static Future<String?> read(String callId,
      {required String accountId}) async {
    if (callId.isEmpty || accountId.isEmpty) return null;
    try {
      final value = await _storage.read(key: _key(callId, accountId));
      if (value == null || value.isEmpty) return null;
      final lines = value.split('\n');
      if (lines.length > 1) {
        final expires = int.tryParse(lines.first);
        if (expires != null &&
            DateTime.now().millisecondsSinceEpoch >= expires) {
          await remove(callId, accountId: accountId);
          return null;
        }
        return lines.skip(1).join('\n');
      }
      return value;
    } catch (e, st) {
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_provider',
        handled: true,
        extra: {'op': 'token_read', 'call_id': callId},
      );
      return null;
    }
  }

  static Future<void> remove(
    String callId, {
    required String accountId,
  }) async {
    if (callId.isEmpty || accountId.isEmpty) return;
    try {
      await _storage.delete(key: _key(callId, accountId));
    } catch (_) {
      // Token cleanup is best effort; it is never allowed to break hangup.
    }
  }
}

/// Stable device identity shared with the existing FCM/device registration
/// code. It is deliberately global: device identity is not user content. The
/// Stream token above remains account-scoped.
class StreamDeviceIdentity {
  StreamDeviceIdentity._();

  static const String _key = 'ava_device_id';
  static const Uuid _uuid = Uuid();
  static String? _cached;

  static Future<String> get() async {
    final cached = _cached;
    if (cached != null && cached.isNotEmpty) return cached;
    var value = await DiskCache.readGlobal(_key);
    if (value == null || value.isEmpty) {
      value = _uuid.v4();
      await DiskCache.writeGlobal(_key, value);
    }
    _cached = value;
    return value;
  }
}

/// Ring owner is decided before a call is displayed. This helper exists so
/// FCM/WS code can use the same rule: Stream-owned rings must not also call the
/// legacy `flutter_callkit_incoming` path, and legacy rings must never be
/// displayed by Stream. The current build only returns Stream when both the
/// remote kill switch and the compile-time pilot gate are on.
enum CallRingOwner {
  avatok,
  stream,
}

class StreamCallPilot {
  StreamCallPilot._();

  static const bool _compiledIn = bool.fromEnvironment(
    'STREAM_CALL_PILOT_COMPILED',
    defaultValue: false,
  );

  /// Safe-by-default gate. A staging build must opt in at compile time AND
  /// receive the remote flag; production or a stale config remains legacy.
  static bool get enabled => _compiledIn && RemoteConfig.streamCallPilotEnabled;

  static CallRingOwner ringOwner(Map<String, dynamic> payload) {
    final requested = CallMediaProviderWire.fromWire(
      (payload['provider'] ?? payload['call_provider'] ?? '').toString(),
    );
    if (requested == CallMediaProvider.stream && enabled) {
      return CallRingOwner.stream;
    }
    return CallRingOwner.avatok;
  }

  /// Whether the server explicitly selected Stream for this ring. This is
  /// intentionally separate from [ringOwner]: an unsupported/flag-disabled
  /// client must reject an authoritative Stream ring, not reinterpret it as a
  /// Cloudflare ring and risk showing the wrong provider UI twice.
  static bool isExplicitStreamPayload(Map<String, dynamic> payload) =>
      CallMediaProviderWire.fromWire(
        (payload['provider'] ?? payload['call_provider'] ?? '').toString(),
      ) ==
      CallMediaProvider.stream;

  static bool legacyRingShouldHandle(Map<String, dynamic> payload) =>
      ringOwner(payload) == CallRingOwner.avatok;

  static bool streamRingShouldHandle(Map<String, dynamic> payload) =>
      ringOwner(payload) == CallRingOwner.stream;

  static void record(String event, String callId, {String? outcome}) {
    unawaited(Analytics.capture(event, {
      'call_id': callId,
      'provider': 'stream',
      'pilot_compiled': _compiledIn,
      'pilot_enabled': enabled,
      if (outcome != null) 'outcome': outcome,
    }));
  }
}

/// Native/plugin boundary for the isolated Stream SDK experiment.
///
/// A future staging-only plugin implements the two channels without changing
/// the Dart call screens. The main app currently has no handler, so calls fail
/// closed with `native_bridge_missing` and the caller can select legacy before
/// ringing. No Stream dependency is added to the current application graph.
class StreamCallClient {
  StreamCallClient({MethodChannel? methods, EventChannel? events})
      : _methods = methods ?? const MethodChannel('avatok/stream_call'),
        _events = events ?? const EventChannel('avatok/stream_call/events');

  final MethodChannel _methods;
  final EventChannel _events;
  StreamSubscription<Object?>? _nativeEvents;
  final StreamController<_StreamNativeEvent> _eventBus =
      StreamController<_StreamNativeEvent>.broadcast();
  bool _initialised = false;
  String? _activeUserId;
  String? _activeToken;

  /// One native Stream client per signed-in AvaTOK account. Per-call client
  /// creation throws away the warm socket and adds seconds to Answer → audio.
  static final StreamCallClient shared = StreamCallClient();

  Stream<_StreamNativeEvent> get events => _eventBus.stream;

  Future<void> initialize(
      {required StreamClientCredentials credentials}) async {
    if (_initialised &&
        _activeUserId == credentials.userId &&
        _activeToken == credentials.token) {
      return;
    }
    if (_initialised && _activeUserId != credentials.userId) {
      await disconnect(reason: 'account_changed');
    }
    final startedAtMs = DateTime.now().millisecondsSinceEpoch;
    unawaited(Analytics.capture('stream_client_initialize_started', {
      'provider': 'stream',
    }));
    final deviceId = await StreamDeviceIdentity.get();
    try {
      await _methods.invokeMethod<void>(
          _initialised ? 'refresh_credentials' : 'initialize', {
        'user_id': credentials.userId,
        'token': credentials.token,
        'api_key': credentials.apiKey,
        if (credentials.expiresAtMs != null)
          'expires_at_ms': credentials.expiresAtMs!,
        'device_id': deviceId,
        // Official Stream conversational-voice profile. The native bridge
        // must keep WebRTC/Opus adaptation in charge; no Dart-side compression.
        'audio_profile': 'voice_standard',
        'echo_cancellation': true,
        'noise_suppression': true,
        'auto_gain_control': true,
        'call_stats_reporting_interval_ms': 2000,
      });
    } on MissingPluginException {
      throw StreamCallUnavailable('native_bridge_missing');
    } on PlatformException catch (e) {
      throw StreamCallUnavailable(
          e.code.isEmpty ? 'initialize_failed' : e.code);
    }
    _initialised = true;
    _activeUserId = credentials.userId;
    _activeToken = credentials.token;
    unawaited(Analytics.capture('stream_client_ready', {
      'provider': 'stream',
      'latency_ms': DateTime.now().millisecondsSinceEpoch - startedAtMs,
    }));
    _nativeEvents ??= _events.receiveBroadcastStream().listen((raw) {
      if (raw is! Map) return;
      final map = Map<Object?, Object?>.from(raw);
      final callId = (map['call_id'] ?? '').toString();
      if (callId.isEmpty) return;
      final nativeEvent = _StreamNativeEvent.fromMap(callId, map);
      // This listener exists before a per-call session does, so it preserves
      // killed-app FCM/Accept timings replayed by the native bridge. Keep the
      // fields intentionally narrow: no token, payload, SDP, ICE address, or
      // caller identity is ever forwarded.
      unawaited(Analytics.capture('stream_call_native_lifecycle', {
        'call_id': callId,
        'provider': 'stream',
        'native_event': nativeEvent.name,
        for (final key in const <String>{
          'accept_ms',
          'join_ms',
          'handled',
          'push_type',
          'process_path',
          'reason',
          'cold_native_path',
          'resumed_from_native_accept',
          'sdk_version',
        })
          if (map[key] is String || map[key] is num || map[key] is bool)
            key: map[key] as Object,
      }));
      _eventBus.add(nativeEvent);
    });
  }

  Future<void> showIncoming(StreamCallJoinTicket ticket) async {
    await initialize(credentials: StreamClientCredentials.fromTicket(ticket));
    await _invoke(
        'show_incoming',
        ticket.toBridgePayload(
          deviceId: await StreamDeviceIdentity.get(),
        ));
  }

  /// Recover the already-encrypted native credentials after a killed-app
  /// Accept. This is a local method-channel read, not a network request, so the
  /// unchanged Flutter call screen can attach to media that native already
  /// joined without waiting for Clerk/token refresh.
  Future<StreamCallJoinTicket?> recoverTicket(String callId) async {
    try {
      final raw = await _methods.invokeMapMethod<Object?, Object?>(
        'current_credentials',
        {'call_id': callId},
      );
      if (raw == null) return null;
      final userId = (raw['user_id'] ?? '').toString();
      final token = (raw['token'] ?? '').toString();
      final apiKey = (raw['api_key'] ?? '').toString();
      if (userId.isEmpty || token.isEmpty || apiKey.isEmpty) return null;
      return StreamCallJoinTicket(
        callId: callId,
        userId: userId,
        token: token,
        apiKey: apiKey,
        callType: (raw['call_type'] ?? 'default').toString(),
        expiresAtMs: (raw['expires_at_ms'] as num?)?.toInt(),
      );
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  Future<StreamCallSession> join(
    StreamCallJoinTicket ticket, {
    required RtcMode mode,
    required bool outgoing,
  }) async {
    await initialize(credentials: StreamClientCredentials.fromTicket(ticket));
    // Subscribe before native starts. A fast peer can publish audio during the
    // method call; constructing the Dart session afterwards would lose that
    // non-replayed EventChannel milestone and falsely show a silent call.
    final session =
        StreamCallSession._(this, ticket.callId, ticket.userId, mode);
    try {
      await _invoke('join', {
        ...ticket.toBridgePayload(deviceId: await StreamDeviceIdentity.get()),
        'mode': mode.wireValue,
        'video': mode == RtcMode.video,
        'role': outgoing ? 'caller' : 'callee',
        'accept_before_join': !outgoing,
        'wait_for_accept': outgoing,
      });
      return session;
    } catch (_) {
      await session.disposeWithoutLeave();
      rethrow;
    }
  }

  Future<void> command(String name, String callId,
      [Map<String, Object>? args]) {
    return _invoke(name, {
      'call_id': callId,
      ...?args,
    });
  }

  Future<void> _invoke(String method, Map<String, Object?> arguments) async {
    final startedAtMs = DateTime.now().millisecondsSinceEpoch;
    final callId = (arguments['call_id'] ?? '').toString();
    unawaited(Analytics.capture('stream_bridge_command_started', {
      if (callId.isNotEmpty) 'call_id': callId,
      'provider': 'stream',
      'command': method,
    }));
    try {
      await _methods.invokeMethod<void>(method, arguments);
      unawaited(Analytics.capture('stream_bridge_command_completed', {
        if (callId.isNotEmpty) 'call_id': callId,
        'provider': 'stream',
        'command': method,
        'latency_ms': DateTime.now().millisecondsSinceEpoch - startedAtMs,
      }));
    } on MissingPluginException {
      unawaited(Analytics.capture('stream_bridge_command_failed', {
        if (callId.isNotEmpty) 'call_id': callId,
        'provider': 'stream',
        'command': method,
        'reason': 'native_bridge_missing',
        'latency_ms': DateTime.now().millisecondsSinceEpoch - startedAtMs,
      }));
      throw StreamCallUnavailable('native_bridge_missing');
    } on PlatformException catch (e) {
      unawaited(Analytics.capture('stream_bridge_command_failed', {
        if (callId.isNotEmpty) 'call_id': callId,
        'provider': 'stream',
        'command': method,
        'reason': e.code.isEmpty ? '${method}_failed' : e.code,
        'latency_ms': DateTime.now().millisecondsSinceEpoch - startedAtMs,
      }));
      throw StreamCallUnavailable(e.code.isEmpty ? '${method}_failed' : e.code);
    }
  }

  Future<void> disconnect({String reason = 'logout'}) async {
    if (!_initialised) return;
    try {
      await _methods.invokeMethod<void>('disconnect', {'reason': reason});
    } on MissingPluginException {
      // A non-pilot build has no native bridge and therefore nothing to stop.
    } on PlatformException catch (e) {
      unawaited(Analytics.capture('stream_client_disconnect_failed', {
        'provider': 'stream',
        'reason': e.code.isEmpty ? 'disconnect_failed' : e.code,
      }));
    } finally {
      _initialised = false;
      _activeUserId = null;
      _activeToken = null;
    }
  }

  Future<void> dispose() async {
    await _nativeEvents?.cancel();
    _nativeEvents = null;
    await _eventBus.close();
  }
}

class _StreamNativeEvent {
  const _StreamNativeEvent(this.callId, this.name, this.data);

  final String callId;
  final String name;
  final Map<Object?, Object?> data;

  factory _StreamNativeEvent.fromMap(
    String callId,
    Map<Object?, Object?> data,
  ) =>
      _StreamNativeEvent(callId, (data['event'] ?? '').toString(), data);
}

/// Provider-neutral Stream session backed by the isolated native bridge.
class StreamCallSession implements RtcSession {
  StreamCallSession._(this._client, this.callId, this._accountId, this._mode) {
    _nativeSub =
        _client.events.where((e) => e.callId == callId).listen(_onNative);
  }

  final StreamCallClient _client;
  final String _accountId;
  @override
  final String callId;
  RtcMode _mode;
  StreamSubscription<_StreamNativeEvent>? _nativeSub;
  final StreamController<RtcSessionEvent> _events =
      StreamController<RtcSessionEvent>.broadcast();
  final StreamController<RtcSessionEvent> _trackEvents =
      StreamController<RtcSessionEvent>.broadcast();
  RtcStatsSnapshot _stats = const RtcStatsSnapshot(
    publishState: RtcTransportState.connecting,
    subscribeState: RtcTransportState.connecting,
  );
  bool _left = false;

  @override
  RtcMode get mode => _mode;

  @override
  Stream<RtcSessionEvent> get events => _events.stream;

  @override
  Stream<RtcSessionEvent> get remoteTrackEvents => _trackEvents.stream;

  void _emit(RtcSessionEvent event) {
    if (!_events.isClosed) _events.add(event);
    if (event == RtcSessionEvent.audioTrackAdded ||
        event == RtcSessionEvent.firstAudioPlayout ||
        event == RtcSessionEvent.videoTrackAdded ||
        event == RtcSessionEvent.trackRemoved) {
      if (!_trackEvents.isClosed) _trackEvents.add(event);
    }
  }

  void _onNative(_StreamNativeEvent event) {
    final native = event.name;
    // The native bridge is the only layer that can see Stream's SDK lifecycle,
    // WebRTC stats and audio playout counters. Forward a strict allow-list to
    // PostHog; never forward the raw map because it may contain tokens, SDP,
    // candidate addresses, or provider payloads.
    const safeKeys = <String>{
      'role',
      'state',
      'previous_state',
      'reason',
      'network_type',
      'device_model',
      'android_sdk',
      'carrier',
      'audio_route',
      'audio_focus',
      'codec_audio',
      'sample_rate',
      'channels',
      'sfu',
      'sdk_version',
      'webrtc_version',
      'connection_id',
      'elapsed_from_answer_ms',
      'elapsed_from_join_ms',
      'join_ms',
      'accept_ms',
      'cold_native_path',
      'resumed_from_native_accept',
      'reconnect_ms',
      'reconnect_attempt',
      'rtt_ms',
      'jitter_ms',
      'packet_loss_pct',
      'concealment_pct',
      'jitter_buffer_ms',
      'inbound_audio_level',
      'outbound_mic_level',
      'inbound_kbps',
      'outbound_kbps',
      'available_bandwidth_kbps',
      'packets_received',
      'packets_sent',
      'packets_lost',
      'bytes_received',
      'bytes_sent',
      'total_samples_received',
      'jitter_buffer_emitted_count',
      'interruption_count',
      'total_interruption_ms',
      'battery_level',
      'thermal_state',
      'noise_cancellation_enabled',
      'opus_dtx',
      'opus_red',
      'mos',
      'first_playout_ms',
      'decoded_samples',
    };
    final safe = <String, Object>{};
    for (final entry in event.data.entries) {
      final key = entry.key?.toString() ?? '';
      final value = entry.value;
      if (safeKeys.contains(key) &&
          (value is String || value is num || value is bool)) {
        safe[key] = value as Object;
      }
    }
    unawaited(Analytics.capture('stream_call_native_event', {
      'call_id': callId,
      'provider': 'stream',
      'media_mode': _mode.wireValue,
      'native_event': native,
      ...safe,
    }));

    if (native == 'quality_sample') {
      int intValue(String key, [int fallback = -1]) =>
          (event.data[key] as num?)?.round() ?? fallback;
      double doubleValue(String key, [double fallback = -1]) =>
          (event.data[key] as num?)?.toDouble() ?? fallback;
      _stats = RtcStatsSnapshot(
        rttMs: intValue('rtt_ms'),
        jitterMs: intValue('jitter_ms'),
        packetLossPct: doubleValue('packet_loss_pct'),
        mos: doubleValue('mos'),
        audioBitrateKbps: intValue('outbound_kbps', 0),
        availableBitrateKbps: intValue('available_bandwidth_kbps', 0),
        audioLevel: doubleValue('outbound_mic_level'),
        publishState: _stats.publishState,
        subscribeState: _stats.subscribeState,
        iceState: _stats.iceState,
        candidateType: _stats.candidateType,
      );
    }
    final mapped = switch (native) {
      'connected' || 'reconnected' => RtcSessionEvent.connected,
      'reconnecting' => RtcSessionEvent.reconnecting,
      'disconnected' || 'left' => RtcSessionEvent.disconnected,
      'remote_join' => RtcSessionEvent.remoteJoin,
      'remote_leave' => RtcSessionEvent.remoteLeave,
      'audio_track_added' => RtcSessionEvent.audioTrackAdded,
      'first_audio_playout' => RtcSessionEvent.firstAudioPlayout,
      'rejected' => switch ((event.data['reason'] ?? '').toString()) {
          'cancel' || 'cancelled' => RtcSessionEvent.disconnected,
          _ => RtcSessionEvent.rejected,
        },
      'video_track_added' => RtcSessionEvent.videoTrackAdded,
      'track_removed' => RtcSessionEvent.trackRemoved,
      'degraded' => RtcSessionEvent.degraded,
      'quality_sample' ||
      'connection_quality_changed' =>
        RtcSessionEvent.qualityChanged,
      'mode_changed' => RtcSessionEvent.modeChanged,
      'error' => RtcSessionEvent.error,
      _ => null,
    };
    if (mapped == null) return;
    if (mapped == RtcSessionEvent.connected) {
      _stats = const RtcStatsSnapshot(
        publishState: RtcTransportState.connected,
        subscribeState: RtcTransportState.connected,
      );
    }
    if (mapped == RtcSessionEvent.disconnected) {
      _stats = const RtcStatsSnapshot(
        publishState: RtcTransportState.disconnected,
        subscribeState: RtcTransportState.disconnected,
      );
    }
    _emit(mapped);
  }

  @override
  Future<void> publishMic({required bool enabled}) =>
      _client.command('set_mic', callId, {'enabled': enabled});

  @override
  Future<void> publishCam({required bool enabled}) {
    if (enabled && _mode == RtcMode.audioLocked) {
      throw StateError('Stream session is audio-locked');
    }
    return _client.command('set_camera', callId, {'enabled': enabled});
  }

  @override
  Future<void> setMode(RtcMode mode) async {
    _mode = mode;
    if (mode != RtcMode.video) {
      await publishCam(enabled: false);
    }
    await _client.command('set_mode', callId, {'mode': mode.wireValue});
    _emit(RtcSessionEvent.modeChanged);
  }

  @override
  RtcStatsSnapshot stats() => _stats;

  @override
  Future<void> leave() async {
    if (_left) return;
    _left = true;
    try {
      await _client.command('leave', callId);
    } finally {
      await _nativeSub?.cancel();
      _nativeSub = null;
      _emit(RtcSessionEvent.disconnected);
      await _events.close();
      await _trackEvents.close();
      await StreamCallTokenStore.remove(callId, accountId: _accountId);
    }
  }

  Future<void> disposeWithoutLeave() async {
    if (_left) return;
    _left = true;
    await _nativeSub?.cancel();
    _nativeSub = null;
    await _events.close();
    await _trackEvents.close();
  }
}

/// Stream implementation of the provider-neutral RTC contract.
class StreamRtcProvider implements RtcProvider {
  StreamRtcProvider({StreamCallClient? client})
      : _client = client ?? StreamCallClient.shared;

  final StreamCallClient _client;

  @override
  String get name => 'stream';

  @override
  RtcCapabilities get capabilities => const RtcCapabilities(
        supportsSimulcast: false,
        supportsDynacast: false,
        supportsServerMute: false,
        supportsRecording: false,
        supportsScreenshare: false,
        maxParticipants: 2,
        maxPublishedTracks: 2,
        maxSubscriptions: 1,
      );

  /// A Stream ticket is kept separate from [RtcJoinTicket] because Stream's
  /// token has a different server contract and must never be confused with a
  /// Cloudflare room token.
  Future<RtcSession> joinStream(
    StreamCallJoinTicket ticket, {
    RtcMode mode = RtcMode.audio,
    required bool outgoing,
  }) async {
    if (!StreamCallPilot.enabled) {
      StreamCallPilot.record('stream_call_join_blocked', ticket.callId,
          outcome: 'flag_off');
      throw StreamCallUnavailable('pilot_disabled');
    }
    try {
      final session = await _client.join(
        ticket,
        mode: mode,
        outgoing: outgoing,
      );
      StreamCallPilot.record('stream_call_joined', ticket.callId,
          outcome: 'ok');
      return session;
    } catch (e, st) {
      StreamCallPilot.record('stream_call_join_failed', ticket.callId,
          outcome: e is StreamCallUnavailable ? e.reason : 'error');
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_provider',
        handled: true,
        extra: {'op': 'join', 'call_id': ticket.callId},
      );
      rethrow;
    }
  }

  @override
  Future<RtcSession> join(RtcJoinTicket ticket, {required RtcMode mode}) {
    if (ticket.provider != 'stream') {
      throw ArgumentError.value(ticket.provider, 'ticket.provider',
          'StreamRtcProvider requires provider=stream');
    }
    // [RtcJoinTicket] intentionally has no Stream user id/API-key fields: it
    // was designed for the existing SFU adapters. Refusing this conversion is
    // safer than guessing that `url` is an API key or that the token contains
    // the user id. Callers must use [joinStream] with the server's typed Stream
    // ticket until the neutral contract grows those optional fields.
    throw StreamCallUnavailable('stream_ticket_requires_typed_fields');
  }
}
