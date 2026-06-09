import 'dart:async';
import 'dart:convert';
import 'dart:io' show InternetAddress;
import 'dart:math';
import 'dart:typed_data';

import 'package:bip340/bip340.dart' as bip340;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:pointycastle/export.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/io.dart';

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
///
/// SELF-HEALING: a chat client is useless if a dropped socket means a dead
/// inbox. This client therefore (1) holds the socket open with a WebSocket-level
/// keepalive ping (so NAT/edge idle-timeouts can't silently kill delivery),
/// (2) auto-reconnects with exponential backoff on any close/error, and
/// (3) re-runs NIP-42 auth and re-issues every active subscription on reconnect,
/// so live messages keep flowing without the UI doing anything. Call connect()
/// once; it stays connected until dispose(). Use ensureConnected() on app resume.
class NostrClient {
  final String relayUrl;
  WebSocketChannel? _ch;
  StreamSubscription? _sub;
  final _events = StreamController<(String subId, NostrEvent ev)>.broadcast();
  final _eose = StreamController<String>.broadcast();
  final _notifs = StreamController<Map<String, dynamic>>.broadcast();
  bool _connected = false;

  // NIP-42: the relay sends an AUTH challenge on connect and REFUSES to store or
  // serve PRIVATE kinds (DM gift-wraps 1059, seals, call signaling, DM relay
  // lists) until the socket proves key ownership with a signed kind-22242 event.
  //
  // Private frames are gated on a REAL NIP-42 success (`_socketAuthed`), queued
  // until then, and every publish result (accepted/rejected) is surfaced so the
  // UI can never show a false "sent".
  static const Set<int> privateKinds = {13, 14, 1059, 25050, 10050, 10443};
  bool _socketAuthed = false; // true ONLY after the relay accepts our AUTH
  bool _hasIdentity = false;  // can we NIP-42 auth at all?
  String? _authEventId;
  final List<List<dynamic>> _privateQueue = []; // private frames awaiting AUTH

  // --- resilience: keepalive + auto-reconnect + subscription replay ---
  bool _wantConnected = false; // user intent: stay connected until dispose()
  bool _disposed = false;
  int _retry = 0;
  Timer? _reconnectTimer;
  static const Duration _keepalive = Duration(seconds: 25);
  static const int _maxBackoffSecs = 30;

  /// Active subscriptions (subId → filters). Re-issued verbatim after every
  /// reconnect so a dropped socket never means a dead inbox.
  final Map<String, List<Map<String, dynamic>>> _subs = {};

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

  /// Connect and KEEP connected (auto-reconnecting) until dispose().
  void connect() {
    _wantConnected = true;
    _openSocket();
  }

  /// Force an immediate connectivity check — call on app resume. Resets the
  /// backoff so a foregrounded app reconnects instantly rather than waiting out
  /// a long backoff window from while it was suspended.
  void ensureConnected() {
    if (_disposed) return;
    _wantConnected = true;
    if (_connected) return;
    _retry = 0;
    _reconnectTimer?.cancel();
    _openSocket();
  }

  bool _opening = false; // guards re-entry while the async DNS pre-resolve runs

  Future<void> _openSocket() async {
    if (_disposed || _connected || _opening) return;
    _opening = true;
    try {
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

      // DNS pre-resolve (tiny Happy-Eyeballs-style wrapper). Mobile DNS
      // intermittently fails to resolve the relay host (errno 7) on wifi/LTE
      // transitions; resolving with a few quick retries here absorbs that blip
      // instead of letting the connect fail and inflate the reconnect backoff to
      // ~30s. Resolves both IPv4 + IPv6. Web: the browser handles DNS.
      if (!kIsWeb) {
        final host = Uri.parse(relayUrl).host;
        if (host.isNotEmpty && !await _dnsReady(host)) {
          if (_disposed || _connected || !_wantConnected) return;
          AvaLog.I.log('relay', 'DNS not ready for $host — quick retry in 1.5s');
          _reconnectTimer?.cancel();
          _reconnectTimer = Timer(const Duration(milliseconds: 1500), _openSocket);
          return;
        }
      }
      if (_disposed || _connected) return; // state may have changed during async DNS

      AvaLog.I.log('relay',
          'connect (hasIdentity=$_hasIdentity)${_retry > 0 ? " [reconnect #$_retry]" : ""}');
      try {
        // Non-web: a WebSocket-level ping every 25s keeps the connection alive
        // through NAT/edge idle timeouts AND detects a dead socket (a missing pong
        // closes it → onDone → reconnect). On web the browser handles pings.
        _ch = kIsWeb
            ? WebSocketChannel.connect(Uri.parse(url))
            : IOWebSocketChannel.connect(Uri.parse(url), pingInterval: _keepalive);
      } catch (e) {
        AvaLog.I.log('relay', 'connect threw: $e');
        _onClosed();
        return;
      }
      _connected = true;
      _sub = _ch!.stream.listen(
        _onMessage,
        onError: (e) { AvaLog.I.log('relay', 'socket error: $e'); _onClosed(); },
        onDone: () { AvaLog.I.log('relay', 'socket closed'); _onClosed(); },
        cancelOnError: true,
      );
      // Re-issue any tracked subscriptions immediately. Public ones flow now;
      // private ones are queued and flushed when AUTH succeeds below.
      _resubscribe();
    } finally {
      _opening = false;
    }
  }

