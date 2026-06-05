import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:bip340/bip340.dart' as bip340;
import 'package:pointycastle/export.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/api_auth.dart';

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
    final pub = ApiAuth.identity?.pubHex;
    if (pub != null && pub.isNotEmpty && !url.contains('pubkey=')) {
      url += (url.contains('?') ? '&' : '?') + 'pubkey=$pub';
    }
    _ch = WebSocketChannel.connect(Uri.parse(url));
    _connected = true;
    _ch!.stream.listen(_onMessage, onError: (_) => _connected = false, onDone: () => _connected = false);
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
      }
    } catch (_) {/* ignore malformed */}
  }

  void publish(NostrEvent e) => _send(['EVENT', e.toJson()]);
  void subscribe(String subId, List<Map<String, dynamic>> filters) =>
      _send(['REQ', subId, ...filters]);
  void closeSub(String subId) => _send(['CLOSE', subId]);

  void _send(List<dynamic> o) {
    try { _ch?.sink.add(jsonEncode(o)); } catch (_) {}
  }

  void dispose() {
    try { _ch?.sink.close(); } catch (_) {}
    _events.close();
    _eose.close();
    _notifs.close();
    _connected = false;
  }
}
