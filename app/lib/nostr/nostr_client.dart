import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:bip340/bip340.dart' as bip340;
import 'package:pointycastle/export.dart';

/// Cloudflare-native pivot (Nostr deprecated). The relay/NIP-01 transport is gone.
/// `NostrClient` is now a COMPATIBILITY STUB so the handful of legacy screens that
/// still construct `NostrClient(kNostrRelayUrl)` keep compiling. The real
/// messaging transport is the per-user InboxDO, driven by `RelayHub`
/// (relay_hub.dart) and `AvaDm`/`AvaGroupDm` over HTTP + one WebSocket.
///
/// `NostrEvent` is retained (self-contained signing) for any residual callers.

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

/// Compatibility stub. Construction and all relay verbs are no-ops; the streams
/// are open-but-silent so existing `listen(...)` call sites are harmless.
class NostrClient {
  final String relayUrl;
  NostrClient(this.relayUrl);

  final _events = StreamController<(String subId, NostrEvent ev)>.broadcast();
  final _eose = StreamController<String>.broadcast();
  final _notifs = StreamController<Map<String, dynamic>>.broadcast();
  final _publishC = StreamController<({String id, bool accepted, String message})>.broadcast();

  Stream<(String, NostrEvent)> get events => _events.stream;
  Stream<String> get eose => _eose.stream;
  Stream<Map<String, dynamic>> get notifications => _notifs.stream;
  Stream<({String id, bool accepted, String message})> get publishResults => _publishC.stream;

  bool get isConnected => true;   // the real socket lives in RelayHub now
  bool get isAuthed => true;      // no NIP-42 — Clerk JWT gates at the edge

  void connect() {}
  void ensureConnected() {}
  void subscribe(String subId, List<Map<String, dynamic>> filters) {}
  void closeSub(String subId) {}
  void publish(NostrEvent e) {}

  void dispose() {
    _events.close();
    _eose.close();
    _notifs.close();
    _publishC.close();
  }
}
