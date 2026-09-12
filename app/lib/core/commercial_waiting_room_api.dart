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
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show MediaType;

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
    this.opensAt,
    this.counterparty,
    this.role,
  });

  final Uri? roomWs;
  final String? roomToken;
  final int? startsAt;
  final int? endsAt;
  final int? checkInBy;
  // [WAITROOM-APP-3] A14: the server's join-open time (`starts_at` minus the
  // join-early minutes, same as web) — gate auto-join on THIS, not on
  // `startsAt` directly, when the worker sends it.
  final int? opensAt;
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
      opensAt: (json['opens_at'] as num?)?.toInt(),
      counterparty: counterparty,
      role: json['role']?.toString(),
    );
  }
}

/// [APP-ONLY-TX-APP-1] Shape of an uploaded chat attachment — the server's
/// response from `POST /api/commercial/session/:kind/:id/attachment` and the
/// same shape it embeds in a `chat` socket event's `attachment` field.
/// Contract shared with worker (S3) and web (S4): `{url, name, size, mime}`.
class ChatAttachment {
  final String url;
  final String name;
  final int size;
  final String mime;
  const ChatAttachment({required this.url, required this.name, required this.size, required this.mime});

  bool get isImage => mime.startsWith('image/');

  factory ChatAttachment.fromJson(Map<String, dynamic> json) => ChatAttachment(
        url: json['url']?.toString() ?? '',
        name: json['name']?.toString() ?? '',
        size: (json['size'] as num?)?.toInt() ?? 0,
        mime: json['mime']?.toString() ?? 'application/octet-stream',
      );

