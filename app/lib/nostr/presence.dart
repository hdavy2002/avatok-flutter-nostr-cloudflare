import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/config.dart';

/// Ephemeral presence (typing / read receipts) over the signaling WS room.
/// Not stored, not gift-wrapped — typing is high-frequency and transient.
/// The relay/worker only sees an opaque room id (a hash of the participants).
class PresenceChannel {
  final String roomId;
  final String me; // short label included in events
  WebSocketChannel? _ws;
  final _events = StreamController<Map<String, dynamic>>.broadcast();

  PresenceChannel(this.roomId, this.me);

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
    final id = 'pr-${DateTime.now().microsecondsSinceEpoch}';
    _ws = WebSocketChannel.connect(Uri.parse('wss://$kSignalingHost/room/$roomId?id=$id'));
    _ws!.stream.listen((raw) {
      try {
        final d = jsonDecode(raw as String);
        if (d is Map<String, dynamic>) _events.add(d);
      } catch (_) {/* ignore */}
    }, onError: (_) {}, onDone: () {});
  }

  void sendTyping(bool on) => _send({'type': 'typing', 'on': on, 'who': me});
  void sendRead(int ts) => _send({'type': 'read', 'ts': ts, 'who': me});
  void sendDelivered(int ts) => _send({'type': 'delivered', 'ts': ts, 'who': me});
  void sendOnline() => _send({'type': 'online', 'who': me});

  void _send(Map<String, dynamic> o) {
    try { _ws?.sink.add(jsonEncode(o)); } catch (_) {}
  }

  void dispose() {
    try { _ws?.sink.close(); } catch (_) {}
    _events.close();
  }
}
