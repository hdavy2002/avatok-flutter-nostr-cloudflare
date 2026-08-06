// [CALL-RED-1] Tests for the Opus RED munging.
//
// These exist because the previous RED implementation was an empty `if` body
// that shipped to production behind a flag that was TRUE, and nothing — not a
// test, not telemetry, not a code review — noticed for days that RED was inert.
// The two assertions that matter are the two edits that make RED actually
// engage: the fmtp block list, and RED being FIRST on the m=audio line.

import 'package:flutter_test/flutter_test.dart';
import 'package:avatok_call/core/audio_tuning.dart';

/// Minimal but realistic local offer: opus 111, red 63, plus a decoy codec.
const _sdpWithRed = '''v=0
o=- 1 2 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111 63 110
c=IN IP4 0.0.0.0
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:63 red/48000/2
a=rtpmap:110 telephone-event/48000
a=rtcp-fb:111 transport-cc
''';

/// A build with no RFC-2198 support at all.
const _sdpNoRed = '''v=0
o=- 1 2 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1
a=rtcp-fb:111 transport-cc
''';

void main() {
  group('tuneOpusSdp opus params', () {
    test('sets FEC on, DTX off, 40k cap, mono — and preserves minptime', () {
      final out = tuneOpusSdp(_sdpWithRed);
      final fmtp = out
          .split('\r\n')
          .firstWhere((l) => l.startsWith('a=fmtp:111 '));
      expect(fmtp, contains('useinbandfec=1'));
      expect(fmtp, contains('usedtx=0'), reason: 'DTX must stay OFF');
      // [CALL-MEDIA-540P-1 2026-08-06] 56000 -> 40000. This is an OWNER
      // DECISION, not a drift: the phone-first profile targets 40 kbps mono
      // Opus. If this assertion fails again, confirm the intended target
      // before changing the number — the constant and this test are meant to
      // move together and only on purpose.
      expect(fmtp, contains('maxaveragebitrate=40000'));
      expect(fmtp, contains('stereo=0'));
      expect(fmtp, contains('minptime=10'),
          reason: 'pre-existing params must survive the override');
    });

    test('never touches rtcp-fb lines (transport-cc must survive)', () {
      final out = tuneOpusSdp(_sdpWithRed, enableRed: true);
      expect(out, contains('a=rtcp-fb:111 transport-cc'));
    });

    test('is a no-op when there is no opus payload', () {
      const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 110\r\n';
      expect(tuneOpusSdp(sdp), sdp);
    });
  });

  group('RED', () {
    test('is NOT applied when the flag is off', () {
      final out = tuneOpusSdp(_sdpWithRed, enableRed: false);
      expect(out, contains('m=audio 9 UDP/TLS/RTP/SAVPF 111 63 110'),
          reason: 'payload order must be untouched');
      expect(out.contains('a=fmtp:63 '), isFalse);
      expect(sdpHasActiveRed(out), isFalse);
    });

    test('promotes RED to the front of the m-line and writes the block list', () {
      final out = tuneOpusSdp(_sdpWithRed, enableRed: true);
      final mLine =
          out.split('\r\n').firstWhere((l) => l.startsWith('m=audio '));
      expect(mLine, 'm=audio 9 UDP/TLS/RTP/SAVPF 63 111 110',
          reason: 'RED first is what switches it from negotiated to IN USE');
      expect(out, contains('a=fmtp:63 111/111'),
          reason: 'distance 1 = one redundant block + the primary');
      expect(sdpHasActiveRed(out), isTrue);
    });

    test('distance 1 means exactly two blocks', () {
      expect(kOpusRedDistance, 1);
      final out = tuneOpusSdp(_sdpWithRed, enableRed: true);
      final fmtp =
          out.split('\r\n').firstWhere((l) => l.startsWith('a=fmtp:63 '));
      expect(fmtp.split(' ')[1].split('/').length, kOpusRedDistance + 1);
    });

    test('degrades silently when the build has no RED payload', () {
      final out = tuneOpusSdp(_sdpNoRed, enableRed: true);
      expect(out, contains('m=audio 9 UDP/TLS/RTP/SAVPF 111'),
          reason: 'must NOT invent a payload the encoder cannot produce');
      expect(sdpHasActiveRed(out), isFalse);
      // Opus in-band FEC remains the baseline defence.
      expect(out, contains('useinbandfec=1'));
    });

    test('is idempotent — re-tuning an already-RED sdp does not double up', () {
      final once = tuneOpusSdp(_sdpWithRed, enableRed: true);
      final twice = tuneOpusSdp(once, enableRed: true);
      expect(twice, once);
      expect('a=fmtp:63 '.allMatches(twice).length, 1);
    });
  });

  group('sdpHasActiveRed', () {
    test('is false for a merely-advertised RED payload', () {
      // RED present in rtpmap but NOT first on the m-line: this is the exact
      // state production was in while telemetry reported success.
      expect(sdpHasActiveRed(_sdpWithRed), isFalse);
    });

    test('is false for null/empty', () {
      expect(sdpHasActiveRed(null), isFalse);
      expect(sdpHasActiveRed(''), isFalse);
    });
  });
}

extension _Count on String {
  Iterable<Match> allMatches(String s) => RegExp(RegExp.escape(this)).allMatches(s);
}
