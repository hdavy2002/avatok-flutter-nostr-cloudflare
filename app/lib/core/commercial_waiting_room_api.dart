// [WAITROOM-APP-1] Commercial 1:1 consult waiting room — prejoin contract +
// the waiting-room WebSocket (the existing `StreamSessionDO` room, reused —
// see Specs/RULEBOOK-PAID-SESSIONS.md §3). No GetStream participant is
// created here: this is the pre-call lobby, not a media room.
//
// The prejoin fields (`room_ws`, `room_token`, `starts_at`, `ends_at`,
// `check_in_by`, `counterparty`, `role`) are a NEW server contract
// (worker WP1/WP2). Every field is read defensively: [CommercialWaitingRoomGrant.isComplete]
// is false until all of them are present, and callers MUST fall back to
// today's direct-join flow when it is false so the app never breaks if the
// worker lands the endpoint later than the app build.
import 'dart:async';
import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';
import 'session_api.dart' show RoomChannel, SessionApiError;

export 'session_api.dart' show RoomChannel;

class CommercialWaitingRoomCounterparty {
  final String name;
  final String? avatarUrl;
  const CommercialWaitingRoomCounterparty({required this.name, this.avatarUrl});
}

/// The server-authoritative shape of `GET /api/commercial/consult/:bookingId/prejoin`.
/// Every field is nullable on the wire; only [isComplete] gates the new UX.
class CommercialWaitingRoomGrant {
  const CommercialWaitingRoomGrant({
    this.roomWs,
    this.roomToken,
    this.startsAt,
    this.endsAt,
    this.checkInBy,
    this.counterparty,
    this.role,
  });

  final Uri? roomWs;
  final String? roomToken;
  final int? startsAt;
  final int? endsAt;
  final int? checkInBy;
  final CommercialWaitingRoomCounterparty? counterparty;
  final String? role; // 'creator' | 'buyer'

  /// True only when every field the waiting room needs is present and sane.
  /// False means: the worker has not landed this yet (or returned a partial
  /// payload) — the caller falls back to the pre-WP6 direct-join flow.
  bool get isComplete =>
      roomWs != null && (roomToken?.isNotEmpty ?? false) &&
      startsAt != null && endsAt != null && endsAt! > startsAt!;

  bool get isCreator => role == 'creator';

  static const empty = CommercialWaitingRoomGrant();

  factory CommercialWaitingRoomGrant.fromJson(Map<String, dynamic> json) {
    Uri? ws;
    final wsRaw = json['room_ws']?.toString();
    if (wsRaw != null && wsRaw.isNotEmpty) {
      try { ws = Uri.parse(wsRaw); } catch (_) { ws = null; }
    }
    final counterpartyJson = json['counterparty'];
    final counterparty = counterpartyJson is Map
        ? CommercialWaitingRoomCounterparty(
            name: (counterpartyJson['name'] ?? '').toString(),
            avatarUrl: counterpartyJson['avatar_url']?.toString(),
          )
        : null;
    return CommercialWaitingRoomGrant(
      roomWs: ws,
      roomToken: json['room_token']?.toString(),
      startsAt: (json['starts_at'] as num?)?.toInt(),
      endsAt: (json['ends_at'] as num?)?.toInt(),
      checkInBy: (json['check_in_by'] as num?)?.toInt(),
      counterparty: counterparty,
      role: json['role']?.toString(),
    );
  }
}

class CommercialWaitingRoomApi {
  /// Fetches the waiting-room grant for a consult booking. Throws
  /// [SessionApiError] on a non-2xx response (including 404 when the worker
  /// route is not deployed yet); callers catch this and fall back.
  static Future<CommercialWaitingRoomGrant> prejoin(String bookingId) async {
    final r = await ApiAuth.getSigned(
        '$kApiBase/commercial/consult/${Uri.encodeComponent(bookingId)}/prejoin');
    final decoded = jsonDecode(r.body);
    final json = decoded is Map ? decoded.cast<String, dynamic>() : <String, dynamic>{};
    if (r.statusCode >= 300) {
      throw SessionApiError(
          r.statusCode, json['error']?.toString() ?? 'Prejoin unavailable', json);
    }
    return CommercialWaitingRoomGrant.fromJson(json);
  }
}

