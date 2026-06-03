import 'dart:async';
import 'dart:typed_data';

import '../core/config.dart';
import '../crypto/nip44.dart';
import 'nostr_client.dart';

/// A decrypted 1:1 message.
class DmMessage {
  final String evId;
  final bool mine;
  final String text;
  final int createdAt;
  DmMessage({required this.evId, required this.mine, required this.text, required this.createdAt});
}

/// Real end-to-end 1:1 messaging: NIP-44-encrypted (kind-14) events over the
/// AvaTok Nostr relay. ECDH conversation key from my key + the peer's pubkey.
class AvaDm {
  final NostrClient client;
  final String myPriv; // hex
  final String myPub;  // hex (x-only)
  final String peerPub; // hex (x-only)
  late final Uint8List _ck;
  final String _subId;
  StreamSubscription? _sub;
  final _controller = StreamController<DmMessage>.broadcast();

  AvaDm({required this.client, required this.myPriv, required this.myPub, required this.peerPub})
      : _subId = 'dm-${peerPub.substring(0, 8)}' {
    _ck = Nip44.conversationKey(myPriv, peerPub);
  }

  Stream<DmMessage> get messages => _controller.stream;

  void start() {
    client.connect();
    _sub = client.events.listen((rec) {
      final (subId, ev) = rec;
      if (subId != _subId || ev.kind != kDmKind) return;
      // only this conversation (peer↔me, either direction)
      final p = ev.firstTag('p');
      final inConvo = (ev.pubkey == peerPub && p == myPub) ||
          (ev.pubkey == myPub && p == peerPub);
      if (!inConvo) return;
      final text = Nip44.decrypt(ev.content, _ck);
      if (text == null) return;
      _controller.add(DmMessage(
          evId: ev.id, mine: ev.pubkey == myPub, text: text, createdAt: ev.createdAt));
    });
    client.subscribe(_subId, [
      {'kinds': [kDmKind], 'authors': [peerPub], '#p': [myPub], 'limit': 300},
      {'kinds': [kDmKind], 'authors': [myPub], '#p': [peerPub], 'limit': 300},
    ]);
  }

  /// Encrypt + publish a message; returns the event id for optimistic echo dedupe.
  String send(String text) {
    final content = Nip44.encryptRandom(text, _ck);
    final ev = NostrEvent.sign(
      privHex: myPriv, pubHex: myPub, kind: kDmKind,
      tags: [['p', peerPub]], content: content,
    );
    client.publish(ev);
    return ev.id;
  }

  void stop() {
    try { client.closeSub(_subId); } catch (_) {}
    _sub?.cancel();
    _controller.close();
  }
}
