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

  /// Announce we're leaving/backgrounding, carrying our last-seen timestamp so
  /// peers flip to "last seen <time>" immediately instead of waiting out the
  /// online window.
  void sendOffline(int ts) => _send({'type': 'offline', 'ts': ts, 'who': me});

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
    try { _ws?.sink.add(jsonEncode(o)); } catch (_) {}
  }

  void dispose() {
    try { _ws?.sink.close(); } catch (_) {}
    _events.close();
  }
}
