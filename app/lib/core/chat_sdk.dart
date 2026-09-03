import 'dart:convert';

import 'analytics.dart';
import 'api_auth.dart';
import 'config.dart';

/// Provider-neutral chat foundation for the AvaTOK messenger surfaces.
///
/// The actual Stream SDK/account wiring is intentionally optional here: when
/// Stream credentials, SDK packages, or server routes are unavailable, the app
/// can still compile, emit telemetry, and fail closed without leaking user data
/// or falling back to the deprecated live-room websocket lane.
enum ChatSdkState { unavailable, stubbed, ready }

class ChatSdkAuthToken {
  const ChatSdkAuthToken({
    required this.userId,
    required this.token,
    required this.expiresAtMs,
    this.apiKey = '',
    this.service = 'getstream',
  });

  final String userId;
  final String token;
  final int expiresAtMs;
  final String apiKey;
  final String service;

  bool get isExpired => DateTime.now().millisecondsSinceEpoch >= expiresAtMs;
}

class ChatSdkModerationResult {
  const ChatSdkModerationResult({
    required this.allowed,
    this.reason = '',
    this.categories = const <String>[],
    this.reviewId,
  });

  final bool allowed;
  final String reason;
  final List<String> categories;
  final String? reviewId;

  static const ok = ChatSdkModerationResult(allowed: true);
}

class ChatSdkActionReceipt {
  const ChatSdkActionReceipt({
    required this.ok,
    required this.action,
    this.detail = '',
    this.traceId,
  });

  final bool ok;
  final String action;
  final String detail;
  final String? traceId;
}

abstract interface class ChatSdkGateway {
  Future<ChatSdkAuthToken?> authorizeThread({
    required String threadId,
    required String peerId,
    required bool isGroup,
  });

  Future<ChatSdkModerationResult> moderateDraft({
    required String text,
    required String threadId,
    String? locale,
  });

  Future<ChatSdkActionReceipt> reportMessage({
    required String messageId,
    required String threadId,
    required String reason,
    String? traceId,
  });

  Future<ChatSdkActionReceipt> blockPeer({
    required String peerId,
    required String threadId,
    String? reason,
    String? traceId,
  });

  Future<ChatSdkActionReceipt> muteThread({
    required String threadId,
    required bool muted,
    String? traceId,
  });
}

/// Safe default gateway used when Stream is not configured yet. It emits
/// telemetry, keeps the app responsive, and returns explicit non-authoritative
/// results rather than guessing at SDK state.
class StubChatSdkGateway implements ChatSdkGateway {
  const StubChatSdkGateway();

  void _telemetry(String event, Map<String, dynamic> props) {
    Analytics.capture('chat_sdk_$event', {
      ...props,
      'provider': 'getstream',
      'sdk_state': ChatSdkState.stubbed.name,
    });
  }

  @override
  Future<ChatSdkAuthToken?> authorizeThread({
    required String threadId,
    required String peerId,
    required bool isGroup,
  }) async {
    _telemetry('authorize_stubbed', {
      'thread_id': threadId,
      'peer_id': peerId,
      'is_group': isGroup,
    });
    return null;
  }

  @override
  Future<ChatSdkModerationResult> moderateDraft({
    required String text,
    required String threadId,
    String? locale,
  }) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return ChatSdkModerationResult.ok;
    _telemetry('moderation_stubbed', {
      'thread_id': threadId,
      if (locale != null) 'locale': locale,
      'length': trimmed.length,
    });
    return ChatSdkModerationResult.ok;
  }

  @override
  Future<ChatSdkActionReceipt> reportMessage({
    required String messageId,
    required String threadId,
    required String reason,
    String? traceId,
  }) async {
    _telemetry('report_stubbed', {
      'message_id': messageId,
      'thread_id': threadId,
      'reason': reason,
      if (traceId != null) 'trace_id': traceId,
    });
    return ChatSdkActionReceipt(
        ok: false,
        action: 'report',
        detail: 'chat sdk unavailable',
        traceId: traceId);
  }

  @override
  Future<ChatSdkActionReceipt> blockPeer({
    required String peerId,
    required String threadId,
    String? reason,
    String? traceId,
  }) async {
    _telemetry('block_stubbed', {
      'peer_id': peerId,
      'thread_id': threadId,
      if (reason != null) 'reason': reason,
      if (traceId != null) 'trace_id': traceId,
    });
    return ChatSdkActionReceipt(
        ok: false,
        action: 'block',
        detail: 'chat sdk unavailable',
        traceId: traceId);
  }

  @override
  Future<ChatSdkActionReceipt> muteThread({
    required String threadId,
    required bool muted,
    String? traceId,
  }) async {
    _telemetry('mute_stubbed', {
      'thread_id': threadId,
      'muted': muted,
      if (traceId != null) 'trace_id': traceId,
    });
    return ChatSdkActionReceipt(
        ok: false,
        action: muted ? 'mute' : 'unmute',
        detail: 'chat sdk unavailable',
        traceId: traceId);
  }
}

