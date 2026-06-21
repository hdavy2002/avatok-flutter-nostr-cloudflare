import 'dart:async';
import 'dart:convert';
import 'dart:io' show InternetAddress;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/io.dart';

import '../core/api_auth.dart';
import '../core/ava_log.dart';
import '../core/chat_state.dart' show ReadStateStore;
import '../core/config.dart';
import '../core/db.dart';
import '../core/disk_cache.dart';
import '../identity/identity.dart';
import 'dm.dart' show DmMessage;
import 'legacy_stubs.dart';

/// A delivered message, server-routed plaintext (Cloudflare-native; Nostr gone).
/// Consumers (chat list, threads, group threads) filter by [convKey].
class HubEvent {
  final String convKey; // '1:<peerUid>' (DM) or 'g:<convId>' (group)
  final String senderPub;
  final String recipientPub;
  final bool mine;
  final String rumorId;
  final String payload;
  final int createdAt;
  HubEvent(this.convKey, this.senderPub, this.recipientPub, this.mine,
      this.rumorId, this.payload, this.createdAt);
  DmMessage toDm() => DmMessage(rumorId: rumorId, mine: mine, payload: payload, createdAt: createdAt);
}

/// App-lifetime singleton holding the ONE WebSocket to my per-user InboxDO and an
/// in-memory store of every message seen this session. The server already routes
/// + stores plaintext, so there is no per-message crypto: we connect, send a
/// cursor, receive the backlog + live messages, persist them to local SQLite, and
/// fan a [HubEvent] to every screen. The chat list paints instantly from the local
/// projection; this stream carries new + live messages on top.
class SyncHub {
  static final SyncHub I = SyncHub._();
  SyncHub._();

  final NostrClient _stub = NostrClient(kInboxWsUrl); // returned to callers (compat)
  bool _started = false;

  WebSocketChannel? _ch;
  StreamSubscription? _sub;
  Timer? _pingTimer;
  Timer? _reconnectTimer;
  bool _wantConnected = false;
  bool _connecting = false;
  int _retry = 0;
  int _cursor = 0; // highest InboxDO message id ingested (persisted per account)
  static const String _kCursorKey = 'ava_inbox_cursor';
  String? _cursorUid;       // account the in-memory _cursor was loaded for
  Timer? _cursorPersistTimer;

  final Map<String, List<DmMessage>> _byConv = {};
  final Set<String> _seen = {}; // dedup by client_id (or server id)
  bool _dbLogged = false;

  final _incoming = StreamController<HubEvent>.broadcast();
  Stream<HubEvent> get incoming => _incoming.stream;

  /// Live AvaStorage summaries pushed by the server after any upload/delete in
  /// ANY app (frame {type:'storage', used_bytes, quota_bytes, state, by_category}).
  final _storage = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get storage => _storage.stream;

  /// Live `@ava` token stream (frame {type:'ava_stream', conv, stream_id, phase,
  /// delta}). Transient — never persisted; the open chat thread grows an Ava
  /// bubble as deltas arrive, then the durable answer replaces it. Each emitted
  /// map carries a derived `convKey` so a thread can filter to its own conv.
  final _avaStream = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get avaStream => _avaStream.stream;

  String? get _myUid => AccountScope.id;

  /// Start (idempotent) the shared InboxDO socket. The priv/pub args are legacy
  /// and ignored — identity is the Clerk uid (AccountScope.id).
  NostrClient ensure(String _myPriv, String _myPub) {
    if (!_started && (_myUid?.isNotEmpty ?? false)) {
      _started = true;
      _wantConnected = true;
      _open();
      AvaLog.I.log('hub', 'InboxDO sync started for uid=${_myUid}');
    } else {
      ensureConnected();
    }
    return _stub;
  }

  void ensureConnected() {
    if (!_wantConnected) return;
    if (_ch != null) return;
    _retry = 0;
    _reconnectTimer?.cancel();
    _open();
  }

