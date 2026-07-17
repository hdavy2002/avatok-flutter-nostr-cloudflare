import 'dart:async';
import 'dart:math';

import 'package:drift/drift.dart' show Value; // [AVAGRP-DBPUB-1] Messages.senderPub

import '../core/api_auth.dart';
import '../core/config.dart' show kApiBase;
import '../core/db.dart';
import '../core/group_store.dart';
import '../identity/identity.dart';
import 'outbox.dart';
import 'sync_hub.dart';

/// [AVAGRP-SEENBY-1] POST /api/msg/receipts — batch per-message group receipts.
/// Not a `const String k...Url` in core/config.dart (that file isn't owned by
/// this change) — built here from the shared `kApiBase` the same way every
/// other endpoint constant in that file is.
const String _kMsgReceiptsBatchUrl = '$kApiBase/msg/receipts';
// [AVA-CHAT-INSTANT] Built here from `kApiBase` (config.dart's `show` clause is
// owned by another change) for [AvaGroupDm.sendControl]'s one-shot unsend POST.
const String _kMsgSendUrl = '$kApiBase/msg/send';

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
/// appends it to every member's InboxDO. Incoming arrives via [SyncHub] filtered
/// to this group.
class AvaGroupDm {
  final Group group;
  StreamSubscription? _sub;
  StreamSubscription? _outboxSub; // [AVA-GRP-SENDSTATE] outbox ACK/give-up bridge
  final _controller = StreamController<GroupMessage>.broadcast();
  // [AVA-GRP-SENDSTATE] Per-message send outcome for THIS group, mirroring
  // `AvaDm.sendStatus`. Groups previously had NO listener on `Outbox.I.status`,
  // so a group bubble's `sent` never flipped true on the HTTP-200 ACK: it stayed
  // "Sending…" forever in-session, was persisted as `pending`, and then — because
  // the outbox entry had already been removed on echo (so `isPending` was false on
  // reopen) — the thread's cache-restore heuristic mis-marked every DELIVERED own
  // group message as "NOT SENT · tap to retry" (the owner's bug). Bridging the
  // shared outbox status here, exactly as the DM path does, flips the bubble to
  // "sent" on ACK so it never persists as pending in the first place.
  final _statusC = StreamController<({String rumorId, bool ok, String message})>.broadcast();

  AvaGroupDm({required this.group});

  Stream<GroupMessage> get messages => _controller.stream;
  Stream<({String rumorId, bool ok, String message})> get sendStatus => _statusC.stream;

  void start() {
    final myConv = 'g:${group.id}';
    _sub = SyncHub.I.incoming.where((e) => e.convKey == myConv).listen((e) {
      if (!_controller.isClosed) {
        _controller.add(GroupMessage(
          rumorId: e.rumorId, senderPub: e.senderPub, mine: e.mine,
          payload: e.payload, createdAt: e.createdAt,
        ));
      }
    });
    // [AVA-GRP-SENDSTATE] Relay the durable outbox's per-message results for THIS
    // group conversation into `sendStatus` so the bubble shows "sending…" → "sent"
    // (HTTP-200 ACK) / "not sent" (terminal give-up). Filter to this conv so the
    // shared singleton doesn't leak another thread's status. Mirrors AvaDm.start().
    _outboxSub = Outbox.I.status.where((s) => s.convKey == myConv).listen((s) {
      if (!_statusC.isClosed) _statusC.add((rumorId: s.clientId, ok: s.ok, message: s.message));
    });
    // A thread open is also a retry trigger: flush anything still queued.
    unawaited(Outbox.I.drain(reason: 'group_thread_open'));
  }

