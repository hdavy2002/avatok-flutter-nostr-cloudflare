// Phase 2E — authenticated commercial live control/admission gateway.
//
// The live join endpoint is POST-only because its response carries short-lived
// GetStream credentials. Never move this call to a cacheable GET.
import 'dart:convert';

import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/listings_api.dart';
import 'commercial_getstream_handoff.dart';

enum LiveServerState {
  scheduled,
  starting,
  backstage,
  live,
  reconnecting,
  ending,
  ended,
  reconciliationPending,
  unknown,
}

LiveServerState liveServerStateFromJson(Object? value) => switch (value) {
      'scheduled' => LiveServerState.scheduled,
      'starting' => LiveServerState.starting,
      'backstage' => LiveServerState.backstage,
      'live' => LiveServerState.live,
      // [LIVE-GRACE-APP-1] Host dropped mid-broadcast; server pairs this with
      // `reconnect_deadline_ms` on the same state response (WP8, wave 2). Not
      // present until WP8 ships — guarded as null everywhere it is read.
      'reconnecting' => LiveServerState.reconnecting,
      'ending' => LiveServerState.ending,
      'ended' => LiveServerState.ended,
      'reconciliation_pending' => LiveServerState.reconciliationPending,
      _ => LiveServerState.unknown,
    };

class CommercialLiveState {
  const CommercialLiveState({
    required this.sessionId,
    required this.state,
    this.settlementState,
    this.liveStartedAt,
    this.endedAt,
    this.endsAt,
    this.startsAt,
    this.reconnectDeadlineMs,
    this.outcome,
  });

  final String sessionId;
  final LiveServerState state;
  final String? settlementState;
  final int? liveStartedAt;
  final int? endedAt;
  final int? endsAt;
  // [LIVE-GRACE-APP-1] Scheduled start (used to cap the backstage countdown at
  // `commercialLiveBackstageEarlyMin`). `reconnectDeadlineMs`/`outcome` back the
  // host reconnect banner and the viewer no-return refund line; both come from
  // WP8 (wave 2, not yet shipped) and are null until then — every read site
  // guards for that.
  final int? startsAt;
  final int? reconnectDeadlineMs;
  final String? outcome;

  factory CommercialLiveState.fromJson(Map<String, dynamic> json) {
    final sessionId = json['session_id']?.toString() ?? '';
    if (sessionId.isEmpty) throw const FormatException('Live session id missing');
    return CommercialLiveState(
      sessionId: sessionId,
      state: liveServerStateFromJson(json['state']),
      settlementState: json['settlement_state']?.toString(),
      liveStartedAt: (json['live_started_at'] as num?)?.toInt(),
      endedAt: (json['ended_at'] as num?)?.toInt(),
      endsAt: (json['ends_at'] as num?)?.toInt(),
      startsAt: (json['starts_at'] as num?)?.toInt(),
      reconnectDeadlineMs: (json['reconnect_deadline_ms'] as num?)?.toInt(),
      outcome: json['outcome']?.toString(),
    );
  }
}

class CommercialLiveJoinGrant {
  const CommercialLiveJoinGrant({
    required this.handoff,
    required this.state,
    required this.title,
  });

  final CommercialGetStreamJoinHandoff handoff;
  final CommercialLiveState state;
  final String title;
}

class CommercialLiveCapabilities {
  const CommercialLiveCapabilities({
    this.captions = false,
    this.qualityControls = false,
    this.moderation = false,
  });

  final bool captions;
  final bool qualityControls;
  final bool moderation;
}

class CommercialConsultExtensionQuote {
  const CommercialConsultExtensionQuote({
    required this.extensionId,
    required this.bookingId,
    required this.minutes,
    required this.amount,
    required this.currency,
    required this.policyVersion,
    required this.baseEndsAt,
    required this.extensionEndsAt,
    required this.ratePerMinute,
    required this.state,
    required this.creatorConsented,
    required this.buyerConsented,
  });

  final String extensionId, bookingId, currency, policyVersion, state;
  final int minutes, amount, baseEndsAt, extensionEndsAt, ratePerMinute;
  final bool creatorConsented, buyerConsented;

