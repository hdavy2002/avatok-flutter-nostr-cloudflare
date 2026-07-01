import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/io.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';

/// PartyKit realtime CLIENT (ephemeral live layer; replaces Ably). One
/// [PartyRoom] per room id, ref-counted and REUSED across features so we never
/// open a second socket for the same room. Broadcast-only: nothing here is
/// durable — durable delivery stays on the InboxDO socket (+ /sync + marketplace
/// forceResync). Ships DARK behind [PartyHub.enabled] (set from RemoteConfig
/// `partyEnabled`) so wiring party features into the app is a total no-op until
/// the PartyDO is deployed and the flag is flipped on.
///
/// Rooms (match the Worker): `thread:<conv>`, `listing:<id>`, `neg:<negId>`,
/// `user:<uid>`, `conf:<groupId>`. Event envelope: `{t:<type>, ...}`; the server
/// stamps `from` (verified uid) + `ts` and relays to the rest of the room.
class PartyHub {
  PartyHub._();
  static final PartyHub I = PartyHub._();

  /// Master runtime gate (RemoteConfig `partyEnabled`). While false, [join]
  /// returns a dormant room that never opens a socket.
  bool enabled = false;

  final Map<String, PartyRoom> _rooms = {};

  /// Join (or reuse) a room. Each caller MUST call [PartyRoom.leave] when done so
  /// the socket is ref-counted down and closed when the last subscriber leaves.
  PartyRoom join(String room) {
    final r = _rooms.putIfAbsent(room, () => PartyRoom._(room, () => _rooms.remove(room)));
    r._refs++;
    if (enabled) r._ensureOpen();
    return r;
  }

  /// Called by RemoteConfig when `partyEnabled` resolves. Opening/closing of any
  /// already-joined rooms follows the flag.
  void setEnabled(bool on) {
    if (enabled == on) return;
    enabled = on;
    for (final r in _rooms.values) {
      if (on) {
        r._ensureOpen();
      } else {
        r._teardown(reconnect: false);
      }
    }
  }
}

class PartyRoom {
  PartyRoom._(this.room, this._onGone);
  final String room;
  final void Function() _onGone;
  int _refs = 0;

  WebSocketChannel? _ch;
  StreamSubscription? _sub;
  bool _closing = false;
  int _reconnects = 0;
  int _connectedAt = 0;
  Timer? _reconnectTimer;

  final _events = StreamController<Map<String, dynamic>>.broadcast();
  final _presence = StreamController<List<String>>.broadcast();
  List<String> _roster = const [];

  /// Every event for this room (decoded JSON map, carrying `from`/`ts`).
  Stream<Map<String, dynamic>> get events => _events.stream;

  /// Roster changes — the list of uids currently connected to the room.
  Stream<List<String>> get presence => _presence.stream;
  List<String> get roster => _roster;
  bool get isOpen => _ch != null;

  Future<void> _ensureOpen() async {
    if (_ch != null || _closing || !PartyHub.I.enabled) return;
    final token = await ApiAuth.clerkBearer?.call();
    if (token == null || token.isEmpty) {
      _scheduleReconnect();
      return;
    }
    // The socket may have been torn down / this room disposed while we awaited
    // the token — bail if so.
    if (_ch != null || _closing || !PartyHub.I.enabled) return;
    final url =
        '$kPartyWsUrl?room=${Uri.encodeQueryComponent(room)}&token=${Uri.encodeQueryComponent(token)}';
    try {
      final ch = kIsWeb
          ? WebSocketChannel.connect(Uri.parse(url))
          : IOWebSocketChannel.connect(Uri.parse(url), pingInterval: const Duration(seconds: 25));
      _ch = ch;
      _connectedAt = DateTime.now().millisecondsSinceEpoch;
      Analytics.capture('party_connect', {'room': room, 'reconnects': _reconnects});
      _sub = ch.stream.listen(
        _onFrame,
        onDone: _onClosed,
        onError: (Object _) => _onClosed(),
        cancelOnError: true,
      );
    } catch (e) {
      Analytics.capture('party_error', {'room': room, 'err': e.toString()});
      _ch = null;
      _scheduleReconnect();
    }
  }

  void _onFrame(dynamic raw) {
    Map<String, dynamic> m;
    try {
      m = (jsonDecode(raw as String) as Map).cast<String, dynamic>();
    } catch (_) {
      return;
    }
    final t = m['t'];
    if (t == 'pong') return;
    if (t == 'presence') {
      _roster = ((m['roster'] as List?) ?? const []).map((e) => e.toString()).toList();
      if (!_presence.isClosed) _presence.add(_roster);
    }
    if (!_events.isClosed) _events.add(m);
  }

  /// Send an ephemeral event to the room. Server stamps `from`+`ts` and relays to
  /// the OTHER members. No-op if the socket isn't open — this is a best-effort
  /// live layer, never a delivery guarantee.
  void send(Map<String, dynamic> event) {
    final ch = _ch;
    if (ch == null) return;
    try {
      ch.sink.add(jsonEncode(event));
    } catch (_) {/* dropped; ephemeral */}
  }

  void _onClosed() {
    _sub?.cancel();
    _sub = null;
    try {
      _ch?.sink.close();
    } catch (_) {}
    _ch = null;
    if (_closing) return;
    final up = _connectedAt > 0 ? DateTime.now().millisecondsSinceEpoch - _connectedAt : 0;
    _reconnects++;
    Analytics.capture('party_disconnect', {'room': room, 'uptime_ms': up, 'reconnects': _reconnects});
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closing || _refs <= 0 || !PartyHub.I.enabled) return;
    _reconnectTimer?.cancel();
    // Capped exponential backoff — deliberately MUCH gentler than Ably's fixed 2s
    // retry (that hammer was a big part of the 575-disconnects/3h churn). 2s → 4s
    // → 8s … capped at 60s.
    final shift = _reconnects.clamp(0, 5);
    final delayMs = (2000 * (1 << shift)).clamp(2000, 60000);
    _reconnectTimer = Timer(Duration(milliseconds: delayMs), () {
      if (_closing || _refs <= 0 || !PartyHub.I.enabled) return;
      Analytics.capture('party_reconnect', {'room': room, 'attempt': _reconnects});
      _ensureOpen();
    });
  }

  void _teardown({required bool reconnect}) {
    _reconnectTimer?.cancel();
    _sub?.cancel();
    _sub = null;
    try {
      _ch?.sink.close();
    } catch (_) {}
    _ch = null;
    if (reconnect) _scheduleReconnect();
  }

  /// Decrement the ref count; when the last subscriber leaves, close the socket
  /// and drop the room from the hub.
  void leave() {
    _refs--;
    if (_refs > 0) return;
    _closing = true;
    _teardown(reconnect: false);
    if (!_events.isClosed) _events.close();
    if (!_presence.isClosed) _presence.close();
    _onGone();
  }
}