class ChatSdkFoundation {
  ChatSdkFoundation._();

  static const ChatSdkGateway _gateway = StubChatSdkGateway();

  static ChatSdkGateway get gateway => _gateway;

  static Future<ChatSdkAuthToken?> authorizeThread({
    required String threadId,
    required String peerId,
    required bool isGroup,
  }) =>
      _gateway.authorizeThread(
          threadId: threadId, peerId: peerId, isGroup: isGroup);

  static Future<ChatSdkModerationResult> moderateDraft({
    required String text,
    required String threadId,
    String? locale,
  }) =>
      _gateway.moderateDraft(text: text, threadId: threadId, locale: locale);

  static Future<ChatSdkActionReceipt> reportMessage({
    required String messageId,
    required String threadId,
    required String reason,
    String? traceId,
  }) =>
      _gateway.reportMessage(
          messageId: messageId,
          threadId: threadId,
          reason: reason,
          traceId: traceId);

  static Future<ChatSdkActionReceipt> blockPeer({
    required String peerId,
    required String threadId,
    String? reason,
    String? traceId,
  }) =>
      _gateway.blockPeer(
          peerId: peerId, threadId: threadId, reason: reason, traceId: traceId);

  static Future<ChatSdkActionReceipt> muteThread({
    required String threadId,
    required bool muted,
    String? traceId,
  }) =>
      _gateway.muteThread(threadId: threadId, muted: muted, traceId: traceId);

  /// Optional server-seam helper for future Stream auth routes. If the route is
  /// not available yet, this returns null and records the miss instead of
  /// inventing a token.
  static Future<ChatSdkAuthToken?> fetchThreadAuth({
    required String threadId,
    required String peerId,
    required bool isGroup,
  }) async {
    try {
      final response = await ApiAuth.postJsonH(
        '$kApiBase/chat/auth',
        {
          'thread_id': threadId,
          'peer_id': peerId,
          'is_group': isGroup,
          'provider': 'getstream',
        },
        const <String, String>{},
      );
      if (response.statusCode >= 300) {
        Analytics.capture('chat_sdk_auth_unavailable', {
          'thread_id': threadId,
          'peer_id': peerId,
          'is_group': isGroup,
          'status': response.statusCode,
        });
        return null;
      }
      final decoded = jsonDecode(response.body);
      if (decoded is! Map) return null;
      final json = decoded.cast<String, dynamic>();
      final token = '${json['token'] ?? ''}'.trim();
      final userId = '${json['user_id'] ?? ''}'.trim();
      final expiresAtMs = (json['expires_at_ms'] as num?)?.toInt() ?? 0;
      if (token.isEmpty || userId.isEmpty || expiresAtMs <= 0) return null;
      return ChatSdkAuthToken(
        userId: userId,
        token: token,
        expiresAtMs: expiresAtMs,
        apiKey: '${json['api_key'] ?? ''}'.trim(),
        service: '${json['service'] ?? 'getstream'}'.trim(),
      );
    } catch (e) {
      Analytics.capture('chat_sdk_auth_error', {
        'thread_id': threadId,
        'peer_id': peerId,
        'is_group': isGroup,
        'error': e.runtimeType.toString(),
      });
      return null;
    }
  }
}
