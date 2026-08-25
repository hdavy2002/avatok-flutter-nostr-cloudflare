import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// Server-owned Add-to-AvaCalendar result. The client submits only an
/// entitlement; title, times and conflict decisions come from the Worker.
class CommercialCalendarResult {
  const CommercialCalendarResult({
    required this.status,
    required this.ok,
    this.error,
    this.eventId,
    this.alreadyAdded = false,
    this.conflict = false,
  });

  final int status;
  final bool ok;
  final String? error;
  final String? eventId;
  final bool alreadyAdded;
  final bool conflict;

  factory CommercialCalendarResult.fromResponse(int status, String body) {
    Map<String, dynamic> json;
    try {
      final decoded = jsonDecode(body);
      json = decoded is Map ? decoded.cast<String, dynamic>() : <String, dynamic>{};
    } catch (_) {
      json = <String, dynamic>{};
    }
    final error = json['error']?.toString();
    return CommercialCalendarResult(
      status: status,
      ok: status >= 200 && status < 300 && json['ok'] == true,
      error: error,
      eventId: (json['event_id'] ?? json['calendar_event_id'])?.toString(),
      alreadyAdded: json['already_added'] == true || error == 'already_added',
      conflict: status == 409 || json['conflict'] == true || error == 'calendar_conflict',
    );
  }
}

class CommercialCalendarApi {
  /// Add one account-owned entitlement to AvaCalendar. The stable key makes a
  /// double tap/retry return the same server result instead of duplicating it.
  /// The Worker route is scoped to the listing (live event) or booking
  /// (consultation); there is intentionally no generic unscoped calendar URL.
  static Future<CommercialCalendarResult> addEntitlement(
    String entitlementId, {
    required String kind,
    required String listingId,
    String? bookingId,
  }) async {
    final id = entitlementId.trim();
    final listing = listingId.trim();
    final booking = bookingId?.trim();
    final isConsult = kind == 'consult_1to1' || kind == 'consult';
    final isLive = kind == 'live_event' || kind == 'live';
    final routeId = isConsult ? (booking ?? '') : listing;
    if (id.isEmpty || listing.isEmpty || (!isConsult && !isLive) || routeId.isEmpty || !RegExp(r'^[A-Za-z0-9-]{1,96}$').hasMatch(routeId)) {
      return const CommercialCalendarResult(status: 400, ok: false, error: 'entitlement required');
    }
    try {
      final route = isConsult ? 'consult' : 'live';
      final url = 'https://$kSignalingHost/api/commercial/$route/${Uri.encodeComponent(routeId)}/calendar';
      final response = await ApiAuth.postJsonH(
        url,
        const <String, dynamic>{},
        {'Idempotency-Key': 'commercial-calendar:$id'},
      );
      return CommercialCalendarResult.fromResponse(response.statusCode, response.body);
    } catch (_) {
      return const CommercialCalendarResult(status: 0, ok: false, error: 'network');
    }
  }
}
