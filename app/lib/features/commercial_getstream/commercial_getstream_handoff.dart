// Phase 2D — commercial GetStream handoff.
//
// This boundary is deliberately server-shaped. The client supplies only the
// listing entitlement/booking reference; the server supplies the credentials,
// call type and call id. Keeping this contract separate from the widgets makes
// it difficult for a future UI to accidentally fall back to Cloudflare, a
// legacy CallRoom, or a client-generated room.
import 'package:stream_video_flutter/stream_video_flutter.dart';

import '../../core/remote_config.dart';
import '../../identity/identity.dart' show AccountScope;

enum CommercialGetStreamProduct { liveEvent, consultation }

/// Roles are the server's commercial route values. Do not rename `host` or
/// `buyer` to UI labels here: the Worker returns those exact values.
enum CommercialGetStreamRole { viewer, host, creator, buyer }

/// The only values a commercial entry screen may send to the authorization
/// endpoint. Provider, call identity, price and payer are intentionally absent.
class CommercialGetStreamJoinRequest {
  const CommercialGetStreamJoinRequest({
    required this.listingId,
    required this.product,
    this.entitlementId,
    this.bookingId,
  });

  final String listingId;
  final CommercialGetStreamProduct product;
  final String? entitlementId;
  final String? bookingId;

  Map<String, dynamic> toJson() => {
        'listing_id': listingId,
        'kind': product == CommercialGetStreamProduct.liveEvent
            ? 'live_event'
            : 'consult_1to1',
        if (entitlementId != null) 'entitlement_id': entitlementId,
        if (bookingId != null) 'booking_id': bookingId,
      };
}

/// Implemented by the authenticated Worker client. A gateway must POST only
/// [CommercialGetStreamJoinRequest] and parse the response with
/// [CommercialGetStreamJoinHandoff.fromServer]; it must not mint room ids or
/// select a provider on-device.
abstract interface class CommercialGetStreamJoinGateway {
  Future<CommercialGetStreamJoinHandoff> authorize(
    CommercialGetStreamJoinRequest request,
  );
}

/// A server-minted, account-bound GetStream authorization.
///
/// Do not construct this from UI state. Use [fromServer] after the Worker has
/// checked the entitlement/booking, account and feature switch. The call id is
/// never accepted from a route, deep link or widget callback.
class CommercialGetStreamJoinHandoff {
  const CommercialGetStreamJoinHandoff({
    required this.product,
    required this.role,
    required this.provider,
    required this.apiKey,
    required this.userId,
    required this.userToken,
    required this.callType,
    required this.callId,
    required this.sessionId,
    required this.expiresAtMs,
  });

  final CommercialGetStreamProduct product;
  final CommercialGetStreamRole role;
  final String provider;
  final String apiKey;
  final String userId;
  final String userToken;
  final String callType;
  final String callId;
  final String sessionId;
  final int expiresAtMs;

  bool get isExpired => DateTime.now().millisecondsSinceEpoch >= expiresAtMs;

  static CommercialGetStreamJoinHandoff fromServer(
    Map<String, dynamic> json, {
    required CommercialGetStreamProduct expectedProduct,
    required CommercialGetStreamRole expectedRole,
  }) {
    String requiredString(String key) {
      final value = json[key]?.toString().trim() ?? '';
      if (value.isEmpty) throw FormatException('Missing server field: $key');
      return value;
    }

    // The actual commercial route response (worker/src/routes/
    // commercial_stream_sessions.ts) identifies GetStream with lane=\"commercial\"
    // and does not repeat provider or user_id. The authenticated account is the
    // token subject; AccountScope supplies that same id for the SDK user.
    if (json['lane'] != 'commercial') {
      throw const FormatException('Invalid commercial response lane');
    }
    final provider = (json['provider']?.toString().trim().isNotEmpty ?? false)
        ? json['provider'].toString().trim().toLowerCase()
        : 'getstream';
    if (provider != 'getstream') {
      throw const FormatException('Unsupported commercial media provider');
    }
    final product = json['kind'] == 'live_event'
        ? CommercialGetStreamProduct.liveEvent
        : json['kind'] == 'consult_1to1'
            ? CommercialGetStreamProduct.consultation
            : (throw const FormatException('Invalid commercial product'));
    if (product != expectedProduct) {
      throw const FormatException('Server product does not match this screen');
    }
    final role = switch (json['role']) {
      'viewer' => CommercialGetStreamRole.viewer,
      'host' => CommercialGetStreamRole.host,
      'creator' => CommercialGetStreamRole.creator,
      'buyer' => CommercialGetStreamRole.buyer,
      _ => throw const FormatException('Invalid commercial role'),
    };
    if (role != expectedRole) {
      throw const FormatException('Server role does not match this screen');
    }
    final expirySeconds = (json['token_expires_at'] as num?)?.toInt();
    final expiry = expirySeconds == null ? null : expirySeconds * 1000;
    if (expiry == null || expiry <= 0) {
      throw const FormatException('Missing server credential expiry');
    }
    final account = AccountScope.id;
    if ((account == null || account.isEmpty) &&
        (json['user_id']?.toString().trim().isEmpty ?? true)) {
      throw const FormatException('Missing account-bound commercial identity');
    }

    return CommercialGetStreamJoinHandoff(
      product: product,
      role: role,
      provider: provider,
      apiKey: requiredString('api_key'),
      userId: (json['user_id']?.toString().trim().isNotEmpty ?? false)
          ? json['user_id'].toString().trim()
          : account!,
      userToken: requiredString('token'),
      callType: requiredString('call_type'),
      callId: requiredString('call_id'),
      sessionId: requiredString('session_id'),
      expiresAtMs: expiry,
    );
  }

