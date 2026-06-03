import 'dart:async';
import 'dart:convert';

import '../core/group_store.dart';
import 'nip17.dart';
import 'nostr_client.dart';

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
    client.connect();
    _sub = client.events.listen((rec) {
      final (subId, ev) = rec;
      if (subId != _subId || ev.kind != 1059) return;
      final u = Nip17.unwrap(myPriv, ev);
      if (u == null) return;
      try {
        final env = jsonDecode(u.payload);
        if (env is! Map || env['gid'] != group.id) return; // not this group
      } catch (_) {
        return;
      }
      _controller.add(GroupMessage(
        rumorId: u.rumorId, senderPub: u.senderPub, mine: u.senderPub == myPub,
        payload: u.payload, createdAt: u.createdAt,
      ));
    });
    client.subscribe(_subId, [
      {'kinds': [1059], '#p': [myPub], 'limit': 500},
    ]);
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
