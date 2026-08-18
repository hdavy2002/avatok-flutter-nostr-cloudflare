import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/core/calls/call_prewarm.dart';
import 'package:avatok_call/core/calls/call_sfu_transport.dart';

void main() {
  test('legacy ring metadata does not supersede a nonce-bound prewarm lease', () {
    expect(
      callPrewarmLeaseMatches(
        existingCallId: 'call-1',
        incomingCallId: 'call-1',
        existingNonce: 'nonce-1',
        incomingNonce: '',
        existingGeneration: 7,
        incomingGeneration: null,
      ),
      isTrue,
    );
  });

  test('explicit stale nonce or generation does supersede the lease', () {
    expect(
      callPrewarmLeaseMatches(
        existingCallId: 'call-1',
        incomingCallId: 'call-1',
        existingNonce: 'nonce-1',
        incomingNonce: 'nonce-2',
        existingGeneration: 7,
        incomingGeneration: 7,
      ),
      isFalse,
    );
    expect(
      callPrewarmLeaseMatches(
        existingCallId: 'call-1',
        incomingCallId: 'call-1',
        existingNonce: 'nonce-1',
        incomingNonce: 'nonce-1',
        existingGeneration: 7,
        incomingGeneration: 8,
      ),
      isFalse,
    );
  });

  test('an expired early peer lookup is rearmed from Accept', () async {
    var rearmed = 0;
    final peer = await awaitEarlyPeerOrRearm<String>(
      Future<String?>.value(null),
      () async {
        return 'published-peer';
      },
      onRearm: () => rearmed += 1,
    );

    expect(peer, 'published-peer');
    expect(rearmed, 1);
  });

  test('a successful early peer lookup is reused without another poll', () async {
    var rearmed = 0;
    final early = Completer<String?>()..complete('early-peer');
    final peer = await awaitEarlyPeerOrRearm<String>(
      early.future,
      () async {
        return 'late-peer';
      },
      onRearm: () => rearmed += 1,
    );

    expect(peer, 'early-peer');
    expect(rearmed, 0);
  });
}
