import 'nostr_client.dart';

/// Cloudflare-native pivot (Nostr deprecated). NIP-17 gift-wrapping is GONE —
/// messages are server-routed plaintext now. This is a COMPATIBILITY STUB so the
/// legacy social screens (communities, status, group info, new group) that still
/// reference Nip17 keep compiling. The real send path is AvaDm/AvaGroupDm over
/// HTTP. The wrap* methods produce no events (a no-op publish), and unwrap returns
/// null — these call sites are being migrated to the new transport.
class Unwrapped {
  final String senderPub;
  final String recipientPub;
  final String payload;
  final String rumorId;
  final int createdAt;
  Unwrapped(this.senderPub, this.recipientPub, this.payload, this.rumorId, this.createdAt);
}

class Nip17 {
  static (List<NostrEvent>, String) wrapBoth({
    required String senderPriv, required String senderPub,
    required String peerPub, required String payload,
  }) => (<NostrEvent>[], '');

  static (NostrEvent, String) wrapTo({
    required String senderPriv, required String senderPub,
    required String recipientPub, required String payload,
  }) => (_empty(), '');

  static (List<NostrEvent>, String) wrapMany({
    required String senderPriv, required String senderPub,
    required List<String> recipientPubs, required String payload,
  }) => (<NostrEvent>[], '');

  static Unwrapped? unwrap(String myPriv, NostrEvent gift) => null;

  static NostrEvent _empty() =>
      NostrEvent(id: '', pubkey: '', createdAt: 0, kind: 0, tags: const [], content: '', sig: '');
}
