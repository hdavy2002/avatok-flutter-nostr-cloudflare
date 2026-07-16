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

  /// [AVA-CHAT-INSTANT] Send a ONE-SHOT, NON-IDEMPOTENT control envelope — an
  /// unsend/delete-for-everyone (`{"t":"del",...}`) — to the peer. These MUST NOT
  /// ride the durable [Outbox] like a normal message.
  ///
  /// WHY (production bug, 50× `403 not_author` in 3 days for one tester): the
  /// server treats a `/api/msg/send` body containing `"t":"del"`/`"t":"gdel"` as
  /// an AUTHOR-VERIFIED retract (messaging.ts verifyAuthor). Routing it through the
  /// at-least-once Outbox meant that after the FIRST POST tombstoned the target
  /// message, every retry (the 60s ack-reverify re-POST, or a give-up + tap-retry)
  /// re-ran verifyAuthor against a now-tombstoned target, got `403 not_author`, and
  /// — because a 403 is never an ACK — kept re-POSTing up to the 50-attempt / 24h
  /// give-up cap. A retract is idempotent from the user's view (the bubble is
  /// already hidden locally), so a best-effort POST — retried ONLY on transient
  /// network / 5xx errors, and treating BOTH 200 and 403 as terminal (done, or the
  /// target is already gone / not ours) — is the correct transport. Not durable
  /// across restart: a retract that never lands just stays hidden on this device,
  /// which is strictly better than a 403 storm.
  Future<void> sendControl(String payload, {String kind = 'text'}) async {
    if (peerPub.isEmpty) return;
    final clientId = _randId();
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        final res = await ApiAuth.postJson(kMsgSendUrl, {
          'to': peerPub, 'kind': kind, 'body': payload, 'client_id': clientId,
        }, timeout: const Duration(seconds: 20));
        // 200 = applied; 403 = already tombstoned / not author → nothing to retry.
        if (res.statusCode == 200 || res.statusCode == 403) return;
        // Any other status (5xx / transient) → bounded retry below.
      } catch (_) {/* transient network error — retry */}
      await Future.delayed(Duration(milliseconds: 400 * (attempt + 1)));
    }
  }

  /// [STATUS-FANOUT-1] (owner request 2026-07-15) Fan a status envelope out to
  /// [contactUids] over the ordinary message transport.
  ///
  /// WHY THIS EXISTS: posting a status only ever wrote to the local DiskCache —
  /// the Nostr fan-out was deleted in the Cloudflare pivot and never replaced (the
  /// NOTE at status_screen.dart). The RECEIVE half was still wired the whole time
  /// (chat_list._startInbox picks `t == 'status'` off SyncHub and adds it to
  /// StatusStore), so nothing arrived purely because nothing was ever sent. This
  /// closes that loop: no new endpoint, no new transport — the same durable
  /// outbox + InboxDO the DMs already use.
  ///
  /// NOT [send]: that writes the payload into the local DM thread as a message
  /// (`Db.I.upsertMessage`), which would drop a junk bubble in every contact's
  /// chat. A status is a control envelope — it must ride the wire without ever
  /// becoming a message. It's enqueued (not fire-and-forget POSTed) so a status
  /// posted on a flaky link still lands, exactly like a message.
  ///
  /// Callers must pass real AvaTOK account uids only; `tel:` ids have no inbox.
  static void fanOutStatus(Map<String, dynamic> envelope, List<String> contactUids) {
    final payload = jsonEncode(envelope);
    for (final uid in contactUids) {
      if (uid.isEmpty || !uid.startsWith('user_')) continue;
      unawaited(Outbox.I.enqueue(
        clientId: _randId(),
        to: uid,
        payload: payload,
        // The recipient's inbox routes on convKey; '1:<me>' is how a DM from me
        // is addressed on THEIR device. The envelope is intercepted before render
        // on both sides (see chat_thread `t == 'status'`), so it never surfaces.
        convKey: '1:${AccountScope.id ?? ''}',
        kind: 'status',
      ));
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
