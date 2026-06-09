import 'dart:async';
import 'dart:math';

import '../core/api_auth.dart';
import '../core/config.dart';
import '../core/db.dart';
import '../core/group_store.dart';
import '../identity/identity.dart';
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

/// Group messaging over the Cloudflare-native backend. Fan-out is server-side: we
/// POST one message to the group conversation (conv = group.id) and the router
/// appends it to every member's InboxDO. Incoming arrives via [RelayHub] filtered
/// to this group. [client]/[myPriv]/[myPub] are legacy params, ignored.
class AvaGroupDm {
  final NostrClient client;
  final String myPriv;
  final String myPub;
  final Group group;
  StreamSubscription? _sub;
  final _controller = StreamController<GroupMessage>.broadcast();

  AvaGroupDm({required this.client, required this.myPriv, required this.myPub, required this.group});

  Stream<GroupMessage> get messages => _controller.stream;

  String get _myUid => AccountScope.id ?? myPub;

  void start() {
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

  /// Send [payload] (already gid-stamped) to the group conversation. Returns the
  /// client_id. Write-to-DB-first for instant local echo.
  String send(String payload) {
    final clientId = _randId();
    try {
      Db.I.upsertMessage(MessagesCompanion.insert(
          rumorId: clientId, convKey: 'g:${group.id}', mine: true, payload: payload,
          createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000));
    } catch (_) {}
    unawaited(ApiAuth.postJson(kMsgSendUrl, {
      'conv': group.id, 'kind': 'text', 'body': payload, 'client_id': clientId,
    }).then((_) {}, onError: (_) {}));
    return clientId;
  }

  void stop() {
    _sub?.cancel();
    _controller.close();
  }

  static String _randId() {
    final r = Random.secure();
    return 'ct_' + List<int>.generate(12, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}
