// Exercises the APP's NostrClient class lifecycle (connect → NIP-42 auth →
// queued subscribe → flush → emit) against the live relay. A raw connection
// (sender) publishes a gift wrap to B; B uses the real NostrClient to receive.
import 'dart:async';
import 'dart:convert';

import 'package:avatok_call/core/api_auth.dart';
import 'package:avatok_call/core/config.dart';
import 'package:avatok_call/identity/identity.dart';
import 'package:avatok_call/identity/nostr_keys.dart';
import 'package:avatok_call/nostr/nostr_client.dart';
import 'package:avatok_call/nostr/nip17.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

void main() {
  test('NostrClient class receives a DM end-to-end', () async {
    final bId = Identity.fromPrivateKey(NostrKeys.generatePrivateKey());
    final aPriv = NostrKeys.generatePrivateKey(), aPub = NostrKeys.publicKeyFromPrivate(aPriv);

    // B uses the REAL app client.
    ApiAuth.identity = bId;
    final client = NostrClient(kNostrRelayUrl);
    final got = <NostrEvent>[];
    client.events.listen((rec) { got.add(rec.$2); print('[B/NostrClient] event kind=${rec.$2.kind}'); });
    client.connect();
    client.subscribe('inbox', [{'kinds': [1059], '#p': [bId.pubHex], 'limit': 50}]);

    // Give the client time to auth + flush the queued subscription.
    await Future.delayed(const Duration(seconds: 3));
    print('[B/NostrClient] isConnected=${client.isConnected}');

    // A (raw) auths + publishes a gift wrap to B.
    final aCh = WebSocketChannel.connect(Uri.parse('$kNostrRelayUrl?pubkey=$aPub'));
    String? aAuthId; final aAuthed = Completer<bool>();
    aCh.stream.listen((raw) {
      final d = jsonDecode(raw as String) as List;
      if (d[0] == 'AUTH') {
        final ev = NostrEvent.sign(privHex: aPriv, pubHex: aPub, kind: 22242,
            tags: [['relay', kNostrRelayUrl], ['challenge', d[1].toString()]], content: '');
        aAuthId = ev.id; aCh.sink.add(jsonEncode(['AUTH', ev.toJson()]));
      } else if (d[0] == 'OK' && d[1] == aAuthId) {
        if (!aAuthed.isCompleted) aAuthed.complete(d[2] == true);
      }
    });
    await aAuthed.future.timeout(const Duration(seconds: 10));
    final (gifts, _) = Nip17.wrapBoth(
        senderPriv: aPriv, senderPub: aPub, peerPub: bId.pubHex, payload: '{"t":"text","body":"class diag"}');
    for (final g in gifts) { aCh.sink.add(jsonEncode(['EVENT', g.toJson()])); }
    print('[A/raw] published ${gifts.length} gift wraps');

    await Future.delayed(const Duration(seconds: 4));
    final unwrapped = got.where((e) => e.kind == 1059).map((e) => Nip17.unwrap(bId.privHex, e)).whereType<Unwrapped>().toList();
    final ok = unwrapped.any((u) => u.senderPub == aPub);
    print('\n=== NostrClient class received the DM: ${ok ? "WORKS ✓" : "FAILED ✗"} (got ${got.length} events) ===');
    expect(ok, isTrue, reason: 'the app NostrClient class should receive + surface the DM');
  }, timeout: const Timeout(Duration(seconds: 40)));
}
