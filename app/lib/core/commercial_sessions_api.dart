import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// Read-only customer projection for Phase 2C My Sessions.
///
/// The server is authoritative for entitlement, booking, order, provider
/// state, receipt state and the join window. This client never creates a
/// session or treats a listing price as proof of purchase.
class CommercialSessionRecord {
  final String entitlementId, kind, listingId, title;
  final String? bookingId, orderId, sessionId, receiptId;
  final String? role, counterpartyName;
  final List<String> allowedActions;
  final String? listingStatus, action;
  final String? chatChannelId, chatChannelType;
  final List<String> chatPermissions;
  final String entitlementState, bookingStatus, orderStatus;
  final String? sessionState,
      settlementState,
      receiptSettlementState,
      refundSettlementState,
      currency;
  final int price,
      startsAt,
      endsAt,
      opensAt,
      closesAt,
      serverNowAtFetch,
      fetchedAtLocal;

  const CommercialSessionRecord({
    required this.entitlementId,
    required this.kind,
    required this.listingId,
    required this.title,
    required this.entitlementState,
    required this.bookingStatus,
    required this.orderStatus,
    required this.price,
    required this.startsAt,
    required this.endsAt,
    required this.opensAt,
    required this.closesAt,
    required this.serverNowAtFetch,
    required this.fetchedAtLocal,
    this.bookingId,
    this.orderId,
    this.sessionId,
    this.receiptId,
    this.role,
    this.counterpartyName,
    this.allowedActions = const [],
    this.listingStatus,
    this.action,
    this.sessionState,
    this.settlementState,
    this.receiptSettlementState,
    this.refundSettlementState,
    this.currency,
    this.chatChannelId,
    this.chatChannelType,
    this.chatPermissions = const [],
  });

  static int _int(dynamic value) =>
      value is num ? value.toInt() : int.tryParse('$value') ?? 0;

  factory CommercialSessionRecord.fromJson(
    Map<String, dynamic> json, {
    required int serverNow,
    int? fetchedAt,
  }) {
    final localNow = fetchedAt ?? DateTime.now().millisecondsSinceEpoch;
    return CommercialSessionRecord(
      entitlementId: (json['entitlement_id'] ?? '').toString(),
      kind: (json['kind'] ?? '').toString(),
      listingId: (json['listing_id'] ?? '').toString(),
      title: (json['title'] ?? 'Session').toString(),
      bookingId: json['booking_id']?.toString(),
      orderId: json['order_id']?.toString(),
      sessionId:
          (json['commercial_session_id'] ?? json['session_id'])?.toString(),
      receiptId: json['receipt_id']?.toString(),
      role: (json['role'] ?? json['viewer_role'])?.toString(),
      counterpartyName: (json['counterparty_name'] ??
              json['customer_name'] ??
              json['buyer_name'] ??
              json['creator_name'])
          ?.toString(),
      allowedActions: ((json['allowed_actions'] ?? json['actions']) as List?)
              ?.map((e) => e.toString())
              .toList() ??
          const [],
      listingStatus: json['listing_status']?.toString(),
      action: json['action']?.toString(),
      entitlementState: (json['entitlement_state'] ?? '').toString(),
      bookingStatus: (json['booking_status'] ?? '').toString(),
      orderStatus: (json['order_status'] ?? '').toString(),
      sessionState: json['session_state']?.toString(),
      settlementState: json['session_settlement_state']?.toString(),
      receiptSettlementState: json['receipt_settlement_state']?.toString(),
      refundSettlementState: json['refund_settlement_state']?.toString(),
      currency: json['currency_display']?.toString(),
      chatChannelId: (json['chat'] is Map)
          ? (json['chat']['channel_id']?.toString())
          : json['chat_channel_id']?.toString(),
      chatChannelType: (json['chat'] is Map)
          ? (json['chat']['channel_type']?.toString())
          : json['chat_channel_type']?.toString(),
      chatPermissions:
          (json['chat'] is Map && json['chat']['permissions'] is List)
              ? (json['chat']['permissions'] as List)
                  .map((e) => e.toString())
                  .toList()
              : const [],
      price: _int(json['price']),
      startsAt: _int(json['starts_at']),
      endsAt: _int(json['ends_at']),
      opensAt: _int(json['opens_at']),
      closesAt: _int(json['closes_at']),
      serverNowAtFetch: serverNow,
      fetchedAtLocal: localNow,
    );
  }