  /// Resolve [host] with a few quick retries (~5s worst case). Returns true as
  /// soon as it resolves. Absorbs transient mobile DNS failures so they don't
  /// trip the long socket reconnect backoff.
  Future<bool> _dnsReady(String host) async {
    for (var i = 0; i < 5; i++) {
      if (_disposed || !_wantConnected) return false;
      try {
        final r = await InternetAddress.lookup(host).timeout(const Duration(seconds: 4));
        if (r.isNotEmpty) return true;
      } catch (_) {/* transient lookup failure — retry */}
      await Future.delayed(Duration(milliseconds: 400 + 300 * i));
    }
    return false;
  }

  void _onClosed() {
    _connected = false;
    _socketAuthed = false;
    _sub?.cancel();
    _sub = null;
    if (_wantConnected && !_disposed) _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_reconnectTimer?.isActive ?? false) return;
    _retry++;
    // Exponential backoff capped at 30s, with jitter to avoid thundering herds.
    final secs = min(_maxBackoffSecs, 1 << min(_retry, 5)); // 2,4,8,16,32→30
    final delay = Duration(milliseconds: secs * 1000 + Random().nextInt(1000));
    AvaLog.I.log('relay', 'reconnect attempt #$_retry in ${delay.inMilliseconds}ms');
    _reconnectTimer = Timer(delay, _openSocket);
  }

  void _onMessage(dynamic raw) {
    try {
      final d = jsonDecode(raw as String) as List;
      // Any well-formed frame proves the link is alive → reset backoff.
      if (_retry != 0) _retry = 0;
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
            // Our NIP-42 auth result. On success, unlock + flush + resubscribe.
            AvaLog.I.log('relay', 'AUTH ${accepted ? "accepted ✓" : "REJECTED ✗ ($okMsg)"}');
            if (accepted && !_socketAuthed) {
              _socketAuthed = true;
              // _openSocket() already re-issued every tracked sub on connect:
              // public ones went out immediately, private ones were queued — so
              // flushing the queue here replays the private subs exactly once.
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

  void subscribe(String subId, List<Map<String, dynamic>> filters) {
    _subs[subId] = filters; // track for replay across reconnects
    _send(['REQ', subId, ...filters], private: _filtersArePrivate(filters));
  }

  void closeSub(String subId) {
    _subs.remove(subId);
    _send(['CLOSE', subId]);
  }

  bool _filtersArePrivate(List<Map<String, dynamic>> filters) => filters.any(
      (f) => ((f['kinds'] as List?) ?? const []).any((k) => privateKinds.contains(k)));

  /// Re-issue every tracked subscription on (re)connect. Public subs flow
  /// immediately; private subs queue until NIP-42 auth then flush.
  void _resubscribe() {
    if (_subs.isEmpty) return;
    AvaLog.I.log('relay', 'resubscribing ${_subs.length} sub(s)');
    _subs.forEach((subId, filters) {
      _send(['REQ', subId, ...filters], private: _filtersArePrivate(filters));
    });
  }

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
      // Don't pile up duplicate REQ frames for the same sub while waiting on auth.
      final isReq = o.isNotEmpty && o[0] == 'REQ';
      if (isReq) {
        _privateQueue.removeWhere((q) => q.isNotEmpty && q[0] == 'REQ' && q.length > 1 && q[1] == o[1]);
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
    _disposed = true;
    _wantConnected = false;
    _reconnectTimer?.cancel();
    _sub?.cancel();
    try { _ch?.sink.close(); } catch (_) {}
    _events.close();
    _eose.close();
    _notifs.close();
    try { _publishC.close(); } catch (_) {}
    _connected = false;
  }
}
