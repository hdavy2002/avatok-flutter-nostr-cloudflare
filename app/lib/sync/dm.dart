import 'dart:async';
import 'dart:convert';
import 'dart:math';

import '../core/api_auth.dart';
import '../core/config.dart';
import '../core/db.dart';
import '../identity/identity.dart';
import 'legacy_stubs.dart';
import 'outbox.dart';
import 'sync_hub.dart';

/// A delivered 1:1 message (payload is our app envelope JSON: text or media).
class DmMessage {
  final String rumorId;
  final bool mine;
  final String payload;
  final int createdAt;
  DmMessage({required this.rumorId, required this.mine, required this.payload, required this.createdAt});
}

/// 1:1 messaging over the Cloudflare-native backend (Nostr deprecated). Sends go
/// out over HTTP (POST /api/msg/send); incoming + live messages arrive via the
/// shared InboxDO socket in [SyncHub], filtered to this conversation. [peerPub]
/// now carries the peer's Clerk uid (addressing id). [client]/[myPriv]/[myPub]
/// are legacy params kept for call-site compatibility and ignored.
class AvaDm {
  final NostrClient client;
  final String myPriv;
  final String myPub;
  final String peerPub; // peer Clerk uid
  StreamSubscription? _sub;
  final _controller = StreamController<DmMessage>.broadcast();
  final _statusC = StreamController<({String rumorId, bool ok, String message})>.broadcast();

  StreamSubscription? _outboxSub;

  AvaDm({required this.client, required this.myPriv, required this.myPub, required this.peerPub});

  Stream<DmMessage> get messages => _controller.stream;
  Stream<({String rumorId, bool ok, String message})> get sendStatus => _statusC.stream;

  String get _myUid => AccountScope.id ?? myPub;
  String get _conv => dmConvId(_myUid, peerPub);
  String get _convKey => '1:$peerPub';

  void start() {
    final myConv = _convKey;
    _sub = SyncHub.I.incoming.where((e) => e.convKey == myConv).listen((e) {
      if (!_controller.isClosed) _controller.add(e.toDm());
    });
    // [MSG-OUTBOX-1] The durable outbox performs the actual POST + retries; relay
    // its per-message results into this thread's sendStatus so the bubble shows
    // "sending…" → "sent" / "not sent". Filter to THIS conversation so a shared
    // singleton doesn't leak another thread's status here.
    _outboxSub = Outbox.I.status.where((s) => s.convKey == myConv).listen((s) {
      if (!_statusC.isClosed) _statusC.add((rumorId: s.clientId, ok: s.ok, message: s.message));
    });
    // A thread open is also a retry trigger: flush anything still queued (e.g. a
    // message that failed while the app was backgrounded).
    unawaited(Outbox.I.drain(reason: 'thread_open'));
  }

  /// Send [payload] (an app envelope JSON string) to the peer. Write-to-DB-first
  /// for instant UI, ENQUEUE to the durable outbox (survives restart), then let the
  /// outbox POST + retry until the router ACKs. The InboxDO echo re-inserts (no-op,
  /// deduped by client_id). Returns the client_id (the optimistic-echo dedupe key).
  ///
  /// [MSG-OUTBOX-1] The old path did a fire-and-forget POST with no retry/outbox;
  /// on a flaky link the send failed, the bubble was marked failed, and the failed
  /// message was then dropped from the warm cache → it vanished on reopen and the
  /// peer never got it. Enqueue-first makes the send durable and self-retrying.
  String send(String payload) {
    final clientId = _randId();
    try {
      Db.I.upsertMessage(MessagesCompanion.insert(
          rumorId: clientId, convKey: _convKey, mine: true, payload: payload,
          createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000));
    } catch (_) {}
    unawaited(Outbox.I.enqueue(
      clientId: clientId, to: peerPub, payload: payload, convKey: _convKey, kind: 'text',
    ));
    return clientId;
  }

  /// Send a delivery/read receipt to the peer. [status] is 'delivered' or 'read';
  /// [ts] is the high-water mark this acknowledges.
  void sendReceipt(String status, int ts) {
    if (ts <= 0) return;
    final body = <String, dynamic>{'conv': _conv, 'peer': peerPub};
    if (status == 'read') body['read_id'] = ts; else body['delivered_id'] = ts;
    unawaited(ApiAuth.postJson(kMsgReceiptUrl, body).then((_) {}, onError: (_) {}));
  }

  void stop() {
    _sub?.cancel();
    // [MSG-OUTBOX-1] Only cancel THIS thread's subscription — the Outbox singleton
    // and its queue keep running so a message still in flight (or queued for retry)
    // continues to send after the thread closes.
    _outboxSub?.cancel();
    _controller.close();
    if (!_statusC.isClosed) _statusC.close();
  }

  static String _randId() {
    final r = Random.secure();
    return 'ct_' + List<int>.generate(12, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}
