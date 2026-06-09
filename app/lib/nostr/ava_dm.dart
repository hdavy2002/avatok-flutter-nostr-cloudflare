import 'dart:async';
import 'dart:convert';
import 'dart:math';

import '../core/ava_log.dart';
import '../core/api_auth.dart';
import '../core/config.dart';
import '../core/db.dart';
import '../identity/identity.dart';
import 'nostr_client.dart';
import 'relay_hub.dart';

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
/// shared InboxDO socket in [RelayHub], filtered to this conversation. [peerPub]
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

  AvaDm({required this.client, required this.myPriv, required this.myPub, required this.peerPub});

  Stream<DmMessage> get messages => _controller.stream;
  Stream<({String rumorId, bool ok, String message})> get sendStatus => _statusC.stream;

  String get _myUid => AccountScope.id ?? myPub;
  String get _conv => dmConvId(_myUid, peerPub);

  void start() {
    final myConv = '1:$peerPub';
    _sub = RelayHub.I.incoming.where((e) => e.convKey == myConv).listen((e) {
      if (!_controller.isClosed) _controller.add(e.toDm());
    });
  }

  /// Send [payload] (an app envelope JSON string) to the peer. Write-to-DB-first
  /// for instant UI; POST to the router; the InboxDO echo re-inserts (no-op).
  /// Returns the client_id (used as the optimistic-echo dedupe key).
  String send(String payload) {
    final clientId = _randId();
    try {
      Db.I.upsertMessage(MessagesCompanion.insert(
          rumorId: clientId, convKey: '1:$peerPub', mine: true, payload: payload,
          createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000));
    } catch (_) {}
    unawaited(_post(clientId, payload));
    return clientId;
  }

  Future<void> _post(String clientId, String payload) async {
    try {
      final res = await ApiAuth.postJson(kMsgSendUrl, {
        'to': peerPub, 'kind': 'text', 'body': payload, 'client_id': clientId,
      });
      final ok = res.statusCode == 200;
      if (!ok) AvaLog.I.log('dm', 'send FAILED ${res.statusCode}: ${res.body}');
      if (!_statusC.isClosed) _statusC.add((rumorId: clientId, ok: ok, message: ok ? '' : 'http ${res.statusCode}'));
    } catch (e) {
      if (!_statusC.isClosed) _statusC.add((rumorId: clientId, ok: false, message: '$e'));
    }
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
    _controller.close();
    if (!_statusC.isClosed) _statusC.close();
  }

  static String _randId() {
    final r = Random.secure();
    return 'ct_' + List<int>.generate(12, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}