  factory CommercialConsultExtensionQuote.fromJson(Map<String, dynamic> json) {
    String s(String key) => json[key]?.toString() ?? '';
    int n(String key) => (json[key] as num?)?.toInt() ?? 0;
    final quote = CommercialConsultExtensionQuote(
      extensionId: s('extension_id'), bookingId: s('booking_id'),
      minutes: n('extension_minutes'), amount: n('amount'), currency: s('currency'),
      policyVersion: s('policy_version'), baseEndsAt: n('base_ends_at'),
      extensionEndsAt: n('extension_ends_at'), ratePerMinute: n('rate_per_minute'),
      state: s('state'), creatorConsented: json['creator_consented'] == true,
      buyerConsented: json['buyer_consented'] == true,
    );
    if (quote.extensionId.isEmpty || quote.bookingId.isEmpty || quote.currency.isEmpty ||
        quote.policyVersion.isEmpty || quote.minutes <= 0 || quote.amount <= 0 ||
        quote.ratePerMinute <= 0 || quote.extensionEndsAt <= quote.baseEndsAt) {
      throw const FormatException('Invalid server extension quote');
    }
    return quote;
  }
}

abstract interface class CommercialConsultGateway
    implements CommercialGetStreamJoinGateway {
  Future<CommercialLiveState> consultState(String bookingId);
  Future<CommercialConsultExtensionQuote> extensionQuote(String bookingId);
  Future<CommercialConsultExtensionQuote> confirmExtension(String bookingId, String extensionId, {required bool accept});
  Future<void> endConsultation(String bookingId);
  Future<void> cancelConsultation(String bookingId, {String reason});
  Future<CommercialReceiptResponse?> consultationReceipt(String sessionId);
}

abstract interface class CommercialLiveGateway {
  Future<CommercialLiveJoinGrant> prepareHost(String listingId);
  Future<CommercialLiveJoinGrant> joinViewer(String listingId);
  Future<CommercialLiveState> state(String listingId);
  Future<void> start(String listingId);
  Future<void> end(String listingId);
  Future<CommercialReceiptResponse?> receipt(String sessionId);
}

/// Authenticated consultation admission. The booking id is the only route
/// identifier sent by the client; the Worker resolves the listing, role and
/// provider call identity from the booking entitlement.
class AuthenticatedCommercialConsultGateway
    implements CommercialConsultGateway {
  const AuthenticatedCommercialConsultGateway();

  @override
  Future<CommercialGetStreamJoinHandoff> authorize(
    CommercialGetStreamJoinRequest request,
  ) async {
    final bookingId = request.bookingId?.trim() ?? '';
    if (bookingId.isEmpty) {
      throw const FormatException('Consultation booking id required');
    }
    final response = await ApiAuth.postJson(
      '$kApiBase/commercial/consult/${Uri.encodeComponent(bookingId)}/join',
      const {},
    );
    final decoded = jsonDecode(response.body);
    if (decoded is! Map) {
      throw const FormatException('Invalid consultation join response');
    }
    final json = decoded.cast<String, dynamic>();
    if (response.statusCode >= 300) {
      throw CommercialLiveGatewayError(
        response.statusCode,
        json['error']?.toString() ?? 'Consultation join failed',
      );
    }
    final role = switch (json['role']) {
      'creator' => CommercialGetStreamRole.creator,
      'buyer' => CommercialGetStreamRole.buyer,
      _ => throw const FormatException('Invalid consultation role'),
    };
    return CommercialGetStreamJoinHandoff.fromServer(
      json,
      expectedProduct: CommercialGetStreamProduct.consultation,
      expectedRole: role,
    );
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body, {String? key}) async {
    final response = await ApiAuth.postJsonH(
      '$kApiBase$path', body, {'Idempotency-Key': key ?? 'consult-ui:$path'},
    );
    final decoded = jsonDecode(response.body);
    final json = decoded is Map ? decoded.cast<String, dynamic>() : <String, dynamic>{};
    if (response.statusCode >= 300) {
      throw CommercialLiveGatewayError(response.statusCode, json['error']?.toString() ?? 'Consultation request failed');
    }
    return json;
  }

  @override
  Future<CommercialLiveState> consultState(String bookingId) async {
    final response = await ApiAuth.getSigned('$kApiBase/commercial/consult/${Uri.encodeComponent(bookingId)}/state');
    final decoded = jsonDecode(response.body);
    final json = decoded is Map ? decoded.cast<String, dynamic>() : <String, dynamic>{};
    if (response.statusCode >= 300) throw CommercialLiveGatewayError(response.statusCode, json['error']?.toString() ?? 'Consultation state unavailable');
    return CommercialLiveState.fromJson(json);
  }

  @override
  Future<CommercialConsultExtensionQuote> extensionQuote(String bookingId) async {
    final json = await _post('/commercial/consult/${Uri.encodeComponent(bookingId)}/extend/quote', const {}, key: 'consult-extension-quote:$bookingId');
    return CommercialConsultExtensionQuote.fromJson(json);
  }

  @override
  Future<CommercialConsultExtensionQuote> confirmExtension(String bookingId, String extensionId, {required bool accept}) async {
    final json = await _post('/commercial/consult/${Uri.encodeComponent(bookingId)}/extend/confirm', {
      'extension_id': extensionId, 'accept': accept,
    }, key: 'consult-extension-confirm:$extensionId:${accept ? 'accept' : 'decline'}');
    return CommercialConsultExtensionQuote.fromJson(json);
  }

  @override
  Future<void> endConsultation(String bookingId) async {
    await _post('/commercial/consult/${Uri.encodeComponent(bookingId)}/end', const {}, key: 'consult-end:$bookingId');
  }

  @override
  Future<void> cancelConsultation(String bookingId, {String reason = 'buyer_cancel'}) async {
    await _post('/commercial/consult/${Uri.encodeComponent(bookingId)}/cancel', {'reason': reason}, key: 'consult-cancel:$bookingId:$reason');
  }

  @override
  Future<CommercialReceiptResponse?> consultationReceipt(String sessionId) => ListingsApi.commercialReceipt(sessionId);
}

