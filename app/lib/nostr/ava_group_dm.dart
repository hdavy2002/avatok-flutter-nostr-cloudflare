import 'dart:async';
import 'dart:convert';

import '../core/group_store.dart';
import 'nip17.dart';
import 'nostr_client.dart';
import 'relay_hub.dart';

class GroupMessage {
  final String rumorId;
  final String senderPub;
  final bool mine;
  final String payload;
  final int createdAt;
  GroupMessage({required this.rumorId, required this.senderPub, required this.mine, required this.payload, required this.createdAt});
}

/// Group messaging over the relay: NIP-17 gift-wrapped fan-out to every member,
/// routed locally by the group id carried in the payload.
class AvaGroupDm {
  final NostrClient client;
  final String myPriv;
  final String myPub;
  final Group group;
  final String _subId;
  StreamSubscription? _sub;
  final _controller = StreamController<GroupMessage>.broadcast();

  AvaGroupDm({required this.client, required this.myPriv, required this.myPub, required this.group})
      : _subId = 'grp-${group.id}';

  Stream<GroupMessage> get messages => _controller.stream;

  void start() {
    // Consume the hub's SINGLE-decrypt stream filtered to this group — no own
    // socket, REQ, or Nip17.unwrap (the hub already decrypted every wrap once).
    final myConv = 'g:${group.id}';
    _sub = RelayHub.I.incoming.where((e) => e.convKey == myConv).listen((e) {
      if (!_controller.isClosed) {
        _controller.add(GroupMessage(
          rumorId: e.rumorId, senderPub: e.senderPub, mine: e.mine,
          payload: e.payload, createdAt: e.createdAt,
        ));
      }
    });
  }

  /// Send [payload] (already gid-stamped) to all members. Returns rumor id.
  String send(String payload) {
    final (gifts, rumorId) = Nip17.wrapMany(
        senderPriv: myPriv, senderPub: myPub, recipientPubs: group.members, payload: payload);
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
