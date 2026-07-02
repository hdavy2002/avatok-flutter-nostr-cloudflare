import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/config.dart';
import 'party/party_hub.dart';

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
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  PartyRoom? _party; // PartyKit path (replaces Ably)
  StreamSubscription? _partySub;
  StreamSubscription? _partyPresSub;

  PresenceChannel(this.roomId, this.me, {this.convKey, this.peerUid});

  /// True when this channel should delegate to the PartyKit transport (the
  /// ephemeral layer's new home now that Ably is retired). Takes precedence over
  /// the legacy signaling WS; [_ablyMode] stays for any residual Ably build.
  bool get _partyMode => convKey != null && PartyHub.I.enabled;

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
    if (_partyMode) { _connectParty(); return; }
    final id = 'pr-${DateTime.now().microsecondsSinceEpoch}';
    _ws = WebSocketChannel.connect(Uri.parse('wss://$kSignalingHost/room/$roomId?id=$id'));
    _ws!.stream.listen((raw) {
      try {
        final d = jsonDecode(raw as String);
        if (d is Map<String, dynamic>) _events.add(d);
      } catch (_) {/* ignore */}
    }, onError: (_) {}, onDone: () {});
  }

  /// PartyKit path: join the conversation's presence room and re-emit its events
  /// in the SAME `{'type': ...}` map shape the UI already parses — so chat_thread/
  /// chat_list need no change. Room = `presence:<roomId>` (both peers derive the
  /// same hashed roomId, so they meet). Online/last-seen is derived from the
  /// party's presence ROSTER (a socket open == that user is present).
  void _connectParty() {
    final room = PartyHub.I.join('presence:$roomId');
    _party = room;
    _partySub = room.events.listen((e) {
      final t = e['t'];
      final who = (e['from'] ?? e['who'] ?? '').toString();
      if (t == 'typing') {
        _events.add({'type': 'typing', 'on': e['on'] == true, 'who': who});
      } else if (t == 'read' || t == 'delivered') {
        _events.add({'type': t, 'ts': (e['ts'] as num?)?.toInt() ?? 0, 'who': who});
      } else if (t == 'liveloc' || t == 'livestop') {
        _events.add({...e, 'type': t, 'who': who});
      }
    });
    _partyPresSub = room.presence.listen((roster) {
      final p = peerUid;
      if (p == null || p.isEmpty) return;
      final online = roster.contains(p);
      _events.add(online
          ? {'type': 'online', 'who': p}
          : {'type': 'offline', 'ts': DateTime.now().millisecondsSinceEpoch ~/ 1000, 'who': p});
    });
  }

  void sendTyping(bool on) {
    if (_partyMode) { _party?.send({'t': 'typing', 'on': on}); return; }
    _send({'type': 'typing', 'on': on, 'who': me});
  }

  void sendRead(int ts) {
    if (_partyMode) { _party?.send({'t': 'read', 'ts': ts}); return; }
    _send({'type': 'read', 'ts': ts, 'who': me});
  }

  void sendDelivered(int ts) {
    if (_partyMode) { _party?.send({'t': 'delivered', 'ts': ts}); return; }
    _send({'type': 'delivered', 'ts': ts, 'who': me});
  }

  void sendOnline() {
    // Party presence is implicit (a socket open == online), so no explicit send.
    if (_partyMode) return;
    _send({'type': 'online', 'who': me});
  }

  /// Announce we're leaving/backgrounding, carrying our last-seen timestamp so
  /// peers flip to "last seen <time>" immediately instead of waiting out the
  /// online window. (Ably presence leave is account-global, so per-thread dispose
  /// does NOT leave — only an explicit offline does.)
  void sendOffline(int ts) {
    // Party presence is roster-based (leave fires when the socket closes), so no
    // explicit offline send is needed.
    if (_partyMode) return;
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
    // Party mode: relay over the party room. Translate the legacy `type` key to
    // the party `t` key and drop `who` (the server stamps the verified sender).
    if (_partyMode) {
      final p = Map<String, dynamic>.from(o)..remove('who');
      final ty = p.remove('type');
      if (ty != null) p['t'] = ty;
      _party?.send(p);
      return;
    }
    try { _ws?.sink.add(jsonEncode(o)); } catch (_) {}
  }

  void dispose() {
    _partySub?.cancel();
    _partyPresSub?.cancel();
    _party?.leave();
    try { _ws?.sink.close(); } catch (_) {}
    _events.close();
  }
}