  Future<void> _open() async {
    if (_connecting || _ch != null || !_wantConnected) return;
    _connecting = true;
    try {
      final token = await ApiAuth.clerkBearer?.call();
      if (token == null || token.isEmpty) {
        AvaLog.I.log('hub', 'no Clerk token yet — retry InboxDO connect in 2s');
        _scheduleReconnect();
        return;
      }
      // Mobile DNS for the host intermittently fails (errno 7) on wifi/LTE
      // transitions — fatal for a WebSocket. Pre-resolve with a few quick retries
      // to absorb the blip instead of dropping into the long reconnect backoff.
      if (!kIsWeb) {
        final host = Uri.parse(kInboxWsUrl).host;
        if (host.isNotEmpty && !await _dnsReady(host)) {
          if (!_wantConnected) return;
          AvaLog.I.log('hub', 'DNS not ready for $host — quick retry');
          _scheduleReconnect();
          return;
        }
      }
      final url = '$kInboxWsUrl?token=${Uri.encodeQueryComponent(token)}';
      try {
        _ch = kIsWeb
            ? WebSocketChannel.connect(Uri.parse(url))
            : IOWebSocketChannel.connect(Uri.parse(url), pingInterval: const Duration(seconds: 25));
      } catch (e) {
        AvaLog.I.log('hub', 'InboxDO connect threw: $e');
        _onClosed();
        return;
      }
      _sub = _ch!.stream.listen(
        _onFrame,
        onError: (e) { AvaLog.I.log('hub', 'InboxDO socket error: $e'); _onClosed(); },
        onDone: () { AvaLog.I.log('hub', 'InboxDO socket closed'); _onClosed(); },
        cancelOnError: true,
      );
      _retry = 0;
      // Resume from the PERSISTED cursor (once per account) so we don't
      // re-download the entire backlog on every launch — the server returns
      // only messages with id > cursor. SQLite already holds the rest.
      if (_cursorUid != _myUid) {
        final raw = await DiskCache.read(_kCursorKey);
        _cursor = int.tryParse(raw ?? '') ?? 0;
        _cursorUid = _myUid;
      }
      _send({'type': 'hello', 'cursor': _cursor}); // request backlog since cursor
      _pingTimer?.cancel();
      _pingTimer = Timer.periodic(const Duration(seconds: 25), (_) => _send({'type': 'ping'}));
      AvaLog.I.log('hub', 'InboxDO connected; synced from cursor=$_cursor');
    } finally {
      _connecting = false;
    }
  }

