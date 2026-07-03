// LEGACY STUBS — Nostr is deprecated (Cloudflare-native pivot, 2026-06-09).
// NostrEvent/NostrClient/Nip17 are kept ONLY so not-yet-migrated social screens
// (communities, status, group info, new group) compile. All methods are no-ops.
// Delete this file once those screens are on SyncHub/AvaDm/AvaGroupDm.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;

/// Cloudflare-native pivot (Nostr deprecated). The relay/NIP-01 transport is gone.
/// `NostrClient` is now a COMPATIBILITY STUB so the handful of legacy screens that
/// still construct `NostrClient(kNostrRelayUrl)` keep compiling. The real
/// messaging transport is the per-user InboxDO, driven by `SyncHub`
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
    // Nostr deprecated: signatures are never verified (server-routed plaintext).
    // This stub only exists so legacy screens compile.
    const sig = '';
    return NostrEvent(
        id: id, pubkey: pubHex, createdAt: ts, kind: kind,
        tags: tags, content: content, sig: sig);
  }

  static String idOf(String pubHex, int createdAt, int kind, List<List<String>> tags, String content) {
    final serial = jsonEncode([0, pubHex, createdAt, kind, tags, content]);
    return _sha256Hex(Uint8List.fromList(utf8.encode(serial)));
  }

  static String _sha256Hex(Uint8List data) {
    final d = Uint8List.fromList(crypto.sha256.convert(data).bytes);
    return d.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
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

  bool get isConnected => true;   // the real socket lives in SyncHub now
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

// ---- nip17 compatibility stub (merged) ----

/// Cloudflare-native pivot (Nostr deprecated). NIP-17 gift-wrapping is GONE —
/// messages are server-routed plaintext now. This is a COMPATIBILITY STUB so the
/// legacy social screens (communities, status, group info, new group) that still
/// reference Nip17 keep compiling. The real send path is AvaDm/AvaGroupDm over
/// HTTP. The wrap* methods produce no events (a no-op publish), and unwrap returns
/// null — these call sites are being migrated to the new transport.
class Unwrapped {
  final String senderPub;
  final String recipientPub;
  final String payload;
  final String rumorId;
  final int createdAt;
  Unwrapped(this.senderPub, this.recipientPub, this.payload, this.rumorId, this.createdAt);
}

class Nip17 {
  static (List<NostrEvent>, String) wrapBoth({
    required String senderPriv, required String senderPub,
    required String peerPub, required String payload,
  }) => (<NostrEvent>[], '');

  static (NostrEvent, String) wrapTo({
    required String senderPriv, required String senderPub,
    required String recipientPub, required String payload,
  }) => (_empty(), '');

  static (List<NostrEvent>, String) wrapMany({
    required String senderPriv, required String senderPub,
    required List<String> recipientPubs, required String payload,
  }) => (<NostrEvent>[], '');

  static Unwrapped? unwrap(String myPriv, NostrEvent gift) => null;

  static NostrEvent _empty() =>
      NostrEvent(id: '', pubkey: '', createdAt: 0, kind: 0, tags: const [], content: '', sig: '');
}
