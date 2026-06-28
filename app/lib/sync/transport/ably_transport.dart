import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:ably_flutter/ably_flutter.dart' as ably;

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../core/db.dart'; // exports MessagesCompanion (drift) + Db.I
import '../../identity/identity.dart';
import 'ava_transport.dart';

/// Ably implementation of [AvaTransport] (iOS + Android only — see selector in
/// ava_transport.dart). Architecture (hybrid, keeps server-readability):
///
///   • DURABLE MESSAGES — sending still POSTs the Worker (`/api/msg/send`) so
///     moderation, block rules, AvaBrain ingestion and offline FCM are untouched.
///     The Worker publishes the stored message to Ably `msg:<conv>`; this client
///     subscribes there for INSTANT live receive (Ably's global edge handles
///     fan-out + reconnection, replacing the flaky single InboxDO socket).
///
///   • EPHEMERAL REALTIME — typing, presence (online/last-seen) and delivered/
///     read receipts go CLIENT↔ABLY DIRECTLY (no server hop), on dedicated
///     `typing:<conv>` / `presence:<uid>` / `meta:<conv>` channels. This is the
///     layer that was unreliable on the InboxDO socket; on Ably it is snappy and
///     never clogs the message path.
///
/// Auth: an `authCallback` fetches a short-lived Ably JWT from the Worker
/// (`/api/ably/token`, Clerk-gated) — no API key ever ships in the app. The JWT
/// pins clientId = AccountScope.id and room-scoped capabilities.
class AblyTransport extends AvaTransport {
  AblyTransport(this.myUid);

  final String myUid;

  ably.Realtime? _realtime;
  bool _started = false;

  // conv channels we've subscribed to, keyed by serverConv → subs to cancel.
  final Map<String, List<StreamSubscription>> _convSubs = {};
  ably.RealtimeChannel? _presenceCh;
  final Set<String> _presenceWatched = {};

  final _messages = StreamController<TransportMessage>.broadcast();
  final _typing = StreamController<TypingEvent>.broadcast();
  final _presence = StreamController<PresenceEvent>.broadcast();
  final _receipts = StreamController<ReceiptEvent>.broadcast();
  // Phase 4 (ABLY-R2): live reactions / bursts / occupancy.
  final _reactions = StreamController<ReactionEvent>.broadcast();
  final _bursts = StreamController<BurstEvent>.broadcast();
  final _occupancy = StreamController<OccupancyEvent>.broadcast();
  final Set<String> _roomsWatched = {};
  final _seen = <String>{};
  // clientId → send time (ms), for the publish→own-echo roundtrip metric.
  final Map<String, int> _sentAt = {};

  // Telemetry: when the current connection came up, and reconnect tally.
  int _connectedAt = 0;
  int _reconnects = 0;

  @override
  Stream<TransportMessage> get messages => _messages.stream;
  @override
  Stream<TypingEvent> get typing => _typing.stream;
  @override
  Stream<PresenceEvent> get presence => _presence.stream;
  @override
  Stream<ReceiptEvent> get receipts => _receipts.stream;
  @override
  Stream<ReactionEvent> get reactions => _reactions.stream;
  @override
  Stream<BurstEvent> get bursts => _bursts.stream;
  @override
  Stream<OccupancyEvent> get occupancy => _occupancy.stream;

  @override
  Future<void> start() async {
    if (_started) return;
    _started = true;
    try {
      final opts = ably.ClientOptions(
        authCallback: (ably.TokenParams params) async => _mintToken(),
        clientId: myUid,
        logLevel: ably.LogLevel.error,
        // Resume cleanly across network flaps; Ably handles backoff internally.
        disconnectedRetryTimeout: 2000,
        suspendedRetryTimeout: 5000,
      );
      final rt = ably.Realtime(options: opts);
      _realtime = rt;
      _wireConnection(rt);
      // Subscribe to every conversation already on this device so the chat list
      // updates live even when a thread isn't open (parity with InboxDO fan-in).
      await _subscribeKnownConversations();
      // Enter our own presence so peers see us online.
      setOnline(true);
      AvaLog.I.log('ably', 'AblyTransport started for uid=$myUid');
    } catch (e) {
      Analytics.capture('ably_start_failed', {'err': e.toString()});
      AvaLog.I.log('ably', 'start failed: $e');
    }
  }

