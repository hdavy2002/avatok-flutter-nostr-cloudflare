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

  test('preaccept audio mid resolver selects the audio section only', () {
    const sdp = 'v=0\r\n'
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
        'a=mid:0\r\n'
        'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
        'a=mid:3\r\n';
    expect(callPrewarmAudioMidFromSdp(sdp), '3');
    expect(callPrewarmAudioMidFromSdp('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\n'), isNull);
  });

  test('preaccept replacement contract requires the expected track and no offer', () {
    expect(
      callSfuAudioReplaceContractHolds(
        senderTrackId: 'mic-1',
        expectedTrackId: 'mic-1',
        renegotiated: false,
      ),
      isTrue,
    );
    expect(
      callSfuAudioReplaceContractHolds(
        senderTrackId: 'mic-1',
        expectedTrackId: 'mic-1',
        renegotiated: true,
      ),
      isFalse,
    );
    expect(
      callSfuAudioReplaceContractHolds(
        senderTrackId: null,
        expectedTrackId: 'mic-1',
        renegotiated: false,
      ),
      isFalse,
    );
  });
}
