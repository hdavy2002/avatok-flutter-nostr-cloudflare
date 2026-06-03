import 'dart:convert';
import 'dart:math';

import '../crypto/nip44.dart';
import '../identity/nostr_keys.dart';
import 'nostr_client.dart';

/// Result of unwrapping a gift-wrapped message.
class Unwrapped {
  final String senderPub;    // real sender x-only pubkey hex
  final String recipientPub; // rumor's intended recipient (p tag)
  final String payload;      // rumor content (our app envelope)
  final String rumorId;
  final int createdAt;
  Unwrapped(this.senderPub, this.recipientPub, this.payload, this.rumorId, this.createdAt);
}

/// NIP-17 private DMs via NIP-59 gift wrap. The relay only ever sees kind-1059
/// events from random ephemeral keys → recipient, so sender/recipient identities
/// and content are hidden. Verified end-to-end in test/nip17_test.dart.
class Nip17 {
  static final _rnd = Random.secure();

  static int _randPast() {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    return now - _rnd.nextInt(2 * 24 * 3600);
  }

  /// Build the two gift wraps for one message: one to the peer, one to myself
  /// (so my other devices see it). Both carry the same rumor id for dedupe.
  /// Returns (gifts, rumorId).
  static (List<NostrEvent>, String) wrapBoth({
    required String senderPriv,
    required String senderPub,
    required String peerPub,
    required String payload,
  }) {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final tags = [
      ['p', peerPub]
    ];
    final rumorId = NostrEvent.idOf(senderPub, now, 14, tags, payload);
    final rumorJson = jsonEncode({
      'id': rumorId, 'pubkey': senderPub, 'created_at': now, 'kind': 14,
      'tags': tags, 'content': payload, 'sig': '',
    });

    NostrEvent giftTo(String receiverHex) {
      // seal (kind 13) — signed by sender, NIP-44(sender→receiver) of the rumor
      final seal = NostrEvent.sign(
        privHex: senderPriv, pubHex: senderPub, kind: 13, tags: const [],
        content: Nip44.encryptRandom(rumorJson, Nip44.conversationKey(senderPriv, receiverHex)),
        createdAt: _randPast(),
      );
      // gift wrap (kind 1059) — signed by ephemeral key, NIP-44(eph→receiver) of the seal
      final ephPriv = NostrKeys.generatePrivateKey();
      final ephPub = NostrKeys.publicKeyFromPrivate(ephPriv);
      return NostrEvent.sign(
        privHex: ephPriv, pubHex: ephPub, kind: 1059,
        tags: [['p', receiverHex]],
        content: Nip44.encryptRandom(jsonEncode(seal.toJson()), Nip44.conversationKey(ephPriv, receiverHex)),
        createdAt: _randPast(),
      );
    }

    return ([giftTo(peerPub), giftTo(senderPub)], rumorId);
  }

  /// Unwrap a kind-1059 gift addressed to me. Null if not for me / invalid.
  static Unwrapped? unwrap(String myPriv, NostrEvent gift) {
    try {
      if (gift.kind != 1059) return null;
      final sealStr = Nip44.decrypt(gift.content, Nip44.conversationKey(myPriv, gift.pubkey));
      if (sealStr == null) return null;
      final seal = jsonDecode(sealStr) as Map<String, dynamic>;
      final senderPub = seal['pubkey'].toString();
      final rumorStr = Nip44.decrypt(seal['content'].toString(), Nip44.conversationKey(myPriv, senderPub));
      if (rumorStr == null) return null;
      final rumor = jsonDecode(rumorStr) as Map<String, dynamic>;
      String recipient = '';
      for (final t in (rumor['tags'] as List? ?? const [])) {
        if (t is List && t.isNotEmpty && t[0] == 'p' && t.length > 1) { recipient = t[1].toString(); break; }
      }
      return Unwrapped(
        rumor['pubkey'].toString(), recipient, rumor['content'].toString(),
        rumor['id'].toString(), (rumor['created_at'] as num).toInt(),
      );
    } catch (_) {
      return null;
    }
  }
}