  void _onClosed() {
    _sub?.cancel(); _sub = null;
    _pingTimer?.cancel(); _pingTimer = null;
    try { _ch?.sink.close(); } catch (_) {}
    _ch = null;
    if (_wantConnected) _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_reconnectTimer?.isActive ?? false) return;
    _retry++;
    final secs = (1 << (_retry > 5 ? 5 : _retry)).clamp(2, 30);
    _reconnectTimer = Timer(Duration(seconds: secs), _open);
  }

  void _send(Map<String, dynamic> o) {
    try { _ch?.sink.add(jsonEncode(o)); } catch (_) {}
  }

  /// Resolve [host] with a few quick retries (~5s worst case). Absorbs the
  /// transient mobile DNS failures (errno 7) that otherwise kill the socket.
  Future<bool> _dnsReady(String host) async {
    for (var i = 0; i < 5; i++) {
      if (!_wantConnected) return false;
      try {
        final r = await InternetAddress.lookup(host).timeout(const Duration(seconds: 4));
        if (r.isNotEmpty) return true;
      } catch (_) {/* transient lookup failure — retry */}
      await Future.delayed(Duration(milliseconds: 400 + 300 * i));
    }
    return false;
  }

  void _onFrame(dynamic raw) {
    Map<String, dynamic> m;
    try { m = (jsonDecode(raw as String) as Map).cast<String, dynamic>(); } catch (_) { return; }
    switch (m['type']) {
      case 'pong':
        break;
      case 'sync':
        // Apply MY read high-water marks FIRST, before any message is replayed,
        // so a full re-sync (cursor=0 on every launch) doesn't recount already-
        // read messages as unread. Restores read state on a fresh/2nd device.
        // Bulk-merge to ReadStateStore (one file write) to avoid a load-modify-
        // write race, then emit per-conv events so an open chat list updates now.
        {
          final bulk = <String, int>{};
          for (final r in (m['reads'] as List? ?? const [])) {
            final pair = _readKeyTs((r as Map).cast<String, dynamic>());
            if (pair == null) continue;
            bulk[pair.$1] = pair.$2;
            _emitRead(pair.$1, pair.$2);
          }
          if (bulk.isNotEmpty) ReadStateStore().mergeBulk(bulk);
        }
        for (final row in (m['messages'] as List? ?? const [])) {
          _ingestMsg((row as Map).cast<String, dynamic>());
        }
        for (final r in (m['receipts'] as List? ?? const [])) {
          _ingestReceipt((r as Map).cast<String, dynamic>());
        }
        break;
      case 'msg':
        _ingestMsg(m);
        break;
      case 'receipt':
        _ingestReceipt(m);
        break;
      case 'read':
        _ingestRead(m);
        break;
      case 'storage':
        // AvaStorage live summary (Phase 4): transient system event — fan to any
        // open AvaStorage screen. Same multiplexed socket, no extra connection.
        _storage.add(m);
        break;
      case 'ava_stream':
        {
          // Live @ava token preview — derive the convKey the open thread uses so
          // it can filter to its own conversation, then fan out (transient).
          final conv = (m['conv'] ?? '').toString();
          final myUid = _myUid ?? '';
          final convKey = conv.startsWith('dm_')
              ? '1:${dmPeer(conv, myUid) ?? conv}'
              : 'g:$conv';
          _avaStream.add({...m, 'convKey': convKey});
        }
        break;
    }
  }

  void _ingestMsg(Map<String, dynamic> r) {
    final id = (r['id'] as num?)?.toInt() ?? 0;
    if (id > _cursor) { _cursor = id; _scheduleCursorPersist(); }
    final conv = (r['conv'] ?? '').toString();
    final sender = (r['sender'] ?? '').toString();
    final body = (r['body'] ?? '').toString();           // our app envelope JSON
    final clientId = (r['client_id'] ?? '').toString();
    final createdMs = (r['created_at'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch;
    final createdSec = createdMs > 2000000000 ? createdMs ~/ 1000 : createdMs; // tolerate s/ms
    final rumorId = clientId.isNotEmpty ? clientId : 'srv_$id';
    if (!_seen.add(rumorId)) return; // dedup optimistic echo + re-sync

    final myUid = _myUid ?? '';
    final mine = sender == myUid;
    final convKey = conv.startsWith('dm_')
        ? '1:${dmPeer(conv, myUid) ?? sender}'
        : 'g:$conv';

    var isReceipt = false;
    try {
      final env = jsonDecode(body);
      if (env is Map && env['t'] == 'receipt') isReceipt = true;
    } catch (_) {}

    if (!isReceipt) {
      final list = _byConv.putIfAbsent(convKey, () => []);
      if (!list.any((x) => x.rumorId == rumorId)) {
        list.add(DmMessage(rumorId: rumorId, mine: mine, payload: body, createdAt: createdSec));
        try {
          Db.I.upsertMessage(MessagesCompanion.insert(
              rumorId: rumorId, convKey: convKey, mine: mine, payload: body, createdAt: createdSec));
          if (!_dbLogged) { _dbLogged = true; AvaLog.I.log('db', 'sqlite: storing messages locally ✓'); }
        } catch (_) {}
      }
    }
    _incoming.add(HubEvent(convKey, sender, myUid, mine, rumorId, body, createdSec));
  }

  void _ingestReceipt(Map<String, dynamic> r) {
    final conv = (r['conv'] ?? '').toString();
    final peer = (r['peer'] ?? '').toString();
    final readId = (r['read_id'] as num?)?.toInt();
    final deliveredId = (r['delivered_id'] as num?)?.toInt();
    final status = readId != null ? 'read' : 'delivered';
    final ts = (readId ?? deliveredId ?? 0);
    final myUid = _myUid ?? '';
    final convKey = conv.startsWith('dm_') ? '1:${dmPeer(conv, myUid) ?? peer}' : 'g:$conv';
    final payload = jsonEncode({'t': 'receipt', 'status': status, 'ts': ts});
    _incoming.add(HubEvent(convKey, peer, myUid, false, 'rcpt_${conv}_$ts', payload, ts));
  }

  /// Parse a server read row → (convKey, readSec). Null if unusable.
  (String, int)? _readKeyTs(Map<String, dynamic> r) {
    final conv = (r['conv'] ?? '').toString();
    if (conv.isEmpty) return null;
    final tsRaw = (r['read_ts'] as num?)?.toInt() ?? 0;
    if (tsRaw <= 0) return null;
    final readSec = tsRaw > 2000000000 ? tsRaw ~/ 1000 : tsRaw; // tolerate s/ms
    final myUid = _myUid ?? '';
    final convKey = conv.startsWith('dm_') ? '1:${dmPeer(conv, myUid) ?? conv}' : 'g:$conv';
    return (convKey, readSec);
  }

  /// Emit a 'read' HubEvent so an open chat list clears that conv's badge now.
  void _emitRead(String convKey, int readSec) {
    final myUid = _myUid ?? '';
    _incoming.add(HubEvent(
        convKey, myUid, myUid, true, 'read_${convKey}_$readSec',
        jsonEncode({'t': 'read', 'read_ts': readSec}), readSec));
  }

  /// A single live 'read' frame (MY read high-water, e.g. from a 2nd device).
  /// Persists to ReadStateStore + emits the event.
  void _ingestRead(Map<String, dynamic> r) {
    final pair = _readKeyTs(r);
    if (pair == null) return;
    ReadStateStore().setRead(pair.$1, pair.$2); // single conv → no bulk race
    _emitRead(pair.$1, pair.$2);
  }

  /// Persist the cursor shortly after the last message of a burst (debounced —
  /// one small file write per sync, not one per message). On the next launch we
  /// resume from here instead of re-pulling everything.
  void _scheduleCursorPersist() {
    _cursorPersistTimer?.cancel();
    _cursorPersistTimer = Timer(const Duration(seconds: 2),
        () => DiskCache.write(_kCursorKey, _cursor.toString()));
  }

  /// Messages for a conversation seen this session (instant, in-memory).
  List<DmMessage> messagesFor(String convKey) => List.of(_byConv[convKey] ?? const []);

  NostrClient? get client => _stub;
}
