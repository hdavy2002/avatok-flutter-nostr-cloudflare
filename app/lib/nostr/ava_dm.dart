import 'dart:async';

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
  final _controller = StreamController<DmMessage>.broadcast();

  AvaDm({required this.client, required this.myPriv, required this.myPub, required this.peerPub})
      : _subId = 'gw-${peerPub.substring(0, 8)}';

  Stream<DmMessage> get messages => _controller.stream;

  void start() {
    client.connect();
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
      client.publish(g);
    }
    return rumorId;
  }

  void stop() {
    try { client.closeSub(_subId); } catch (_) {}
    _sub?.cancel();
    _controller.close();
  }
}
