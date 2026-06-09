import 'dart:async';
import 'dart:convert';

import '../core/ava_log.dart';
import 'nip17.dart';
import 'nostr_client.dart';

/// A delivered 1:1 message (payload is our app envelope JSON: text or media).
class DmMessage {
  final String rumorId;
  final bool mine;
  final String payload;
  final int createdAt;
  DmMessage({required this.rumorId, required this.mine, required this.payload, required this.createdAt});
}

/// Real, metadata-private 1:1 messaging via NIP-17 gift wrap over the AvaTok
/// relay. We subscribe to kind-1059 gifts addressed to us, unwrap locally, and
/// keep only this conversation (peer ↔ me).
class AvaDm {
  final NostrClient client;
  final String myPriv;  // hex
  final String myPub;   // hex (x-only)
  final String peerPub; // hex (x-only)
  final String _subId;
  StreamSubscription? _sub;
  StreamSubscription? _pubSub;
  final _controller = StreamController<DmMessage>.broadcast();

  // Map each published gift-wrap event id back to its rumor id, so a relay
  // OK/rejection can be reported against the message the user sees.
  final Map<String, String> _giftToRumor = {};
  final _statusC = StreamController<({String rumorId, bool ok, String message})>.broadcast();

  AvaDm({required this.client, required this.myPriv, required this.myPub, required this.peerPub})
      : _subId = 'gw-${peerPub.substring(0, 8)}';

  Stream<DmMessage> get messages => _controller.stream;

  /// Delivery status of our own sends (the relay accepted/rejected the wrap).
  Stream<({String rumorId, bool ok, String message})> get sendStatus => _statusC.stream;

  void start() {
    client.connect();
    // Relay accept/reject of our gift wraps → per-message send status.
    _pubSub = client.publishResults.listen((r) {
      final rid = _giftToRumor[r.id];
      if (rid == null) return;
      if (!r.accepted) {
        AvaLog.I.log('dm', 'send FAILED rumor=${rid.substring(0, 8)}: ${r.message}');
      }
      if (!_statusC.isClosed) _statusC.add((rumorId: rid, ok: r.accepted, message: r.message));
    });
    _sub = client.events.listen((rec) {
      final (subId, ev) = rec;
      if (subId != _subId || ev.kind != 1059) return;
      final u = Nip17.unwrap(myPriv, ev);
      if (u == null) return;
      final fromPeer = u.senderPub == peerPub && u.recipientPub == myPub;
      final fromMe = u.senderPub == myPub && u.recipientPub == peerPub;
      if (!fromPeer && !fromMe) return; // different conversation
      _controller.add(DmMessage(
          rumorId: u.rumorId, mine: fromMe, payload: u.payload, createdAt: u.createdAt));
    });
    // All gifts addressed to me; we unwrap + filter to this peer locally.
    client.subscribe(_subId, [
      {'kinds': [1059], '#p': [myPub], 'limit': 500},
    ]);
  }

  /// Encrypt + gift-wrap [payload] to the peer (and a copy to myself).
  /// Returns the rumor id for optimistic-echo dedupe.
  String send(String payload) {
    final (gifts, rumorId) = Nip17.wrapBoth(
        senderPriv: myPriv, senderPub: myPub, peerPub: peerPub, payload: payload);
    for (final g in gifts) {
      _giftToRumor[g.id] = rumorId;
      client.publish(g);
    }
    AvaLog.I.log('dm', 'send rumor=${rumorId.substring(0, 8)} (${gifts.length} wraps), authed=${client.isAuthed}');
    return rumorId;
  }

  /// Send a durable, gift-wrapped delivery/read receipt to the peer (no self
  /// copy, so it can't loop back to us). [status] is 'delivered' or 'read';
  /// [ts] is the newest message timestamp this acknowledges (a high-water mark).
  /// Because it's a normal gift wrap it persists on the relay and the original
  /// sender picks it up whenever they reconnect — receipts survive restarts.
  void sendReceipt(String status, int ts) {
    if (ts <= 0) return;
    final (gift, _) = Nip17.wrapTo(
        senderPriv: myPriv, senderPub: myPub, recipientPub: peerPub,
        payload: jsonEncode({'t': 'receipt', 'status': status, 'ts': ts}));
    client.publish(gift);
  }

  void stop() {
    try { client.closeSub(_subId); } catch (_) {}
    _sub?.cancel();
    _pubSub?.cancel();
    _controller.close();
    if (!_statusC.isClosed) _statusC.close();
  }
}