  /// authCallback: fetch a short-lived Ably JWT from the Worker (Clerk bearer).
  Future<ably.TokenDetails> _mintToken() async {
    final t0 = DateTime.now().millisecondsSinceEpoch;
    try {
      final res = await ApiAuth.postJson(kAblyTokenUrl, const {});
      if (res.statusCode != 200) {
        Analytics.capture('ably_token_mint_failed', {'status': res.statusCode});
        throw Exception('ably token ${res.statusCode}');
      }
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final jwt = (body['token'] ?? '').toString();
      Analytics.capture('ably_token_minted', {
        'ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      // A JWT supplied as an Ably token literal.
      return ably.TokenDetails(jwt);
    } catch (e) {
      Analytics.capture('ably_token_mint_error', {'err': e.toString()});
      rethrow;
    }
  }

  void _wireConnection(ably.Realtime rt) {
    rt.connection.on().listen((ably.ConnectionStateChange c) {
      switch (c.current) {
        case ably.ConnectionState.connected:
          _connectedAt = DateTime.now().millisecondsSinceEpoch;
          Analytics.capture('ably_connected', {'reconnects': _reconnects});
          break;
        case ably.ConnectionState.disconnected:
        case ably.ConnectionState.suspended:
          _reconnects++;
          final up = _connectedAt > 0
              ? DateTime.now().millisecondsSinceEpoch - _connectedAt
              : 0;
          _connectedAt = 0;
          Analytics.capture('ably_disconnected', {
            'state': c.current.toString(),
            'uptime_ms': up,
            'reconnects': _reconnects,
          });
          break;
        case ably.ConnectionState.failed:
          Analytics.capture('ably_connection_failed', {
            'reason': c.reason?.message ?? 'unknown',
          });
          break;
        default:
          break;
      }
    });
  }

  Future<void> _subscribeKnownConversations() async {
    List<String> convKeys;
    try {
      final chats = await Db.I.chatsOnce();
      convKeys = chats.map((c) => c.convKey).toList();
    } catch (_) {
      convKeys = const [];
    }
    for (final key in convKeys) {
      final sc = serverConvFromKey(key, myUid);
      if (sc != null) subscribeConversation(sc);
    }
  }

  /// Subscribe to a conversation's message + meta channels (idempotent). Called
  /// for known convs at startup and when a new thread is opened/created.
  void subscribeConversation(String serverConv) {
    if (_convSubs.containsKey(serverConv)) return;
    final rt = _realtime;
    if (rt == null) return;
    final subs = <StreamSubscription>[];

    // Durable messages (published by the Worker after moderation).
    final msgCh = rt.channels.get(ablyMsgChannel(serverConv));
    subs.add(msgCh.subscribe(name: 'msg').listen((m) => _onMessage(serverConv, m)));

    // Receipts + tombstones (peer-published, ephemeral side channel).
    final metaCh = rt.channels.get(ablyMetaChannel(serverConv));
    subs.add(metaCh.subscribe().listen((m) => _onMeta(serverConv, m)));

    // Typing.
    final typeCh = rt.channels.get(ablyTypingChannel(serverConv));
    subs.add(typeCh.subscribe(name: 'typing').listen((m) => _onTyping(serverConv, m)));

    // Phase 4: live per-message reactions + ephemeral floating-emoji bursts.
    final reactCh = rt.channels.get(ablyReactChannel(serverConv));
    subs.add(reactCh.subscribe(name: 'react').listen((m) => _onReaction(serverConv, m)));
    final burstCh = rt.channels.get(ablyBurstChannel(serverConv));
    subs.add(burstCh.subscribe(name: 'burst').listen((m) => _onBurst(serverConv, m)));

    _convSubs[serverConv] = subs;
  }

  void _onReaction(String serverConv, ably.Message m) {
    try {
      if ((m.clientId ?? '') == myUid) return; // ignore my own echo (already shown locally)
      final data = _asMap(m.data);
      _reactions.add(ReactionEvent(
        _convKeyFor(serverConv),
        (data['target'] ?? '').toString(),
        (m.clientId ?? data['who'] ?? '').toString(),
        (data['emoji'] ?? '').toString(),
        data['add'] != false,
      ));
    } catch (e) { AvaLog.I.log('ably', 'onReaction err: $e'); }
  }

  void _onBurst(String serverConv, ably.Message m) {
    try {
      if ((m.clientId ?? '') == myUid) return;
      final data = _asMap(m.data);
      _bursts.add(BurstEvent(
        _convKeyFor(serverConv), (m.clientId ?? '').toString(), (data['emoji'] ?? '').toString()));
    } catch (e) { AvaLog.I.log('ably', 'onBurst err: $e'); }
  }

  String _convKeyFor(String serverConv) =>
      serverConv.startsWith('dm_') ? '1:${dmPeer(serverConv, myUid) ?? serverConv}' : 'g:$serverConv';

  void _onMessage(String serverConv, ably.Message m) {
    try {
      final data = _asMap(m.data);
      final sender = (data['sender'] ?? m.clientId ?? '').toString();
      final body = (data['body'] ?? '').toString();
      final clientId = (data['client_id'] ?? m.id ?? '').toString();
      final rumorId = clientId.isNotEmpty ? clientId : 'srv_${m.id}';
      if (!_seen.add(rumorId)) return; // dedup optimistic echo + redelivery
      // Roundtrip metric: time from local send → the message coming back live
      // over Ably. A direct, per-device read on realtime delivery speed (the core
      // "chat takes forever" complaint). Auto-tagged with email by Analytics.
      final sentAt = _sentAt.remove(rumorId);
      if (sentAt != null) {
        Analytics.capture('ably_send_roundtrip', {
          'ms': DateTime.now().millisecondsSinceEpoch - sentAt,
        });
      }
      final createdMs = (data['created_at'] as num?)?.toInt() ??
          m.timestamp?.millisecondsSinceEpoch ??
          DateTime.now().millisecondsSinceEpoch;
      final createdSec = createdMs > 2000000000 ? createdMs ~/ 1000 : createdMs;
      final mine = sender == myUid;
      final convKey = _convKeyFor(serverConv);
      // Persist locally (drift remains the on-device source of truth).
      try {
        Db.I.upsertMessage(MessagesCompanion.insert(
            rumorId: rumorId, convKey: convKey, mine: mine, payload: body, createdAt: createdSec));
      } catch (_) {}
      _messages.add(TransportMessage(convKey, sender, mine, rumorId, body, createdSec));
    } catch (e) {
      AvaLog.I.log('ably', 'onMessage parse err: $e');
    }
  }

  void _onMeta(String serverConv, ably.Message m) {
    try {
      final data = _asMap(m.data);
      final t = (data['t'] ?? m.name ?? '').toString();
      final convKey = _convKeyFor(serverConv);
      if (t == 'receipt') {
        final status = (data['status'] ?? 'delivered').toString();
        final ts = (data['ts'] as num?)?.toInt() ?? 0;
        if ((m.clientId ?? '') == myUid) return; // ignore my own echo
        // Receipt lag: how long after the message timestamp the tick landed.
        final tsMs = ts > 2000000000 ? ts : ts * 1000;
        Analytics.capture('ably_receipt_lag', {
          'status': status,
          'ms': DateTime.now().millisecondsSinceEpoch - tsMs,
        });
        _receipts.add(ReceiptEvent(convKey, status, ts));
      } else if (t == 'del' || t == 'gdel') {
        // Surface delete-for-everyone as a control message the thread applies.
        _messages.add(TransportMessage(
            convKey, m.clientId ?? '', false, 'del_${data['target']}',
            jsonEncode({'t': 'del', 'target': data['target']}),
            DateTime.now().millisecondsSinceEpoch ~/ 1000));
      }
    } catch (e) {
      AvaLog.I.log('ably', 'onMeta parse err: $e');
    }
  }

  void _onTyping(String serverConv, ably.Message m) {
    final who = (m.clientId ?? '').toString();
    if (who == myUid) return;
    final data = _asMap(m.data);
    final on = data['on'] == true;
    _typing.add(TypingEvent(_convKeyFor(serverConv), who, on));
  }

  @override
  String sendText(String convKey, String payload) {
    final clientId = _randId();
    _sentAt[clientId] = DateTime.now().millisecondsSinceEpoch; // roundtrip start
    // Optimistic local write for instant UI (drift is the on-device truth).
    try {
      Db.I.upsertMessage(MessagesCompanion.insert(
          rumorId: clientId, convKey: convKey, mine: true, payload: payload,
          createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000));
    } catch (_) {}
    // Ensure we're subscribed to this conv's channels for the live echo + replies.
    final sc = serverConvFromKey(convKey, myUid);
    if (sc != null) subscribeConversation(sc);
    // Send through the Worker (moderation / blocks / AvaBrain / offline FCM).
    unawaited(_postSend(convKey, clientId, payload));
    return clientId;
  }

  Future<void> _postSend(String convKey, String clientId, String payload) async {
    try {
      final isDm = convKey.startsWith('1:');
      final body = <String, dynamic>{
        'kind': 'text', 'body': payload, 'client_id': clientId,
        if (isDm) 'to': convKey.substring(2) else 'conv': convKey.substring(2),
      };
      final res = await ApiAuth.postJson(kMsgSendUrl, body);
      if (res.statusCode != 200) {
        Analytics.capture('ably_send_post_failed', {'status': res.statusCode});
      }
    } catch (e) {
      Analytics.capture('ably_send_post_error', {'err': e.toString()});
    }
  }

  @override
  void sendReceipt(String convKey, String status, int ts) {
    if (ts <= 0) return;
    final sc = serverConvFromKey(convKey, myUid);
    if (sc == null) return;
    final rt = _realtime;
    if (rt == null) return;
    // Direct peer delivery over the meta channel (instant double-tick).
    try {
      rt.channels.get(ablyMetaChannel(sc)).publish(
          name: 'receipt', data: jsonEncode({'t': 'receipt', 'status': status, 'ts': ts}));
    } catch (_) {}
    // Also persist MY read high-water server-side for multi-device restore.
    if (status == 'read') {
      unawaited(ApiAuth.postJson(kMsgReadUrl, {'conv': sc, 'read_ts': ts})
          .then((_) {}, onError: (_) {}));
    }
  }

  Timer? _typingStop;
  @override
  void setTyping(String convKey, bool on) {
    final sc = serverConvFromKey(convKey, myUid);
    final rt = _realtime;
    if (sc == null || rt == null) return;
    try {
      rt.channels.get(ablyTypingChannel(sc))
          .publish(name: 'typing', data: jsonEncode({'on': on}));
    } catch (_) {}
    // Auto-stop after 5s so a dropped "stop" never leaves a stuck indicator.
    _typingStop?.cancel();
    if (on) {
      _typingStop = Timer(const Duration(seconds: 5), () => setTyping(convKey, false));
    }
  }

  @override
  void setOnline(bool online) {
    final rt = _realtime;
    if (rt == null) return;
    try {
      _presenceCh ??= rt.channels.get(ablyPresenceChannel(myUid));
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      if (online) {
        _presenceCh!.presence.enter({'ts': now});
      } else {
        _presenceCh!.presence.leave({'ts': now});
      }
    } catch (_) {}
  }

  /// Watch a peer's presence channel to render their online / last-seen state.
  void watchPresence(String uid) {
    if (uid.isEmpty || uid == myUid || !_presenceWatched.add(uid)) return;
    final rt = _realtime;
    if (rt == null) return;
    final ch = rt.channels.get(ablyPresenceChannel(uid));
    ch.presence.subscribe().listen((ably.PresenceMessage p) {
      final online = p.action == ably.PresenceAction.enter ||
          p.action == ably.PresenceAction.present ||
          p.action == ably.PresenceAction.update;
      final data = _asMap(p.data);
      final lastSeen = (data['ts'] as num?)?.toInt() ??
          (p.timestamp != null ? p.timestamp!.millisecondsSinceEpoch ~/ 1000 : 0);
      _presence.add(PresenceEvent(uid, online, online ? 0 : lastSeen));
    });
  }

  // ── Phase 4: reactions · bursts · occupancy (live overrides) ───────────────
  @override
  Future<void> sendReaction(String convKey, String myUid, String targetSerial,
      String emoji, {bool add = true}) async {
    // Publish live to react:<conv> for instant peer feedback…
    final sc = serverConvFromKey(convKey, myUid);
    final rt = _realtime;
    if (sc != null && rt != null) {
      try {
        rt.channels.get(ablyReactChannel(sc)).publish(
            name: 'react', data: jsonEncode({'target': targetSerial, 'emoji': emoji, 'add': add}));
      } catch (_) {}
    }
    // …then persist durably via the worker (base implementation).
    await super.sendReaction(convKey, myUid, targetSerial, emoji, add: add);
  }

  @override
  void sendBurst(String convKey, String emoji) {
    final sc = serverConvFromKey(convKey, myUid);
    final rt = _realtime;
    if (sc == null || rt == null) return;
    try {
      rt.channels.get(ablyBurstChannel(sc)).publish(name: 'burst', data: jsonEncode({'emoji': emoji}));
      Analytics.capture('chat_burst_sent', {'emoji': emoji});
    } catch (_) {}
  }

  @override
  void watchOccupancy(String convKey) {
    final sc = serverConvFromKey(convKey, myUid);
    final rt = _realtime;
    if (sc == null || rt == null || !_roomsWatched.add(sc)) return;
    final ch = rt.channels.get(ablyRoomChannel(sc));
    try {
      ch.presence.enter({'ts': DateTime.now().millisecondsSinceEpoch ~/ 1000});
      ch.presence.subscribe().listen((_) async {
        try {
          final members = await ch.presence.get();
          _occupancy.add(OccupancyEvent(_convKeyFor(sc), members.length));
        } catch (_) {}
      });
    } catch (_) {}
  }

  @override
  void onResumed() {
    // ably-flutter auto-reconnects; nudge a connect in case it was suspended.
    try { _realtime?.connect(); } catch (_) {}
    setOnline(true);
  }

  @override
  void dispose() {
    for (final subs in _convSubs.values) {
      for (final s in subs) { s.cancel(); }
    }
    _convSubs.clear();
    try { setOnline(false); } catch (_) {}
    try { _realtime?.close(); } catch (_) {}
    _messages.close();
    _typing.close();
    _presence.close();
    _receipts.close();
    _reactions.close();
    _bursts.close();
    _occupancy.close();
  }

  static Map<String, dynamic> _asMap(Object? data) {
    if (data is Map) return data.cast<String, dynamic>();
    if (data is String) {
      try {
        final d = jsonDecode(data);
        if (d is Map) return d.cast<String, dynamic>();
      } catch (_) {}
    }
    return const {};
  }

  static String _randId() {
    final r = Random.secure();
    return 'ct_' +
        List<int>.generate(12, (_) => r.nextInt(256))
            .map((b) => b.toRadixString(16).padLeft(2, '0'))
            .join();
  }
}
