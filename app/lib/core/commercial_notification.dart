import 'dart:convert';

enum CommercialNotificationKind {
  checkoutConfirmed,
  rescheduled,
  cancelled,
  joinWindow,
  broadcastStarted,
  broadcastEnded,
  refund,
  receipt,
}

/// Stable commercial notification contract. Provider credentials, call ids and
/// tokens are intentionally rejected and never carried into a deep link.
class CommercialNotificationPayload {
  const CommercialNotificationPayload({
    required this.kind,
    this.listingId,
    this.bookingId,
    this.title,
    this.creator,
  });

  final CommercialNotificationKind kind;
  final String? listingId;
  final String? bookingId;
  final String? title;
  final String? creator;

  static CommercialNotificationPayload? fromData(Map<String, dynamic> data) {
    if (data.containsKey('provider_token') ||
        data.containsKey('token') ||
        data.containsKey('call_id') ||
        data.containsKey('callId') ||
        data.containsKey('call_cid')) return null;
    final type = (data['type'] ?? data['event'] ?? data['event_type'] ?? '').toString().trim().toLowerCase();
    final kind = _kind(type);
    if (kind == null) return null;
    final listingId = _stable(data['listing_id'] ?? data['listingId']);
    final bookingId = _stable(data['booking_id'] ?? data['bookingId']);
    if (listingId == null && bookingId == null) return null;
    return CommercialNotificationPayload(
      kind: kind,
      listingId: listingId,
      bookingId: bookingId,
      title: _optional(data['title']),
      creator: _optional(data['creator_name'] ?? data['creator']),
    );
  }

  static CommercialNotificationPayload? fromPayload(String payload) {
    if (!payload.startsWith('commercial:')) return null;
    try {
      final decoded = jsonDecode(payload.substring('commercial:'.length));
      if (decoded is! Map) return null;
      return fromData(decoded.cast<String, dynamic>());
    } catch (_) {
      return null;
    }
  }

  String toPayload() => 'commercial:${jsonEncode({
        'type': _wireName,
        if (listingId != null) 'listing_id': listingId,
        if (bookingId != null) 'booking_id': bookingId,
      })}';

  String get _wireName => switch (kind) {
        CommercialNotificationKind.checkoutConfirmed => 'commercial_checkout_confirmed',
        CommercialNotificationKind.rescheduled => 'commercial_rescheduled',
        CommercialNotificationKind.cancelled => 'commercial_cancelled',
        CommercialNotificationKind.joinWindow => 'commercial_join_window',
        CommercialNotificationKind.broadcastStarted => 'commercial_broadcast_started',
        CommercialNotificationKind.broadcastEnded => 'commercial_broadcast_ended',
        CommercialNotificationKind.refund => 'commercial_refund',
        CommercialNotificationKind.receipt => 'commercial_receipt',
      };

  String get titleText => switch (kind) {
        CommercialNotificationKind.checkoutConfirmed => 'Booking confirmed',
        CommercialNotificationKind.rescheduled => 'Session rescheduled',
        CommercialNotificationKind.cancelled => 'Session cancelled',
        CommercialNotificationKind.joinWindow => 'Your session is ready',
        CommercialNotificationKind.broadcastStarted => 'Live event started',
        CommercialNotificationKind.broadcastEnded => 'Live event ended',
        CommercialNotificationKind.refund => 'Refund update',
        CommercialNotificationKind.receipt => 'Receipt available',
      };

  String bodyText() {
    final subject = title?.trim().isNotEmpty == true ? title!.trim() : 'your AvaTOK session';
    return switch (kind) {
      CommercialNotificationKind.checkoutConfirmed => '$subject is confirmed for your account.',
      CommercialNotificationKind.rescheduled => '$subject has a new server-confirmed time.',
      CommercialNotificationKind.cancelled => '$subject was cancelled. Open My Sessions for details.',
      CommercialNotificationKind.joinWindow => 'The server join window for $subject is open.',
      CommercialNotificationKind.broadcastStarted => '$subject is live now.',
      CommercialNotificationKind.broadcastEnded => '$subject has ended. Your receipt may be ready.',
      CommercialNotificationKind.refund => 'A refund decision for $subject is available.',
      CommercialNotificationKind.receipt => 'Your server receipt for $subject is ready.',
    };
  }

  static CommercialNotificationKind? _kind(String type) {
    final normalized = type.replaceAll('-', '_');
    return switch (normalized) {
      'commercial_checkout_confirmed' || 'commercial_booking_confirmed' || 'checkout_confirmed' || 'booking_confirmed' => CommercialNotificationKind.checkoutConfirmed,
      'commercial_rescheduled' || 'commercial_session_rescheduled' || 'commercial_booking_rescheduled' || 'session_rescheduled' => CommercialNotificationKind.rescheduled,
      'commercial_cancelled' || 'commercial_session_cancelled' || 'commercial_booking_cancelled' || 'session_cancelled' || 'commercial_canceled' => CommercialNotificationKind.cancelled,
      'commercial_join_window' || 'commercial_join_window_open' || 'join_window_open' => CommercialNotificationKind.joinWindow,
      'commercial_broadcast_started' || 'commercial_live_started' || 'broadcast_started' => CommercialNotificationKind.broadcastStarted,
      'commercial_broadcast_ended' || 'commercial_live_ended' || 'broadcast_ended' => CommercialNotificationKind.broadcastEnded,
      'commercial_refund' || 'commercial_refund_issued' || 'refund_issued' => CommercialNotificationKind.refund,
      'commercial_receipt' || 'commercial_receipt_ready' || 'receipt_ready' => CommercialNotificationKind.receipt,
      _ => null,
    };
  }

  static String? _stable(dynamic value) {
    final text = value?.toString().trim() ?? '';
    if (text.isEmpty || text.length > 160 || !RegExp(r'^[A-Za-z0-9_:-]+$').hasMatch(text)) return null;
    return text;
  }

  static String? _optional(dynamic value) {
    final text = value?.toString().trim() ?? '';
    if (text.isEmpty) return null;
    return text.length > 120 ? text.substring(0, 120) : text;
  }
}
