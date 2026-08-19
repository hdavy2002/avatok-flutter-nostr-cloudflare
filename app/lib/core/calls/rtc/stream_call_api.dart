/// Server-side provider selection for the optional Stream 1:1 pilot.
///
/// This client never falls back by changing an already-ringing call. The
/// decision is made before the ring, cached for the call id, and the caller
/// can use the returned Cloudflare decision when Stream is disabled/unavailable.
library;

import 'dart:async';
import 'dart:convert';

import '../../analytics.dart';
import '../../api_auth.dart';
import '../../config.dart';
import 'stream_call_provider.dart';

class CallProviderDecision {
  const CallProviderDecision.cloudflare({this.reason = 'legacy'})
      : provider = CallMediaProvider.cloudflare,
        streamTicket = null;

  const CallProviderDecision.stream(this.streamTicket)
      : provider = CallMediaProvider.stream,
        reason = 'stream';

  final CallMediaProvider provider;
  final StreamCallJoinTicket? streamTicket;
  final String reason;

  bool get usesStream => provider == CallMediaProvider.stream;
}

class StreamCallApi {
  StreamCallApi._();

  static final Map<String, CallProviderDecision> _decisions =
      <String, CallProviderDecision>{};

  /// Warm Stream's signalling connection after login so an incoming ring does
  /// not pay authentication + websocket setup after the user presses Answer.
  static Future<void> warmForAccount(String accountId) async {
    if (accountId.isEmpty || !StreamCallPilot.enabled) return;
    final startedAtMs = DateTime.now().millisecondsSinceEpoch;
    try {
      final response = await ApiAuth.getSigned(
        '$kApiBase/stream-video/token',
        timeout: const Duration(seconds: 8),
      );
      if (response.statusCode != 200) {
        Analytics.capture('stream_client_warm_failed', {
          'provider': 'stream',
          'status': response.statusCode,
          'reason': 'token_request_failed',
        });
        return;
      }
      final raw = jsonDecode(response.body);
      if (raw is! Map) throw const FormatException('invalid Stream token body');
      final body = Map<String, dynamic>.from(raw);
      final credentials = StreamClientCredentials(
        userId: (body['user_id'] ?? '').toString(),
        token: (body['token'] ?? '').toString(),
        apiKey: (body['api_key'] ?? '').toString(),
        expiresAtMs: _expiresAtMs(body['expires_at']),
      );
      if (credentials.userId != accountId ||
          credentials.token.isEmpty ||
          credentials.apiKey.isEmpty) {
        throw const FormatException('incomplete Stream credentials');
      }
      await StreamCallClient.shared.initialize(credentials: credentials);
      Analytics.capture('stream_client_warm_completed', {
        'provider': 'stream',
        'latency_ms': DateTime.now().millisecondsSinceEpoch - startedAtMs,
      });
    } catch (e, st) {
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_api',
        handled: true,
        extra: {'op': 'warm_client'},
      );
    }
  }

  static Future<void> disconnect({String reason = 'account_switch'}) =>
      StreamCallClient.shared.disconnect(reason: reason);

  /// Future-only preparation seam. Do not call this from the normal dial path
  /// until `/api/call` owns provider selection and sticky admission; making a
  /// second request here could ring Cloudflare and then attempt to switch to
  /// Stream. The current app parses provider fields from `/api/call` instead.
  ///
  /// A network/5xx/flag failure returns Cloudflare. This is intentionally
  /// fail-open to the existing path, but once Stream returns a successful
  /// decision it is sticky for [callId] and is never silently changed midway.
  @Deprecated('Wait for /api/call provider selection before wiring this seam')
  static Future<CallProviderDecision> selectOutgoing({
    required String callId,
    required String calleeUid,
    required bool video,
  }) async {
    final prior = _decisions[callId];
    if (prior != null) return prior;
    if (callId.isEmpty ||
        calleeUid.isEmpty ||
        video ||
        !StreamCallPilot.enabled) {
      return _remember(
          callId,
          const CallProviderDecision.cloudflare(
              reason: 'pilot_off_or_unsupported'));
    }

    try {
      final response = await ApiAuth.postJsonH(
        '$kApiBase/stream-video/prepare',
        {'callee_uid': calleeUid, 'video': false},
        {'idempotency-key': 'stream-$callId'},
      );
      if (response.statusCode != 200) {
        final reason = response.statusCode >= 500
            ? 'stream_provider_unavailable'
            : 'stream_not_selected';
        Analytics.capture('stream_provider_fallback', {
          'call_id': callId,
          'status': response.statusCode,
          'reason': reason,
        });
        return _remember(
            callId, CallProviderDecision.cloudflare(reason: reason));
      }
      final body = jsonDecode(response.body);
      if (body is! Map) {
        return _remember(
            callId,
            const CallProviderDecision.cloudflare(
                reason: 'bad_stream_response'));
      }
      final json = Map<String, dynamic>.from(body);
      final returnedCallId = (json['call_id'] ?? callId).toString();
      final ticket = StreamCallJoinTicket(
        callId: returnedCallId,
        userId: (json['user_id'] ?? '').toString(),
        token: (json['token'] ?? '').toString(),
        apiKey: (json['api_key'] ?? '').toString(),
        callType: (json['call_type'] ?? 'default').toString(),
        expiresAtMs: _expiresAtMs(json['token_expires_at']),
      );
      if (ticket.userId.isEmpty ||
          ticket.token.isEmpty ||
          ticket.apiKey.isEmpty) {
        return _remember(
            callId,
            const CallProviderDecision.cloudflare(
                reason: 'incomplete_stream_ticket'));
      }
      await StreamCallTokenStore.write(
        returnedCallId,
        ticket.token,
        accountId: ticket.userId,
        expiresAtMs: ticket.expiresAtMs,
      );
      return _remember(callId, CallProviderDecision.stream(ticket));
    } catch (e, st) {
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_api',
        handled: true,
        extra: {'op': 'select_outgoing', 'call_id': callId},
      );
      return _remember(
          callId,
          const CallProviderDecision.cloudflare(
              reason: 'stream_request_failed'));
    }
  }

  /// Read the provider carried by a server ring. Missing/unknown values are
  /// legacy Cloudflare rings, preserving compatibility with older servers.
  static CallProviderDecision fromIncomingPayload(
    Map<String, dynamic> payload,
  ) {
    final callId = (payload['callId'] ?? payload['call_id'] ?? '').toString();
    final provider = CallMediaProviderWire.fromWire(
      (payload['provider'] ?? payload['call_provider'] ?? '').toString(),
    );
    if (provider != CallMediaProvider.stream || !StreamCallPilot.enabled) {
      return _remember(
          callId,
          const CallProviderDecision.cloudflare(
              reason: 'legacy_ring_or_pilot_off'));
    }
    final token =
        (payload['token'] ?? payload['stream_token'] ?? '').toString();
    final userId =
        (payload['user_id'] ?? payload['stream_user_id'] ?? '').toString();
    final apiKey =
        (payload['api_key'] ?? payload['stream_api_key'] ?? '').toString();
    if (token.isEmpty || userId.isEmpty || apiKey.isEmpty) {
      return _remember(
          callId,
          const CallProviderDecision.cloudflare(
              reason: 'incomplete_stream_ring'));
    }
    final ticket = StreamCallJoinTicket(
      callId: callId,
      userId: userId,
      token: token,
      apiKey: apiKey,
      callType: (payload['call_type'] ?? 'default').toString(),
      expiresAtMs: _expiresAtMs(payload['token_expires_at']),
    );
    // The ring handler should call this before handing control to the native
    // Stream push/CallKit bridge. The awaited store protects a killed-app ring.
    // This method itself stays synchronous so it can be used for ring ownership
    // checks without accidentally delaying the decision.
    unawaited(StreamCallTokenStore.write(
      callId,
      token,
      accountId: ticket.userId,
      expiresAtMs: ticket.expiresAtMs,
    ));
    return _remember(callId, CallProviderDecision.stream(ticket));
  }

  /// Main-isolate recovery for a Stream notification accepted while Flutter
  /// was dead. Native media may already be joined; retrieve its encrypted
  /// credentials locally so the existing CallScreen attaches to that same
  /// provider instead of accidentally constructing a Cloudflare session.
  static Future<CallProviderDecision> resolveIncoming(
    Map<String, dynamic> payload,
  ) async {
    final callId = (payload['callId'] ?? payload['call_id'] ?? '').toString();
    final existing = _decisions[callId];
    if (existing?.usesStream == true) return existing!;
    final explicitStream = CallMediaProviderWire.fromWire(
          (payload['provider'] ?? payload['call_provider'] ?? '').toString(),
        ) ==
        CallMediaProvider.stream;
    if (!explicitStream || !StreamCallPilot.enabled) {
      return fromIncomingPayload(payload);
    }
    final hasInlineCredentials =
        (payload['token'] ?? payload['stream_token'] ?? '').toString().isNotEmpty &&
            (payload['user_id'] ?? payload['stream_user_id'] ?? '').toString().isNotEmpty &&
            (payload['api_key'] ?? payload['stream_api_key'] ?? '').toString().isNotEmpty;
    if (hasInlineCredentials) return fromIncomingPayload(payload);
    final recovered = await StreamCallClient.shared.recoverTicket(callId);
    if (recovered != null) {
      final decision = CallProviderDecision.stream(recovered);
      _decisions[callId] = decision;
      Analytics.capture('stream_ticket_recovered_native', {
        'call_id': callId,
        'provider': 'stream',
      });
      return decision;
    }
    return fromIncomingPayload(payload);
  }

  /// Parse the provider fields from an outgoing placement response. Older
  /// `/api/call` responses omit them and therefore intentionally resolve to
  /// Cloudflare. The response is parsed before [CallSession.notePlaceResult]
  /// so an optimistic screen cannot boot the wrong transport.
  static CallProviderDecision fromPlacementResponse(
    String callId,
    String body,
  ) {
    try {
      final raw = jsonDecode(body);
      if (raw is! Map) {
        return _remember(callId,
            const CallProviderDecision.cloudflare(reason: 'legacy_response'));
      }
      final payload = Map<String, dynamic>.from(raw);
      payload['callId'] ??= callId;
      return fromIncomingPayload(payload);
    } catch (_) {
      return _remember(callId,
          const CallProviderDecision.cloudflare(reason: 'legacy_response'));
    }
  }

  static CallProviderDecision _remember(
    String callId,
    CallProviderDecision decision,
  ) {
    if (callId.isEmpty) return decision;
    return _decisions.putIfAbsent(callId, () => decision);
  }

  static int? _expiresAtMs(Object? value) {
    final seconds = value is num ? value.toInt() : int.tryParse('$value');
    if (seconds == null || seconds <= 0) return null;
    // Worker returns Unix seconds; tolerate an already-millisecond timestamp.
    return seconds < 100000000000 ? seconds * 1000 : seconds;
  }

  /// Test/lifecycle cleanup. The call's token is independently expired by its
  /// timestamp; clearing this map cannot change a live call's provider.
  static void forget(String callId) => _decisions.remove(callId);
}