  /// Null when the wire object is missing its `url` (nothing to render/open).
  static ChatAttachment? tryParse(dynamic raw) {
    if (raw is! Map) return null;
    final a = ChatAttachment.fromJson(raw.cast<String, dynamic>());
    return a.url.isEmpty ? null : a;
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

  /// [APP-ONLY-TX-APP-1] 25 MB cap, shared with worker (S3) and web (S4).
  static const int maxAttachmentBytes = 25 * 1024 * 1024;

  /// Uploads a chat attachment for the given session `kind` ('consult' |
  /// 'live') and `id` (bookingId for consult), per the shared contract
  /// `POST /api/commercial/session/:kind/:id/attachment` (multipart `file`,
  /// user JWT). Throws [SessionApiError] on a non-2xx response — including
  /// 404, which callers must treat as "the worker route isn't deployed yet"
  /// and show the "Attachments not available yet" fallback, never a crash.
  static Future<ChatAttachment> uploadAttachment({
    required String kind,
    required String id,
    required Uint8List bytes,
    required String filename,
    required String mime,
  }) async {
    final url = '$kApiBase/commercial/session/${Uri.encodeComponent(kind)}/${Uri.encodeComponent(id)}/attachment';
    // Signed headers carry the Clerk bearer + trace id; `MultipartRequest`
    // overwrites `content-type` with its own multipart boundary at
    // `finalize()` time, so the JSON content-type this returns is harmless.
    final headers = await ApiAuth.signedHeaders('POST', url);
    final request = http.MultipartRequest('POST', Uri.parse(url))
      ..headers.addAll(headers)
      ..files.add(http.MultipartFile.fromBytes('file', bytes,
          filename: filename, contentType: MediaType.parse(mime)));
    final streamed = await request.send().timeout(const Duration(seconds: 60));
    final res = await http.Response.fromStream(streamed);
    final decoded = res.body.isEmpty ? null : jsonDecode(res.body);
    final json = decoded is Map ? decoded.cast<String, dynamic>() : <String, dynamic>{};
    if (res.statusCode >= 300) {
      throw SessionApiError(
          res.statusCode, json['error']?.toString() ?? 'Attachment upload failed', json);
    }
    return ChatAttachment.fromJson(json);
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
  // [WAITROOM-APP-2] Fix 6/7: server-authoritative check-in evidence, when the
  // worker sends it. Null on deployments that haven't landed it yet — callers
  // fall back to locally observed roster history.
  final int? hostCheckedInAt;
  const CommercialWaitingRoomWelcome({required this.startsAt, required this.endsAt, required this.hostLive, this.hostCheckedInAt});
}

class CommercialWaitingRoomRoster extends CommercialWaitingRoomEvent {
  final bool host, attendee;
  final int? hostCheckedInAt;
  const CommercialWaitingRoomRoster({required this.host, required this.attendee, this.hostCheckedInAt});
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
  // [WAITROOM-APP-2] Fix 11: "mine" is decided by uid when the DO sends one;
  // null on older deployments, where the caller falls back to name match.
  final String? uid;
  // [APP-ONLY-TX-APP-1] Optional file/image attached to this chat message,
  // per the shared `{type:'chat', ..., attachment?:{url,name,size,mime}}`
  // contract. Null when the message carries no attachment.
  final ChatAttachment? attachment;
  const CommercialWaitingRoomChat({required this.from, required this.text, required this.at, this.uid, this.attachment});
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
  // [WAITROOM-APP-3] A12: relays RoomChannel.onFailure — fires once if the
  // socket never delivers a single message after repeated attempts (a
  // rejected token), so a caller can fall back to a direct join.
  final _failed = StreamController<void>.broadcast();
  late final RoomChannel _room;

  CommercialWaitingRoomChannel(Uri uri) {
    // [WAITROOM-APP-2] Fix 9: RoomChannel can call onState(false) from a
    // retry that was already in flight when close() ran (its _retry() calls
    // onState before checking _closed) — guard so we never add to a
    // controller this class has already closed.
    _room = RoomChannel(uri, _dispatch, onState: (c) {
      if (!_connected.isClosed) _connected.add(c);
    }, onFailure: () {
      if (!_failed.isClosed) _failed.add(null);
    });
  }

  Stream<CommercialWaitingRoomEvent> get events => _events.stream;
  Stream<bool> get connectionState => _connected.stream;
  Stream<void> get failures => _failed.stream;

  void _dispatch(Map<String, dynamic> e) {
    // [WAITROOM-APP-2] Fix 9: a message can arrive from the underlying socket
    // after close() has already closed _events (close() does not close the
    // RoomChannel synchronously-only — see the guard above).
    if (_events.isClosed) return;
    switch (e['type']) {
      case 'welcome':
        final startsAt = (e['starts_at'] as num?)?.toInt();
        final endsAt = (e['ends_at'] as num?)?.toInt();
        if (startsAt != null && endsAt != null) {
          _events.add(CommercialWaitingRoomWelcome(
              startsAt: startsAt, endsAt: endsAt, hostLive: e['host_live'] == true,
              hostCheckedInAt: (e['host_checked_in_at'] as num?)?.toInt()));
        }
        // Some deployments fold the initial roster into welcome — handle both.
        if (e['roster'] is Map) _emitRoster(e['roster'] as Map, hostCheckedInAt: (e['host_checked_in_at'] as num?)?.toInt());
      case 'roster':
        _emitRoster(e, hostCheckedInAt: (e['host_checked_in_at'] as num?)?.toInt());
      case 'presence':
        _events.add(CommercialWaitingRoomPresence(
          uid: e['uid']?.toString(),
          role: e['role']?.toString(),
          joined: e['joined'] == true,
        ));
      case 'chat':
        final text = e['text']?.toString();
        final attachment = ChatAttachment.tryParse(e['attachment']);
        // [APP-ONLY-TX-APP-1] An attachment-only message carries empty text —
        // it must still render, so the old "drop empty text" guard now keys
        // off attachment presence too.
        if ((text != null && text.isNotEmpty) || attachment != null) {
          _events.add(CommercialWaitingRoomChat(
            from: e['from']?.toString() ?? '',
            text: text ?? '',
            at: (e['at'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
            uid: e['uid']?.toString(),
            attachment: attachment,
          ));
        }
      case 'session_ended':
        _events.add(const CommercialWaitingRoomEnded());
    }
  }

  void _emitRoster(Map e, {int? hostCheckedInAt}) {
    final roster = e['roster'] is Map ? e['roster'] as Map : e;
    _events.add(CommercialWaitingRoomRoster(
      host: roster['host'] == true,
      attendee: roster['attendee'] == true,
      hostCheckedInAt: hostCheckedInAt ?? (roster['host_checked_in_at'] as num?)?.toInt(),
    ));
  }

  /// ≤500 chars per the DO's relay contract; longer text is dropped
  /// client-side to fail loud in dev rather than let the server 400 silently.
  /// [APP-ONLY-TX-APP-1] `attachment` rides alongside (or instead of) text —
  /// an attachment-only send passes an empty `text`.
  void sendChat(String text, {ChatAttachment? attachment}) {
    final trimmed = text.trim();
    if (trimmed.length > 500) return;
    if (attachment == null && trimmed.isEmpty) return;
    _room.send({
      'type': 'chat',
      'text': trimmed,
      if (attachment != null)
        'attachment': {
          'url': attachment.url,
          'name': attachment.name,
          'size': attachment.size,
          'mime': attachment.mime,
        },
    });
  }

  void close() {
    _room.close();
    unawaited(_events.close());
    unawaited(_connected.close());
    unawaited(_failed.close());
  }
}