/// Server → client events on the waiting-room socket (contract in
/// Specs/PLAN-2026-09-11-WAITING-ROOM-BUILD.md, "Contracts shared by all WPs").
sealed class CommercialWaitingRoomEvent {
  const CommercialWaitingRoomEvent();
}

class CommercialWaitingRoomWelcome extends CommercialWaitingRoomEvent {
  final int startsAt, endsAt;
  final bool hostLive;
  const CommercialWaitingRoomWelcome({required this.startsAt, required this.endsAt, required this.hostLive});
}

class CommercialWaitingRoomRoster extends CommercialWaitingRoomEvent {
  final bool host, attendee;
  const CommercialWaitingRoomRoster({required this.host, required this.attendee});
}

class CommercialWaitingRoomPresence extends CommercialWaitingRoomEvent {
  final String? uid;
  final String? role; // 'host' | 'attendee'
  final bool joined;
  const CommercialWaitingRoomPresence({this.uid, this.role, required this.joined});
}

class CommercialWaitingRoomChat extends CommercialWaitingRoomEvent {
  final String from, text;
  final int at;
  const CommercialWaitingRoomChat({required this.from, required this.text, required this.at});
}

class CommercialWaitingRoomEnded extends CommercialWaitingRoomEvent {
  const CommercialWaitingRoomEnded();
}

/// Thin wrapper around the existing [RoomChannel] (the same
/// `StreamSessionDO` websocket the legacy consult waiting room used —
/// `session_api.dart`) that unpacks the waiting-room message shapes into a
/// single typed stream. No new socket, no new protocol.
class CommercialWaitingRoomChannel {
  final _events = StreamController<CommercialWaitingRoomEvent>.broadcast();
  final _connected = StreamController<bool>.broadcast();
  late final RoomChannel _room;

  CommercialWaitingRoomChannel(Uri uri) {
    _room = RoomChannel(uri, _dispatch, onState: (c) => _connected.add(c));
  }

  Stream<CommercialWaitingRoomEvent> get events => _events.stream;
  Stream<bool> get connectionState => _connected.stream;

  void _dispatch(Map<String, dynamic> e) {
    switch (e['type']) {
      case 'welcome':
        final startsAt = (e['starts_at'] as num?)?.toInt();
        final endsAt = (e['ends_at'] as num?)?.toInt();
        if (startsAt != null && endsAt != null) {
          _events.add(CommercialWaitingRoomWelcome(
              startsAt: startsAt, endsAt: endsAt, hostLive: e['host_live'] == true));
        }
        // Some deployments fold the initial roster into welcome — handle both.
        if (e['roster'] is Map) _emitRoster(e['roster'] as Map);
      case 'roster':
        _emitRoster(e);
      case 'presence':
        _events.add(CommercialWaitingRoomPresence(
          uid: e['uid']?.toString(),
          role: e['role']?.toString(),
          joined: e['joined'] == true,
        ));
      case 'chat':
        final text = e['text']?.toString();
        if (text != null && text.isNotEmpty) {
          _events.add(CommercialWaitingRoomChat(
            from: e['from']?.toString() ?? '',
            text: text,
            at: (e['at'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
          ));
        }
      case 'session_ended':
        _events.add(const CommercialWaitingRoomEnded());
    }
  }

  void _emitRoster(Map e) {
    final roster = e['roster'] is Map ? e['roster'] as Map : e;
    _events.add(CommercialWaitingRoomRoster(
      host: roster['host'] == true,
      attendee: roster['attendee'] == true,
    ));
  }

  /// ≤500 chars per the DO's relay contract; longer text is dropped
  /// client-side to fail loud in dev rather than let the server 400 silently.
  void sendChat(String text) {
    final trimmed = text.trim();
    if (trimmed.isEmpty || trimmed.length > 500) return;
    _room.send({'type': 'chat', 'text': trimmed});
  }

  void close() {
    _room.close();
    unawaited(_events.close());
    unawaited(_connected.close());
  }
}
