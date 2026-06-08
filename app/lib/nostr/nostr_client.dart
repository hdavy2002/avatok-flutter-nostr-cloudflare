import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:bip340/bip340.dart' as bip340;
import 'package:pointycastle/export.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/api_auth.dart';
import '../core/ava_log.dart';

/// A signed Nostr event (NIP-01).
class NostrEvent {
  final String id;
  final String pubkey;
  final int createdAt;
  final int kind;
  final List<List<String>> tags;
  final String content;
  final String sig;

  NostrEvent({
    required this.id, required this.pubkey, required this.createdAt,
    required this.kind, required this.tags, required this.content, required this.sig,
  });

  Map<String, dynamic> toJson() => {
        'id': id, 'pubkey': pubkey, 'created_at': createdAt, 'kind': kind,
        'tags': tags, 'content': content, 'sig': sig,
      };

  factory NostrEvent.fromJson(Map<String, dynamic> m) => NostrEvent(
        id: m['id'].toString(),
        pubkey: m['pubkey'].toString(),
        createdAt: (m['created_at'] as num).toInt(),
        kind: (m['kind'] as num).toInt(),
        tags: ((m['tags'] as List?) ?? [])
            .map((t) => (t as List).map((x) => x.toString()).toList())
            .toList(),
        content: (m['content'] ?? '').toString(),
        sig: (m['sig'] ?? '').toString(),
      );

  String? firstTag(String key) {
    for (final t in tags) {
      if (t.isNotEmpty && t[0] == key && t.length > 1) return t[1];
    }
    return null;
  }

  /// Build + sign an event from a private key (hex).
  static NostrEvent sign({
    required String privHex,
    required String pubHex,
    required int kind,
    required List<List<String>> tags,
    required String content,
    int? createdAt,
  }) {
    final ts = createdAt ?? DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final id = idOf(pubHex, ts, kind, tags, content);
    final aux = _randomHex(32);
    final sig = bip340.sign(privHex, id, aux);
    return NostrEvent(
        id: id, pubkey: pubHex, createdAt: ts, kind: kind,
        tags: tags, content: content, sig: sig);
  }

  /// NIP-01 event id (sha256 of the canonical serialization).
  static String idOf(String pubHex, int createdAt, int kind, List<List<String>> tags, String content) {
    final serial = jsonEncode([0, pubHex, createdAt, kind, tags, content]);
    return _sha256Hex(Uint8List.fromList(utf8.encode(serial)));
  }

