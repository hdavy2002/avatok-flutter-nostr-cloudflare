import '../core/ava_log.dart';
import '../core/config.dart';
import 'ava_dm.dart' show DmMessage;
import 'nip17.dart';
import 'nostr_client.dart';

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
    if (!_seenWrap.add(ev.id)) return; // dedup by gift-wrap event id
    final u = Nip17.unwrap(_priv!, ev);
    if (u == null) return;
    final peer = u.senderPub == _pub ? u.recipientPub : u.senderPub;
    final list = _byConv.putIfAbsent('1:$peer', () => []);
    if (list.any((m) => m.rumorId == u.rumorId)) return; // dedup by rumor id
    list.add(DmMessage(
        rumorId: u.rumorId, mine: u.senderPub == _pub, payload: u.payload, createdAt: u.createdAt));
  }

  /// Messages for a conversation seen this session (instant, in-memory).
  List<DmMessage> messagesFor(String convKey) => List.of(_byConv[convKey] ?? const []);

  NostrClient? get client => _client;
}
