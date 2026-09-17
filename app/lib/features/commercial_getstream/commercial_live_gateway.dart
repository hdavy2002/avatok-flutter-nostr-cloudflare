// Phase 2E — authenticated commercial live control/admission gateway.
//
// The live join endpoint is POST-only because its response carries short-lived
// GetStream credentials. Never move this call to a cacheable GET.
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';
import '../../core/api_auth.dart';
import '../../core/calls/stream_video_quality_controller.dart';
import '../../core/config.dart';
import '../../core/listings_api.dart';
import '../../identity/identity.dart' show AccountScope;
import 'commercial_getstream_handoff.dart';

enum CommercialQualityMode {
  auto('auto'),
  bestQuality('best'),
  dataSaver('data_saver');

  const CommercialQualityMode(this.wireValue);
  final String wireValue;

  static CommercialQualityMode fromWire(Object? value) => switch (value) {
    'best' => bestQuality,
    'data_saver' => dataSaver,
    _ => auto,
  };
}

/// Preference only. A mode is not proof of applied media quality, and it must
/// never influence price or camera/microphone intent.
class CommercialQualityPreferences {
  CommercialQualityPreferences._();
  static const _storage = FlutterSecureStorage();
  static const _key = 'commercial_quality_v1';

  static Future<CommercialQualityMode> load(String accountId) async {
    if (accountId.isEmpty || AccountScope.id != accountId) return CommercialQualityMode.auto;
    // Capture the scoped key before any await; never migrate a global value.
    final key = scopedKey(_key);
    try {
      final value = await _storage.read(key: key);
      return AccountScope.id == accountId
          ? CommercialQualityMode.fromWire(value) : CommercialQualityMode.auto;
    } catch (_) {
      return CommercialQualityMode.auto;
    }
  }

  static Future<void> save(String accountId, CommercialQualityMode mode) async {
    if (accountId.isEmpty || AccountScope.id != accountId) {
      throw StateError('Quality preference account changed');
    }
    final key = scopedKey(_key);
    await _storage.write(key: key, value: mode.wireValue);
  }
}

class CommercialQualitySnapshot {
  const CommercialQualitySnapshot({
    this.mode = CommercialQualityMode.auto,
    this.qualityReduced = false,
    this.videoPaused = false,
  });
  final CommercialQualityMode mode;
  // Controller-confirmed adaptations only; camera-off is not videoPaused.
  final bool qualityReduced, videoPaused;
}

/// The media slice implements this contract. setMode resolves only after the
/// controller accepts the preference; snapshots describe applied media state.
/// The controller loads CommercialQualityPreferences on session creation.
abstract interface class CommercialQualityController
    implements ValueListenable<CommercialQualitySnapshot> {
  String get accountId;
  Future<void> setMode(CommercialQualityMode mode);
}

/// Bridges the media controller's truthful applied state to the feature-level
/// binding used by consultation/live widgets. The core controller stays free of
/// marketplace imports, while every active SDK call gets one scoped adapter.
class _StreamCommercialQualityController extends ChangeNotifier
    implements CommercialQualityController {
  _StreamCommercialQualityController(this._delegate) {
    _delegate.addListener(_forward);
  }
  final StreamVideoQualityController _delegate;

  @override
  String get accountId => AccountScope.id ?? '';

  @override
  CommercialQualitySnapshot get value {
    final requested = _delegate.requested;
    final capture = _delegate.appliedCapture;
    final incoming = _delegate.appliedIncoming;
    return CommercialQualitySnapshot(
      mode: switch (_delegate.policy.mode) {
        VideoQualityMode.best => CommercialQualityMode.bestQuality,
        VideoQualityMode.dataSaver => CommercialQualityMode.dataSaver,
        VideoQualityMode.auto => CommercialQualityMode.auto,
      },
      qualityReduced: (capture != null && capture.index < requested.index) ||
          (incoming != null && incoming.index < requested.index),
      videoPaused: _delegate.serverPaused || _delegate.incomingPaused ||
          _delegate.cameraPausedForQuality,
    );
  }

  void _forward() => notifyListeners();

  @override
  Future<void> setMode(CommercialQualityMode mode) => _delegate.setMode(
        switch (mode) {
          CommercialQualityMode.bestQuality => VideoQualityMode.best,
          CommercialQualityMode.dataSaver => VideoQualityMode.dataSaver,
          CommercialQualityMode.auto => VideoQualityMode.auto,
        },
      );

  void close() => _delegate.removeListener(_forward);
}

/// Attach the shared quality state to a single SDK call. The returned cleanup
/// is safe after reconnect because it only removes its own adapter instance.
VoidCallback attachCommercialQualityController(
  Object call,
  StreamVideoQualityController controller,
) {
  final adapter = _StreamCommercialQualityController(controller);
  final detach = CommercialQualityBindings.attach(call, adapter);
  return () {
    adapter.close();
    detach();
  };
}

/// Session-scoped binding seam without adding quality methods to gateways or
/// touching media controllers. Attach to the SDK Call on creation, detach on
/// teardown, and attach again to the new Call after reconnect. No global user
/// state is retained; stale teardown cannot detach a replacement controller.
class CommercialQualityBindings {
  CommercialQualityBindings._();
  static final _calls = Expando<ValueNotifier<CommercialQualityController?>>();

  static ValueNotifier<CommercialQualityController?> forCall(Object call) =>
      _calls[call] ??= ValueNotifier<CommercialQualityController?>(null);

  static VoidCallback attach(Object call, CommercialQualityController controller) {
    final binding = forCall(call);
    binding.value = controller;
    return () {
      if (identical(binding.value, controller)) binding.value = null;
    };
  }
}

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
      // [WAITROOM-APP-2] Fix 13: some deployments still key the scheduled
      // time as `scheduled_at` rather than `starts_at` — fall back so the
      // backstage countdown and waiting-room `opens_at` gate never go null
      // on those.
      startsAt: (json['starts_at'] as num?)?.toInt() ?? (json['scheduled_at'] as num?)?.toInt(),
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
        body: json,
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
      throw CommercialLiveGatewayError(response.statusCode, json['error']?.toString() ?? 'Consultation request failed', body: json);
    }
    return json;
  }

  @override
  Future<CommercialLiveState> consultState(String bookingId) async {
    final response = await ApiAuth.getSigned('$kApiBase/commercial/consult/${Uri.encodeComponent(bookingId)}/state');
    final decoded = jsonDecode(response.body);
    final json = decoded is Map ? decoded.cast<String, dynamic>() : <String, dynamic>{};
    if (response.statusCode >= 300) throw CommercialLiveGatewayError(response.statusCode, json['error']?.toString() ?? 'Consultation state unavailable', body: json);
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
  const CommercialLiveGatewayError(this.status, this.message, {this.body});
  final int status;
  final String message;
  // [WAITROOM-APP-3] A13: the decoded error response body, when the caller
  // has it — a 425 "too early" response can carry the server's authoritative
  // `opens_at` so a retry waits for the right time instead of guessing.
  final Map<String, dynamic>? body;
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
        body: json,
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
        body: json,
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
