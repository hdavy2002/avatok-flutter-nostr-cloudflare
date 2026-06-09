import 'dart:async';
import 'dart:convert';

import '../core/ava_log.dart';
import '../core/config.dart';
import '../core/db.dart';
import 'ava_dm.dart' show DmMessage;
import 'nip17.dart';
import 'nostr_client.dart';

/// A gift-wrapped DM decrypted ONCE by the hub. Consumers (chat list, threads,
/// group threads) filter this by [convKey] instead of each re-running the heavy
/// Nip17.unwrap themselves.
class HubEvent {
  final String convKey; // '1:<peerHex>' (DM) or 'g:<gid>' (group)
  final String senderPub;
  final String recipientPub;
  final bool mine;
  final String rumorId;
  final String payload;
  final int createdAt;
  HubEvent(this.convKey, this.senderPub, this.recipientPub, this.mine,
      this.rumorId, this.payload, this.createdAt);
  DmMessage toDm() => DmMessage(rumorId: rumorId, mine: mine, payload: payload, createdAt: createdAt);
}

/// App-lifetime singleton holding the ONE relay connection and the ONE
/// subscription to all of my gift-wrapped DMs (kind 1059), plus an in-memory
/// store of every message decrypted this session.
///
/// THE FIX this exists for: previously every screen (the chat list, and EACH
/// chat thread) opened its OWN relay socket and issued its OWN REQ for history.
/// Leaving/re-opening AvaTok or tapping a contact tore everything down and
/// re-downloaded the world — the "blank screen, then contacts appear one by one"
/// behaviour. Now there is a single client that stays connected for the whole
/// app session; the chat list and every thread listen to its [NostrClient.events]
/// stream and read history from (a) this in-memory store and (b) the on-disk
/// cache. Opening a chat is instant; navigation never reconnects or re-REQs.
/// The client is never disposed.
class RelayHub {
  static final RelayHub I = RelayHub._();
  RelayHub._();

  NostrClient? _client;
  bool _subscribed = false;
  String? _priv, _pub;

  // convKey '1:<peerHex>' -> messages decrypted this session (deduped by rumorId).
  // Lets a thread show messages that arrived while it was CLOSED (they'd
  // otherwise be missing: not yet in that thread's on-disk cache, and the live
  // broadcast stream only carries FUTURE events).
  final Map<String, List<DmMessage>> _byConv = {};
  final Set<String> _seenWrap = {};

  // Every DM, decrypted exactly ONCE here, then fanned out. chat list + threads
  // + group threads subscribe to this instead of each calling Nip17.unwrap on
  // the same wrap (which was 3-4× the crypto on the UI thread → typing/send lag
  // when the relay re-streamed a batch).
  final _incoming = StreamController<HubEvent>.broadcast();
  Stream<HubEvent> get incoming => _incoming.stream;

  /// The shared, always-connected client. First call connects and subscribes
  /// once to every kind-1059 wrap addressed to me; it also starts decrypting +
  /// storing them. Idempotent.
  NostrClient ensure(String myPriv, String myPub) {
    _priv ??= myPriv;
    _pub ??= myPub;
    final c = _client ??= NostrClient(kNostrRelayUrl)..connect();
    if (!_subscribed && myPub.isNotEmpty) {
      _subscribed = true;
      c.events.listen(_onEvent); // decrypt + store every DM once
      c.subscribe('inbox', [
        {'kinds': [1059], '#p': [myPub], 'limit': 1000},
      ]);
      AvaLog.I.log('hub', 'shared relay client started + inbox subscribed (one socket for the whole app)');
    } else {
      c.ensureConnected(); // returning to a screen → make sure we're still live
    }
    return c;
  }

  void _onEvent((String, NostrEvent) rec) {
    final ev = rec.$2;
    if (ev.kind != 1059 || _priv == null) return;
    if (!_seenWrap.add(ev.id)) return; // dedup by wrap id → skip re-decrypt of seen wraps
    final u = Nip17.unwrap(_priv!, ev); // the ONE decryption per wrap, app-wide
    if (u == null) return;
    final mine = u.senderPub == _pub;
    final peer = mine ? u.recipientPub : u.senderPub;
    var convKey = '1:$peer';
    var isReceipt = false;
    try {
      final env = jsonDecode(u.payload);
      if (env is Map) {
        if (env['t'] == 'receipt') isReceipt = true; // status, not a stored message
        if (env['gid'] != null) convKey = 'g:${env['gid']}';
      }
    } catch (_) {/* legacy/plain payload */}

    // Store real messages (not receipts) in memory + SQLite, deduped by rumor id.
    // INSERT OR IGNORE means the relay re-streaming old wraps on launch is a no-op.
    if (!isReceipt) {
      final list = _byConv.putIfAbsent(convKey, () => []);
      if (!list.any((m) => m.rumorId == u.rumorId)) {
        list.add(DmMessage(rumorId: u.rumorId, mine: mine, payload: u.payload, createdAt: u.createdAt));
        try {
          Db.I.upsertMessage(MessagesCompanion.insert(
            rumorId: u.rumorId, convKey: convKey, mine: mine, payload: u.payload, createdAt: u.createdAt));
          if (!_dbLogged) { _dbLogged = true; AvaLog.I.log('db', 'sqlite: storing messages locally ✓'); }
        } catch (_) {/* best-effort */}
      }
    }

    // Fan out the decrypted event to all consumers (receipts included — threads
    // apply them as delivery/read status).
    _incoming.add(HubEvent(convKey, u.senderPub, u.recipientPub, mine, u.rumorId, u.payload, u.createdAt));
  }

  bool _dbLogged = false;

  /// Messages for a conversation seen this session (instant, in-memory).
  List<DmMessage> messagesFor(String convKey) => List.of(_byConv[convKey] ?? const []);

  NostrClient? get client => _client;
}
