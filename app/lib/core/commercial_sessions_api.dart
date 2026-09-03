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
      sessionId: json['commercial_session_id']?.toString(),
      receiptId: json['receipt_id']?.toString(),
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
      bookingStatus == 'cancelled' ||
      bookingStatus == 'canceled' ||
      receiptSettlementState == 'refunded' ||
      receiptSettlementState == 'partial_refund' ||
      refundSettlementState == 'refunded' ||
      refundSettlementState == 'partial_refund';
  bool get isCompleted =>
      !isRefunded &&
      (bookingStatus == 'completed' ||
          sessionState == 'ended' ||
          (endsAt > 0 && estimatedServerNow >= endsAt));
  bool get isLiveNow => !isRefunded && !isCompleted && sessionState == 'live';
  bool get isJoinWindowOpen =>
      !isRefunded &&
      !isCompleted &&
      opensAt > 0 &&
      closesAt > 0 &&
      estimatedServerNow >= opensAt &&
      estimatedServerNow <= closesAt;

  bool get hasCommercialChat =>
      (chatChannelId ?? '').isNotEmpty && (chatChannelType ?? '').isNotEmpty;

  String get joinLabel {
    if (isRefunded) return 'Refunded';
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
    if (isRefunded) return CommercialSessionBucket.cancelledRefunded;
    if (isCompleted) return CommercialSessionBucket.completed;
    if (isLiveNow) return CommercialSessionBucket.liveNow;
    return CommercialSessionBucket.upcoming;
  }
}

enum CommercialSessionBucket { upcoming, liveNow, completed, cancelledRefunded }

class CommercialSessionsResponse {
  final int serverNow;
  final List<CommercialSessionRecord> sessions;

  const CommercialSessionsResponse(
      {required this.serverNow, required this.sessions});

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
        .where(
            (row) => row.entitlementId.isNotEmpty && row.listingId.isNotEmpty)
        .toList();
    return CommercialSessionsResponse(serverNow: serverNow, sessions: rows);
  }
}

class CommercialSessionsApi {
  static const _url = 'https://$kSignalingHost/api/commercial/sessions/mine';

  static Future<CommercialSessionsResponse?> mine() async {
    try {
      final response = await ApiAuth.getSigned(_url);
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(response.body);
      if (decoded is! Map) return null;
      return CommercialSessionsResponse.fromJson(
          decoded.cast<String, dynamic>());
    } catch (_) {
      return null;
    }
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
