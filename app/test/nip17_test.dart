import 'package:avatok_call/identity/nostr_keys.dart';
import 'package:avatok_call/nostr/nip17.dart';
import 'package:flutter_test/flutter_test.dart';

/// End-to-end NIP-17 gift-wrap check: wrap A→B, B unwraps to the real sender +
/// payload, the relay-visible event hides the sender, and cross-decryption fails.
void main() {
  test('gift-wrap round trip + metadata hidden', () {
    final aPriv = NostrKeys.generatePrivateKey();
    final aPub = NostrKeys.publicKeyFromPrivate(aPriv);
    final bPriv = NostrKeys.generatePrivateKey();
    final bPub = NostrKeys.publicKeyFromPrivate(bPriv);

    const payload = '{"t":"text","body":"hi 🍕 end-to-end"}';
    final (gifts, rumorId) = Nip17.wrapBoth(
        senderPriv: aPriv, senderPub: aPub, peerPub: bPub, payload: payload);

    expect(gifts.length, 2);
    final toB = gifts[0]; // peer copy
    final toA = gifts[1]; // self copy

    // The relay sees an ephemeral key, not the real sender → metadata hidden.
    expect(toB.kind, 1059);
    expect(toB.pubkey == aPub, isFalse);
    expect(toB.pubkey == bPub, isFalse);

    // B unwraps the peer copy → real sender A, intended recipient B, payload.
    final ub = Nip17.unwrap(bPriv, toB);
    expect(ub, isNotNull);
    expect(ub!.senderPub, aPub);
    expect(ub.recipientPub, bPub);
    expect(ub.payload, payload);
    expect(ub.rumorId, rumorId);

    // A unwraps its own self-copy (multi-device).
    final ua = Nip17.unwrap(aPriv, toA);
    expect(ua, isNotNull);
    expect(ua!.senderPub, aPub);
    expect(ua.payload, payload);

    // Cross decryption must fail: A can't read B's gift.
    expect(Nip17.unwrap(aPriv, toB), isNull);
  });
}
