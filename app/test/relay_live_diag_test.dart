// LIVE diagnosis: runs the APP's real crypto (NostrEvent.sign, NIP-42 auth,
// Nip17 gift wrap) against the deployed avatok-relay to find the client-side bug.
// Run: flutter test test/relay_live_diag_test.dart
import 'dart:async';
import 'dart:convert';

import 'package:avatok_call/identity/nostr_keys.dart';
import 'package:avatok_call/nostr/nostr_client.dart';
import 'package:avatok_call/nostr/nip17.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

const relay = 'wss://avatok-relay.getmystuffme.workers.dev/';

class Peer {
  final String priv, pub, label;
  late WebSocketChannel ch;
  bool authed = false;
  String? authId;
  final received = <NostrEvent>[];
  final _authedC = Completer<bool>();
  Peer(this.priv, this.pub, this.label);

  Future<bool> connectAndAuth() async {
    ch = WebSocketChannel.connect(Uri.parse('$relay?pubkey=$pub'));
    ch.stream.listen((raw) {
      final d = jsonDecode(raw as String) as List;
      switch (d[0]) {
        case 'AUTH':
          final ev = NostrEvent.sign(privHex: priv, pubHex: pub, kind: 22242,
              tags: [['relay', relay], ['challenge', d[1].toString()]], content: '');
          authId = ev.id;
          ch.sink.add(jsonEncode(['AUTH', ev.toJson()]));
          print('[$label] got AUTH challenge → sent kind-22242');
          break;
        case 'OK':
          final accepted = d.length > 2 && d[2] == true;
          if (!authed && d[1] == authId) {
            authed = accepted;
            print('[$label] AUTH ${accepted ? "ACCEPTED ✓" : "REJECTED ✗ (${d.length>3?d[3]:""})"}');
            if (!_authedC.isCompleted) _authedC.complete(accepted);
          } else {
            print('[$label] publish OK id=${d[1].toString().substring(0,8)} accepted=$accepted ${d.length>3?d[3]:""}');
          }
          break;
        case 'EVENT':
          received.add(NostrEvent.fromJson((d[2] as Map).cast<String, dynamic>()));
          print('[$label] <<EVENT kind=${d[2]["kind"]} id=${d[2]["id"].toString().substring(0,8)}');
          break;
        case 'EOSE': print('[$label] EOSE ${d[1]}'); break;
        case 'CLOSED': print('[$label] CLOSED ${d.sublist(1)}'); break;
      }
    });
    return _authedC.future.timeout(const Duration(seconds: 12), onTimeout: () {
      print('[$label] AUTH TIMEOUT ✗'); return false;
    });
  }

  void send(List o) => ch.sink.add(jsonEncode(o));
}

void main() {
  test('app crypto round-trips a DM through the live relay', () async {
    final aPriv = NostrKeys.generatePrivateKey(), aPub = NostrKeys.publicKeyFromPrivate(aPriv);
    final bPriv = NostrKeys.generatePrivateKey(), bPub = NostrKeys.publicKeyFromPrivate(bPriv);
    final a = Peer(aPriv, aPub, 'A'), b = Peer(bPriv, bPub, 'B');

    final bAuth = await b.connectAndAuth();
    expect(bAuth, isTrue, reason: 'B NIP-42 auth must be accepted by the relay');
    b.send(['REQ', 'inbox', {'kinds': [1059], '#p': [bPub], 'limit': 50}]);
    await Future.delayed(const Duration(milliseconds: 1500));

    final aAuth = await a.connectAndAuth();
    expect(aAuth, isTrue, reason: 'A NIP-42 auth must be accepted by the relay');

    const payload = '{"t":"text","body":"diag ping"}';
    final (gifts, _) = Nip17.wrapBoth(senderPriv: aPriv, senderPub: aPub, peerPub: bPub, payload: payload);
    print('[A] publishing ${gifts.length} gift wraps (app Nip17)…');
    for (final g in gifts) { a.send(['EVENT', g.toJson()]); }
    await Future.delayed(const Duration(seconds: 4));

    // Did B receive a 1059 it can unwrap to A's payload?
    final got = b.received.where((e) => e.kind == 1059).map((e) => Nip17.unwrap(bPriv, e)).whereType<Unwrapped>().toList();
    final ok = got.any((u) => u.senderPub == aPub && u.payload == payload);
    print('\n=== APP DM round-trip via live relay: ${ok ? "WORKS ✓" : "FAILED ✗"} ===');
    print('   B received ${b.received.length} events; unwrapped ${got.length} valid.');
    expect(ok, isTrue, reason: 'B should receive + unwrap A\'s gift wrap');
  }, timeout: const Timeout(Duration(seconds: 40)));
}