  /// Current server-time estimate anchored to the last response.
  int get estimatedServerNow =>
      serverNowAtFetch +
      (DateTime.now().millisecondsSinceEpoch - fetchedAtLocal);

  bool get isLiveEvent => kind == 'live_event';
  bool get isConsultation => kind == 'consult_1to1' || kind == 'consult';
  bool get isRefunded =>
      entitlementState == 'refunded' ||
      orderStatus == 'refunded' ||
      receiptSettlementState == 'refunded' ||
      receiptSettlementState == 'partial_refund' ||
      refundSettlementState == 'refunded' ||
      refundSettlementState == 'partial_refund';
  bool get isCancelled =>
      entitlementState == 'revoked' ||
      orderStatus == 'cancelled' ||
      orderStatus == 'canceled' ||
      bookingStatus == 'cancelled' ||
      bookingStatus == 'canceled' ||
      bookingStatus == 'cancelled_user' ||
      bookingStatus == 'cancelled_creator' ||
      bookingStatus == 'no_show_user' ||
      bookingStatus == 'no_show_creator' ||
      bookingStatus == 'refunded' ||
      sessionState == 'cancelled' ||
      sessionState == 'canceled' ||
      listingStatus == 'cancelled' ||
      listingStatus == 'canceled';
  bool get isCompleted =>
      !isRefunded && !isCancelled &&
      (bookingStatus == 'completed' ||
          sessionState == 'ended' ||
          listingStatus == 'completed' ||
          ((closesAt > 0 ? closesAt : endsAt) > 0 &&
              estimatedServerNow > (closesAt > 0 ? closesAt : endsAt)));
  bool get isLiveNow =>
      !isRefunded &&
      !isCancelled &&
      !isCompleted &&
      (sessionState == 'live' ||
          sessionState == 'backstage' ||
          listingStatus == 'live');
  bool get isJoinWindowOpen =>
      !isRefunded &&
      !isCancelled &&
      !isCompleted &&
      opensAt > 0 &&
      closesAt > 0 &&
      estimatedServerNow >= opensAt &&
      estimatedServerNow <= closesAt;

  bool get hasCommercialChat =>
      (chatChannelId ?? '').isNotEmpty && (chatChannelType ?? '').isNotEmpty;

  String get joinLabel {
    if (isRefunded) return 'Refunded';
    if (isCancelled) return 'Cancelled';
    if (isCompleted) return 'Completed';
    if (isJoinWindowOpen) return 'Join';
    if (opensAt > estimatedServerNow)
      return 'Opens in ${_duration(opensAt - estimatedServerNow)}';
    return 'Join window closed';
  }

  static String _duration(int milliseconds) {
    final minutes = (milliseconds / 60000).ceil();
    if (minutes < 60) return '${minutes}m';
    final hours = minutes ~/ 60;
    final rest = minutes % 60;
    return rest == 0 ? '${hours}h' : '${hours}h ${rest}m';
  }

  CommercialSessionBucket get bucket {
    if (isRefunded || isCancelled) return CommercialSessionBucket.cancelledRefunded;
    if (isCompleted) return CommercialSessionBucket.completed;
    if (isLiveNow) return CommercialSessionBucket.liveNow;
    return CommercialSessionBucket.upcoming;
  }
}

enum CommercialSessionBucket { upcoming, liveNow, completed, cancelledRefunded }

class CommercialSessionsResponse {
  final int serverNow;
  final List<CommercialSessionRecord> sessions;
  final String? nextCursor;
  final bool hasMore;

  const CommercialSessionsResponse(
      {required this.serverNow,
      required this.sessions,
      this.nextCursor,
      this.hasMore = false});

