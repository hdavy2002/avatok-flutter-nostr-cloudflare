import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/config.dart';
import 'sync_hub.dart';

/// Ephemeral presence (typing / online / read receipts).
///
/// Two backends, chosen at runtime:
///  • Ably (iOS/Android, 'ably' provider): when [convKey] is supplied and
///    `SyncHub.I.ablyActive`, typing/online/receipts ride the shared Ably
///    transport (instant, reliable) and inbound events are surfaced in the SAME
///    `{'type': ...}` map shape the UI already parses — so no UI change.
///  • Legacy signaling WebSocket: a hashed room id over $kSignalingHost. Used on
///    desktop/macOS/web and whenever Ably isn't active.
class PresenceChannel {
  final String roomId;
  final String me; // short label included in events
  final String? convKey; // '1:<peerUid>' | 'g:<gid>' — enables the Ably path
  final String? peerUid; // 1:1 peer, for online/last-seen watch
  WebSocketChannel? _ws;
  final List<StreamSubscription> _ablySubs = [];
  final _events = StreamController<Map<String, dynamic>>.broadcast();

  PresenceChannel(this.roomId, this.me, {this.convKey, this.peerUid});

  /// True when this channel should delegate to the Ably transport.
  bool get _ablyMode => convKey != null && SyncHub.I.ablyActive;

  Stream<Map<String, dynamic>> get events => _events.stream;

  /// Deterministic 1:1 room id from the two pubkeys (order-independent, hashed).
  static String roomFor1on1(String a, String b) {
    final s = ([a, b]..sort()).join();
    final d = SHA256Digest().process(Uint8List.fromList(utf8.encode(s)));
    return 'p${d.sublist(0, 16).map((x) => x.toRadixString(16).padLeft(2, '0')).join()}';
  }

  /// Group presence room (all members derive the same id).
  static String roomForGroup(String gid) => 'pg-$gid';

  void connect() {
    if (_ablyMode) { _connectAbly(); return; }
    final id = 'pr-${DateTime.now().microsecondsSinceEpoch}';
    _ws = WebSocketChannel.connect(Uri.parse('wss://$kSignalingHost/room/$roomId?id=$id'));
    _ws!.stream.listen((raw) {
      try {
        final d = jsonDecode(raw as String);
        if (d is Map<String, dynamic>) _events.add(d);
      } catch (_) {/* ignore */}
    }, onError: (_) {}, onDone: () {});
  }

  /// Ably path: re-emit the transport's typed events as the legacy event maps the
  /// UI already understands, so chat_thread/chat_list need no behavioural change.
  void _connectAbly() {
    final t = SyncHub.I.ably;
    if (t == null) return;
    t.setOnline(true);
    if (peerUid != null && peerUid!.isNotEmpty) t.watchPresence(peerUid!);
    _ablySubs.add(t.typing.where((e) => e.convKey == convKey).listen((e) {
      _events.add({'type': 'typing', 'on': e.on, 'who': e.who});
    }));
    _ablySubs.add(t.presence
        .where((e) => peerUid != null && e.uid == peerUid)
        .listen((e) {
      _events.add(e.online
          ? {'type': 'online', 'who': e.uid}
          : {'type': 'offline', 'ts': e.lastSeen, 'who': e.uid});
    }));
    _ablySubs.add(t.receipts.where((e) => e.convKey == convKey).listen((e) {
      _events.add({'type': e.status, 'ts': e.ts, 'who': peerUid ?? ''});
    }));
  }

  void sendTyping(bool on) {
    if (_ablyMode) { SyncHub.I.ably?.setTyping(convKey!, on); return; }
    _send({'type': 'typing', 'on': on, 'who': me});
  }

  void sendRead(int ts) {
    if (_ablyMode) { SyncHub.I.ably?.sendReceipt(convKey!, 'read', ts); return; }
    _send({'type': 'read', 'ts': ts, 'who': me});
  }

  void sendDelivered(int ts) {
    if (_ablyMode) { SyncHub.I.ably?.sendReceipt(convKey!, 'delivered', ts); return; }
    _send({'type': 'delivered', 'ts': ts, 'who': me});
  }

  void sendOnline() {
    if (_ablyMode) { SyncHub.I.ably?.setOnline(true); return; }
    _send({'type': 'online', 'who': me});
  }

  /// Announce we're leaving/backgrounding, carrying our last-seen timestamp so
  /// peers flip to "last seen <time>" immediately instead of waiting out the
  /// online window. (Ably presence leave is account-global, so per-thread dispose
  /// does NOT leave — only an explicit offline does.)
  void sendOffline(int ts) {
    if (_ablyMode) { SyncHub.I.ably?.setOnline(false); return; }
    _send({'type': 'offline', 'ts': ts, 'who': me});
  }

  /// High-frequency live-location tick (WhatsApp-style). Rides the ephemeral
  /// presence room — deliberately NOT the durable message log — so a moving
  /// sender doesn't append hundreds of GPS rows into the InboxDO per share.
  /// The durable `t:'live'` bubble (sent over the message path) anchors the
  /// share; these frames just move its pin in place on every recipient.
  void sendLiveLoc(String id, double lat, double lng,
      {double? heading, double? speed, int? until, int? ts}) {
    _send({
      'type': 'liveloc',
      'id': id,
      'lat': lat,
      'lng': lng,
      if (heading != null) 'hdg': heading,
      if (speed != null) 'spd': speed,
      if (until != null) 'until': until,
      'ts': ts ?? DateTime.now().millisecondsSinceEpoch ~/ 1000,
      'who': me,
    });
  }

  /// Tell the room a live-location share has ended (sender stopped or expired).
  void sendLiveStop(String id) =>
      _send({'type': 'livestop', 'id': id, 'who': me});

  void _send(Map<String, dynamic> o) {
    // Ably mode has no signaling WS; live-location frames (the only remaining
    // _send callers in that mode) are dropped here rather than opening a socket.
    if (_ablyMode) return;
    try { _ws?.sink.add(jsonEncode(o)); } catch (_) {}
  }

  void dispose() {
    for (final s in _ablySubs) { s.cancel(); }
    _ablySubs.clear();
    try { _ws?.sink.close(); } catch (_) {}
    _events.close();
  }
}