  CommercialGetStreamMediaPlan get mediaPlan =>
      CommercialGetStreamMediaPlan.forRole(role);

  void assertForAccount() {
    if (isExpired) throw StateError('Commercial media authorization expired');
    final account = AccountScope.id;
    if (account == null || account.isEmpty || account != userId) {
      throw StateError('Commercial media authorization is not for this account');
    }
  }
}

/// The app's configured product switches. The default is closed: a config
/// fetch failure can never open a paid room.
class CommercialGetStreamJoinFlags {
  const CommercialGetStreamJoinFlags({
    required this.liveJoinEnabled,
    required this.consultationJoinEnabled,
  });

  final bool liveJoinEnabled;
  final bool consultationJoinEnabled;

  factory CommercialGetStreamJoinFlags.fromRemoteConfig() =>
      CommercialGetStreamJoinFlags(
        liveJoinEnabled: RemoteConfig.commercialLiveJoinEnabled,
        consultationJoinEnabled: RemoteConfig.commercialConsultJoinEnabled,
      );

  bool allows(CommercialGetStreamProduct product) => product ==
          CommercialGetStreamProduct.liveEvent
      ? liveJoinEnabled
      : consultationJoinEnabled;
}

/// Initial media state passed to GetStream's [Call.join]. The SDK defaults
/// both tracks to disabled; making this explicit prevents a receive-only live
/// viewer from accidentally publishing if SDK defaults change.
class CommercialGetStreamMediaPlan {
  const CommercialGetStreamMediaPlan({
    required this.canPublish,
    required this.cameraEnabled,
    required this.microphoneEnabled,
  });

  final bool canPublish;
  final bool cameraEnabled;
  final bool microphoneEnabled;

  static CommercialGetStreamMediaPlan forRole(
    CommercialGetStreamRole role,
  ) {
    final publish = role != CommercialGetStreamRole.viewer;
    return CommercialGetStreamMediaPlan(
      canPublish: publish,
      cameraEnabled: publish,
      microphoneEnabled: publish,
    );
  }

  CallConnectOptions get connectOptions => CallConnectOptions(
        camera: TrackOption.fromSetting(enabled: cameraEnabled),
        microphone: TrackOption.fromSetting(enabled: microphoneEnabled),
      );
}

class CommercialGetStreamSession {
  const CommercialGetStreamSession({required this.client, required this.call});

  final StreamVideo client;
  final Call call;

  Future<void> leave() async {
    try {
      await call.leave().timeout(const Duration(seconds: 3));
    } catch (_) {}
    try {
      await client.disconnect().timeout(const Duration(seconds: 3));
    } catch (_) {}
    await client.dispose();
  }
}

abstract interface class CommercialGetStreamConnector {
  Future<CommercialGetStreamSession> connect(
    CommercialGetStreamJoinHandoff handoff,
  );
}

/// Optional connector capability used by consultation prejoin. Keeping it
/// separate preserves test doubles and legacy live callers while allowing
/// explicit camera/microphone choices to reach Call.join().
abstract interface class CommercialGetStreamMediaConnector {
  Future<CommercialGetStreamSession> connectWithMedia(
    CommercialGetStreamJoinHandoff handoff, {
    required bool cameraEnabled,
    required bool microphoneEnabled,
  });
}

/// Connects a server-authorized handoff with a non-singleton SDK client.
///
/// The shared StreamLane client is intentionally not reused here: commercial
/// authorization carries a short-lived server token and must not inherit a
/// different account's token after a shared-phone account switch.
class ServerAuthorizedCommercialGetStreamConnector
    implements CommercialGetStreamConnector, CommercialGetStreamMediaConnector {
  const ServerAuthorizedCommercialGetStreamConnector();

  Future<CommercialGetStreamSession> connect(
    CommercialGetStreamJoinHandoff handoff,
  ) => connectWithMedia(
        handoff,
        cameraEnabled: handoff.mediaPlan.cameraEnabled,
        microphoneEnabled: handoff.mediaPlan.microphoneEnabled,
      );

  @override
  Future<CommercialGetStreamSession> connectWithMedia(
    CommercialGetStreamJoinHandoff handoff, {
    required bool cameraEnabled,
    required bool microphoneEnabled,
  }) async {
    handoff.assertForAccount();
    final client = StreamVideo.create(
      handoff.apiKey,
      user: User.regular(userId: handoff.userId, name: 'AvaTOK'),
      userToken: handoff.userToken,
    );
    try {
      final connected = await client.connect();
      if (connected.isFailure) {
        throw StateError('GetStream authorization rejected');
      }
      final call = client.makeCall(
        callType: StreamCallType.fromString(handoff.callType),
        id: handoff.callId,
      );
      final plan = CommercialGetStreamMediaPlan(
        canPublish: handoff.mediaPlan.canPublish,
        cameraEnabled: handoff.mediaPlan.canPublish && cameraEnabled,
        microphoneEnabled: handoff.mediaPlan.canPublish && microphoneEnabled,
      );
      final joined = await call.join(
        connectOptions: plan.connectOptions,
        hintHighScaleLivestreamPublisher:
            handoff.product == CommercialGetStreamProduct.liveEvent &&
                handoff.role == CommercialGetStreamRole.host,
      );
      if (joined.isFailure) throw StateError('GetStream room join rejected');
      return CommercialGetStreamSession(client: client, call: call);
    } catch (_) {
      await client.disconnect();
      await client.dispose();
      rethrow;
    }
  }
}