  static String _sha256Hex(Uint8List data) {
    final d = SHA256Digest().process(data);
    return d.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  static String _randomHex(int n) {
    final r = Random.secure();
    return List<int>.generate(n, (_) => r.nextInt(256))
        .map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}

/// Thin Nostr relay client over a single WebSocket (NIP-01: EVENT/REQ/CLOSE).
class NostrClient {
  final String relayUrl;
  WebSocketChannel? _ch;
  final _events = StreamController<(String subId, NostrEvent ev)>.broadcast();
  final _eose = StreamController<String>.broadcast();
  final _notifs = StreamController<Map<String, dynamic>>.broadcast();
  bool _connected = false;

  // NIP-42: the relay sends an AUTH challenge on connect and REFUSES to store or
  // serve PRIVATE kinds (DM gift-wraps 1059, seals, call signaling, DM relay
  // lists) until the socket proves key ownership with a signed kind-22242 event.
  //
  // BUG THIS FIXES: previously, when there was no identity at connect we marked
  // the socket "authed" and let private EVENTs through UNauthed. The relay
  // silently dropped them ("auth-required"), so DMs looked sent but never
  // landed — exactly the "send but never arrive" symptom. Now private frames are
  // gated on a REAL NIP-42 success (`_socketAuthed`), queued until then, and
  // every publish result (accepted/rejected) is surfaced so the UI can never
  // show a false "sent".
  static const Set<int> privateKinds = {13, 14, 1059, 25050, 10050, 10443};
  bool _socketAuthed = false; // true ONLY after the relay accepts our AUTH
  bool _hasIdentity = false;  // can we NIP-42 auth at all?
  String? _authEventId;
  final List<List<dynamic>> _privateQueue = []; // private frames awaiting AUTH

  /// Per-publish relay result: ["OK", id, accepted, message]. Lets the UI mark a
  /// message delivered/failed instead of optimistically assuming it sent.
  final _publishC =
      StreamController<({String id, bool accepted, String message})>.broadcast();
  Stream<({String id, bool accepted, String message})> get publishResults =>
      _publishC.stream;

  /// True once this socket has completed NIP-42 auth (private writes allowed).
  bool get isAuthed => _socketAuthed;

  NostrClient(this.relayUrl);

  Stream<(String, NostrEvent)> get events => _events.stream;
  Stream<String> get eose => _eose.stream;
  /// Server-originated system notifications pushed over this socket (["NOTIF", {...}]).
  Stream<Map<String, dynamic>> get notifications => _notifs.stream;
  bool get isConnected => _connected;

  void connect() {
    if (_connected) return;
    // Per-user inbox DO routing: tell the relay which user's DO to connect to.
    // The pubkey is a routing hint only — NIP-42 still proves ownership server-side.
    var url = relayUrl;
    final id = ApiAuth.identity;
    final pub = id?.pubHex;
    if (pub != null && pub.isNotEmpty && !url.contains('pubkey=')) {
      url += (url.contains('?') ? '&' : '?') + 'pubkey=$pub';
    }
    // Reset auth state for this (re)connection. Public reads flow immediately
    // (the sink buffers until the socket opens); PRIVATE writes/reads wait for a
    // real NIP-42 success — we NEVER send them in "public mode".
    _socketAuthed = false;
    _hasIdentity = id != null;
    AvaLog.I.log('relay', 'connect (hasIdentity=$_hasIdentity)');
    _ch = WebSocketChannel.connect(Uri.parse(url));
    _connected = true;
    _ch!.stream.listen(_onMessage,
        onError: (e) { _connected = false; AvaLog.I.log('relay', 'socket error: $e'); },
        onDone: () { _connected = false; AvaLog.I.log('relay', 'socket closed'); });
  }

  void _onMessage(dynamic raw) {
    try {
      final d = jsonDecode(raw as String) as List;
      switch (d[0]) {
        case 'EVENT':
          _events.add((d[1].toString(), NostrEvent.fromJson((d[2] as Map).cast<String, dynamic>())));
          break;
        case 'EOSE':
          _eose.add(d[1].toString());
          break;
        case 'NOTIF':
          _notifs.add((d[1] as Map).cast<String, dynamic>());
          break;
        case 'AUTH':
          // NIP-42 challenge → answer with a signed kind-22242 event.
          _authenticate(d[1].toString());
          break;
        case 'OK':
          // ["OK", <event-id>, <accepted>, <message>].
          final okId = d.length > 1 ? d[1].toString() : '';
          final accepted = d.length > 2 && d[2] == true;
          final okMsg = d.length > 3 ? d[3].toString() : '';
          if (okId.isNotEmpty && okId == _authEventId) {
            // Our NIP-42 auth result. On success, unlock + flush private frames.
            AvaLog.I.log('relay', 'AUTH ${accepted ? "accepted ✓" : "REJECTED ✗ ($okMsg)"}');
            if (accepted && !_socketAuthed) {
              _socketAuthed = true;
              AvaLog.I.log('relay', 'flushing ${_privateQueue.length} queued private frame(s)');
              _flushPrivate();
            }
            break;
          }
          // A published event's result — surface so the UI marks it sent/failed.
          if (!accepted) AvaLog.I.log('relay', 'publish REJECTED ${okId.length >= 8 ? okId.substring(0, 8) : okId}: $okMsg');
          _publishC.add((id: okId, accepted: accepted, message: okMsg));
          break;
      }
    } catch (_) {/* ignore malformed */}
  }

  /// NIP-42: sign a kind-22242 event echoing the relay's challenge and send it.
  void _authenticate(String challenge) {
    final id = ApiAuth.identity;
    if (id == null) return; // can't prove ownership; public reads only
    final ev = NostrEvent.sign(
      privHex: id.privHex,
      pubHex: id.pubHex,
      kind: 22242,
      tags: [['relay', relayUrl], ['challenge', challenge]],
      content: '',
    );
    _authEventId = ev.id;
    _sendNow(['AUTH', ev.toJson()]); // bypass the queue — this IS the unlock
  }

  void publish(NostrEvent e) =>
      _send(['EVENT', e.toJson()], private: privateKinds.contains(e.kind));
  void subscribe(String subId, List<Map<String, dynamic>> filters) => _send(
        ['REQ', subId, ...filters],
        private: filters.any(
            (f) => ((f['kinds'] as List?) ?? const []).any((k) => privateKinds.contains(k))),
      );
  void closeSub(String subId) => _send(['CLOSE', subId]);

  /// Public frames go out immediately (the WebSocket sink buffers until the
  /// socket opens). PRIVATE frames are held until a real NIP-42 auth — never
  /// sent in "public mode", which the relay rejects as auth-required.
  void _send(List<dynamic> o, {bool private = false}) {
    if (private && !_socketAuthed) {
      // No identity → we can never NIP-42 auth, so this private write would be
      // dropped by the relay. Surface it as a failed publish so the UI shows
      // "not sent" instead of a false "sent", rather than queueing forever.
      if (!_hasIdentity) {
        AvaLog.I.log('relay', 'DROP private ${o[0]} — no identity to NIP-42 auth');
        final id = (o.length > 1 && o[1] is Map) ? ((o[1] as Map)['id']?.toString() ?? '') : '';
        if (id.isNotEmpty) _publishC.add((id: id, accepted: false, message: 'no-identity'));
        return;
      }
      AvaLog.I.log('relay', 'queue private ${o[0]} until auth');
      _privateQueue.add(o);
      return;
    }
    _sendNow(o);
  }

  void _flushPrivate() {
    final pending = List<List<dynamic>>.of(_privateQueue);
    _privateQueue.clear();
    for (final o in pending) { _sendNow(o); }
  }

  void _sendNow(List<dynamic> o) {
    try { _ch?.sink.add(jsonEncode(o)); } catch (_) {}
  }

  void dispose() {
    try { _ch?.sink.close(); } catch (_) {}
    _events.close();
    _eose.close();
    _notifs.close();
    try { _publishC.close(); } catch (_) {}
    _connected = false;
  }
}
