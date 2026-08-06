// [CALL-MEDIA-540P-1] Guards for the phone-first call media profile.
//
// These exist because of the specific way the profile was ALMOST lost. The
// video sender ceiling was defined in two places: the healthy path and the
// congestion-recovery rung of the degrade ladder. Lowering the first without
// the second produced a change that looked correct in review, worked on the
// first frame of every call, and quietly restored the old 1.2 Mbps ceiling the
// moment any call recovered from congestion — i.e. exactly on the bad networks
// the cap exists for. Nothing would have caught that but a test that asserts
// the two agree.

import 'package:flutter_test/flutter_test.dart';
import 'package:avatok_call/core/audio_tuning.dart';

void main() {
  group('video capture profile', () {
    test('wifi captures 540p, cellular falls back to 360p', () {
      final wifi = avaVideoConstraints(cellular: false);
      expect((wifi['width'] as Map)['max'], 960);
      expect((wifi['height'] as Map)['max'], 540);

      final cell = avaVideoConstraints(cellular: true);
      expect((cell['width'] as Map)['max'], 640);
      expect((cell['height'] as Map)['max'], 360);
    });

    test('the ceiling is a hard max, not just an ideal', () {
      // `ideal` alone lets a capable camera capture (and encode) far above the
      // profile; the whole point is a bound the device cannot exceed.
      for (final cellular in [true, false]) {
        final c = avaVideoConstraints(cellular: cellular);
        expect((c['width'] as Map)['max'], (c['width'] as Map)['ideal']);
        expect((c['height'] as Map)['max'], (c['height'] as Map)['ideal']);
      }
    });
  });

  group('video sender ceiling', () {
    test('level 0 is the SAME value the healthy path applies', () {
      // THE regression guard. A separate literal for the recovery rung is how
      // the 1.2 Mbps ceiling came back after every congestion cycle.
      expect(avaVideoMaxBitrateBps(cellular: false, degradeLevel: 0),
          avaVideoMaxBitrateBps(cellular: false));
      expect(avaVideoMaxBitrateBps(cellular: true, degradeLevel: 0),
          avaVideoMaxBitrateBps(cellular: true));
    });

    test('sits in the band the 540p/360p profile was chosen for', () {
      expect(avaVideoMaxBitrateBps(cellular: false), 850000);
      expect(avaVideoMaxBitrateBps(cellular: true), 450000);
    });

    test('never exceeds 1 Mbps on any rung — that was the old HD budget', () {
      for (final cellular in [true, false]) {
        for (var level = 0; level <= 2; level++) {
          expect(avaVideoMaxBitrateBps(cellular: cellular, degradeLevel: level),
              lessThan(1000000));
        }
      }
    });

    test('degrades monotonically, and cellular is never above wifi', () {
      for (final cellular in [true, false]) {
        final l0 = avaVideoMaxBitrateBps(cellular: cellular, degradeLevel: 0);
        final l1 = avaVideoMaxBitrateBps(cellular: cellular, degradeLevel: 1);
        final l2 = avaVideoMaxBitrateBps(cellular: cellular, degradeLevel: 2);
        expect(l1, lessThan(l0));
        expect(l2, lessThan(l1));
      }
      expect(avaVideoMaxBitrateBps(cellular: true),
          lessThan(avaVideoMaxBitrateBps(cellular: false)));
    });
  });

  group('audio sender cap vs RED', () {
    test('with RED off the cap is exactly the Opus target', () {
      expect(avaAudioSenderCapBps(40000, redActive: false), 40000);
    });

    test('with RED on the cap leaves room for the redundant copy', () {
      // Without this the sender cap bounds primary + redundancy together, so a
      // 40 kbps cap yields a ~20 kbps primary stream and RED — switched on to
      // improve intelligibility — makes the call sound worse than no RED.
      expect(avaAudioSenderCapBps(40000, redActive: true),
          40000 * (kOpusRedDistance + 1));
      expect(avaAudioSenderCapBps(40000, redActive: true),
          greaterThan(avaAudioSenderCapBps(40000, redActive: false)));
    });
  });
}