  factory CommercialSessionsResponse.fromJson(Map<String, dynamic> json) {
    final serverNow = CommercialSessionRecord._int(json['server_now']);
    if (serverNow <= 0) {
      return const CommercialSessionsResponse(serverNow: 0, sessions: []);
    }
    final fetchedAt = DateTime.now().millisecondsSinceEpoch;
    final rows = ((json['sessions'] as List?) ?? const [])
        .whereType<Map>()
        .map((row) => CommercialSessionRecord.fromJson(
              row.cast<String, dynamic>(),
              serverNow: serverNow,
              fetchedAt: fetchedAt,
            ))
        // Creator events may not have a host entitlement before admission.
        .where((row) => row.listingId.isNotEmpty)
        .toList();
    final next = (json['next_cursor'] ?? json['nextCursor'])?.toString();
    return CommercialSessionsResponse(
      serverNow: serverNow,
      sessions: rows,
      nextCursor: next?.isEmpty == true ? null : next,
      hasMore: next?.isNotEmpty == true || json['has_more'] == true,
    );
  }
}

class CommercialSessionsApi {
  static const _url = 'https://$kSignalingHost/api/commercial/sessions/mine';

  static Future<CommercialSessionsResponse?> mine({
    String role = 'customer',
    String view = 'all',
    String? cursor,
    int limit = 50,
  }) async {
    try {
      final uri = Uri.parse(_url).replace(queryParameters: {
        'role': role,
        'view': view,
        // Current workers call this filter (status is an accepted alias).
        'filter': view,
        'limit': '$limit',
        if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
      });
      final response = await ApiAuth.getSigned(uri.toString());
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(response.body);
      if (decoded is! Map) return null;
      return CommercialSessionsResponse.fromJson(
          decoded.cast<String, dynamic>());
    } catch (_) {
      return null;
    }
  }

  /// Drains the cursor so schedule screens never silently truncate sessions.
  static Future<CommercialSessionsResponse?> mineAll({
    String role = 'customer',
    String view = 'all',
    int limit = 50,
  }) async {
    final requestUid = ApiAuth.identity?.uid;
    final all = <CommercialSessionRecord>[];
    String? cursor;
    int? serverNow;
    final seenCursors = <String>{};
    while (true) {
      final response = await mine(
          role: role, view: view, cursor: cursor, limit: limit);
      if (requestUid != ApiAuth.identity?.uid || response == null) return null;
      serverNow = response.serverNow;
      all.addAll(response.sessions);
      final next = response.nextCursor;
      if (!response.hasMore || next == null || next.isEmpty || next == cursor) {
        break;
      }
      if (!seenCursors.add(next)) return null;
      cursor = next;
    }
    final deduped = <String, CommercialSessionRecord>{};
    for (final session in all) {
      final key = session.bookingId?.isNotEmpty == true
          ? 'booking:${session.bookingId}'
          : session.sessionId?.isNotEmpty == true
              ? 'session:${session.sessionId}'
              : 'listing:${session.listingId}:${session.startsAt}:${session.kind}';
      deduped[key] = session;
    }
    return CommercialSessionsResponse(
        serverNow: serverNow, sessions: deduped.values.toList());
  }

  static Future<String> resendConfirmation(String orderId) async {
    final response = await ApiAuth.postJson(
      'https://$kSignalingHost/api/commercial/orders/${Uri.encodeComponent(orderId)}/resend-confirmation',
      const {},
    );
    if (response.statusCode == 429) return 'rate_limited';
    if (response.statusCode != 200) return 'unavailable';
    final body = jsonDecode(response.body);
    return body is Map ? (body['email_status'] ?? 'unavailable').toString() : 'unavailable';
  }

  /// Server-authorized live admission. The returned handoff is consumed by
  /// the existing GetStream entry screen; no client room id is accepted.
  static Future<Map<String, dynamic>?> liveJoin(String listingId) async {
    try {
      final response = await ApiAuth.postJson(
        'https://$kSignalingHost/api/commercial/live/${Uri.encodeComponent(listingId)}/join',
        const {},
      );
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(response.body);
      return decoded is Map ? decoded.cast<String, dynamic>() : null;
    } catch (_) {
      return null;
    }
  }

  static Future<Map<String, dynamic>?> consultJoin(String bookingId) async {
    try {
      final response = await ApiAuth.postJson(
        'https://$kSignalingHost/api/commercial/consult/${Uri.encodeComponent(bookingId)}/join',
        const {},
      );
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(response.body);
      return decoded is Map ? decoded.cast<String, dynamic>() : null;
    } catch (_) {
      return null;
    }
  }
}