class CommercialLiveGatewayError implements Exception {
  const CommercialLiveGatewayError(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}

/// Production authenticated gateway for the Worker commercial live routes.
class AuthenticatedCommercialLiveGateway
    implements CommercialLiveGateway, CommercialGetStreamJoinGateway {
  const AuthenticatedCommercialLiveGateway();

  /// Adapter for the shared commercial entry screen used by canonical live
  /// links. The live viewer route is always receive-only; host access goes
  /// through [prepareHost] in the link resolver and readiness screen.
  @override
  Future<CommercialGetStreamJoinHandoff> authorize(
    CommercialGetStreamJoinRequest request,
  ) async {
    if (request.product != CommercialGetStreamProduct.liveEvent ||
        request.listingId.trim().isEmpty) {
      throw const FormatException('Live listing id required');
    }
    final grant = await joinViewer(request.listingId);
    return grant.handoff;
  }

  String _url(String action, String listingId) =>
      '$kApiBase/commercial/live/${Uri.encodeComponent(listingId)}/$action';

  Map<String, dynamic> _json(String body) {
    final decoded = jsonDecode(body);
    if (decoded is! Map) throw const FormatException('Invalid commercial response');
    return decoded.cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> _post(String url,
      {Map<String, dynamic> body = const {}, bool idempotent = false}) async {
    final response = idempotent
        ? await ApiAuth.postJsonH(url, body, {
            'Idempotency-Key': 'live-ui:${url.substring(url.indexOf('/commercial/')).replaceAll('/', ':')}',
          })
        : await ApiAuth.postJson(url, body);
    final json = _json(response.body);
    if (response.statusCode >= 300) {
      throw CommercialLiveGatewayError(
        response.statusCode,
        json['error']?.toString() ?? 'Commercial live request failed',
      );
    }
    return json;
  }

  Future<Map<String, dynamic>> _get(String url) async {
    final response = await ApiAuth.getSigned(url);
    final json = _json(response.body);
    if (response.statusCode >= 300) {
      throw CommercialLiveGatewayError(
        response.statusCode,
        json['error']?.toString() ?? 'Commercial live request failed',
      );
    }
    return json;
  }

  Future<CommercialLiveJoinGrant> _join({
    required String listingId,
    required CommercialGetStreamRole role,
    required String action,
  }) async {
    final response = await _post(_url(action, listingId));
    final handoff = CommercialGetStreamJoinHandoff.fromServer(
      response,
      expectedProduct: CommercialGetStreamProduct.liveEvent,
      expectedRole: role,
    );
    final serverState = await state(listingId);
    return CommercialLiveJoinGrant(
      handoff: handoff,
      state: serverState,
      title: response['title']?.toString() ?? 'Live event',
    );
  }

  @override
  Future<CommercialLiveJoinGrant> prepareHost(String listingId) => _join(
        listingId: listingId,
        role: CommercialGetStreamRole.host,
        action: 'prepare-host',
      );

  @override
  Future<CommercialLiveJoinGrant> joinViewer(String listingId) => _join(
        listingId: listingId,
        role: CommercialGetStreamRole.viewer,
        action: 'join',
      );

  @override
  Future<CommercialLiveState> state(String listingId) async {
    final json = await _get(_url('state', listingId));
    return CommercialLiveState.fromJson(json);
  }

  @override
  Future<void> start(String listingId) async {
    await _post(_url('go-live', listingId), idempotent: true);
  }

  @override
  Future<void> end(String listingId) async {
    await _post(_url('end', listingId), idempotent: true);
  }

  @override
  Future<CommercialReceiptResponse?> receipt(String sessionId) =>
      ListingsApi.commercialReceipt(sessionId);
}