  /// Send [payload] (already gid-stamped) to the group conversation. Returns the
  /// client_id. Write-to-DB-first for instant local echo, then ENQUEUE to the
  /// durable outbox so the send survives a flaky link / app restart and retries
  /// automatically. [MSG-OUTBOX-1] The old path did a fire-and-forget POST that
  /// swallowed ALL errors (`onError: (_) {}`) — a group message that failed to
  /// send just silently disappeared, with not even a failed status surfaced.
  String send(String payload) {
    final clientId = _randId();
    final convKey = 'g:${group.id}';
    try {
      // [AVAGRP-DBPUB-1] Stamp my own uid too — `_setupGroup`'s DB replay blanks
      // `senderPub` for `mine` rows regardless (the UI already keys "is this
      // mine" off the `mine` flag, not `senderPub`), but storing the real value
      // keeps this row identical to how the same message looks once it echoes
      // back through `SyncHub._ingestMsg` and gets `insertOrIgnore`d again.
      Db.I.upsertMessage(MessagesCompanion.insert(
          rumorId: clientId, convKey: convKey, mine: true, payload: payload,
          createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000,
          senderPub: Value(AccountScope.id ?? '')));
    } catch (_) {}
    unawaited(Outbox.I.enqueue(
      clientId: clientId, conv: group.id, payload: payload, convKey: convKey, kind: 'text',
    ));
    return clientId;
  }

  /// [AVA-CHAT-INSTANT] One-shot, NON-IDEMPOTENT group control envelope — an
  /// unsend/delete-for-everyone (`{"t":"gdel",...}`). MUST NOT ride the durable
  /// [Outbox]: `/api/msg/send` author-verifies a `"t":"gdel"` body, so an
  /// at-least-once retry after the first POST tombstones the target loops
  /// `403 not_author` (the 1:1 `AvaDm.sendControl` doc explains the production
  /// bug in full). Best-effort POST, retried only on transient network / 5xx, with
  /// both 200 and 403 terminal.
  Future<void> sendControl(String payload, {String kind = 'text'}) async {
    final clientId = _randId();
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        final res = await ApiAuth.postJson(_kMsgSendUrl, {
          'conv': group.id, 'kind': kind, 'body': payload, 'client_id': clientId,
        }, timeout: const Duration(seconds: 20));
        if (res.statusCode == 200 || res.statusCode == 403) return; // done / already gone
      } catch (_) {/* transient — retry */}
      await Future.delayed(Duration(milliseconds: 400 * (attempt + 1)));
    }
  }

  /// [AVAGRP-SEENBY-1] Batch per-message delivered/read receipt for THIS group.
  /// `bySender` maps ORIGINAL AUTHOR uid -> the mids (canonical `mid`, not a local
  /// row id) of THAT author's messages the caller has just delivered/read. The
  /// caller (chat_thread.dart) already has both pieces of data from the rendered
  /// message list — grouping by sender here (rather than sending one call per
  /// message) is what keeps this O(distinct senders in the batch) instead of
  /// O(messages): only the ORIGINAL SENDER's own InboxDO needs to durably learn
  /// who has seen their message (see msgReceiptBatch in worker/src/routes/
  /// messaging.ts). `status` is 'delivered' or 'read' for the WHOLE call — call it
  /// once for newly-rendered messages ('delivered') and again when the thread is
  /// actually viewed ('read'), same two-step WhatsApp does for 1:1. Best-effort,
  /// fire-and-forget (mirrors AvaDm.sendReceipt) — a dropped receipt just means
  /// the sender's seen-by sheet is stale until the next one lands, never a crash.
  /// Gate on RemoteConfig.groupReceiptsEnabled at the call site — the server also
  /// enforces the kill switch, so this is defense in depth, not the only gate.
  void sendMsgReceipt(String status, Map<String, List<String>> bySender) {
    if (bySender.isEmpty) return;
    final myUid = AccountScope.id ?? '';
    for (final entry in bySender.entries) {
      final sender = entry.key;
      final mids = entry.value;
      if (sender.isEmpty || mids.isEmpty) continue;
      if (sender == myUid) continue; // never receipt my own message
      unawaited(ApiAuth.postJson(_kMsgReceiptsBatchUrl, {
        'conv': group.id, 'sender': sender, 'status': status, 'msg_ids': mids,
      }).then((_) {}, onError: (_) {}));
    }
  }

  void stop() {
    _sub?.cancel();
    _outboxSub?.cancel();
    _controller.close();
    _statusC.close();
  }

  static String _randId() {
    final r = Random.secure();
    return 'ct_' + List<int>.generate(12, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}
