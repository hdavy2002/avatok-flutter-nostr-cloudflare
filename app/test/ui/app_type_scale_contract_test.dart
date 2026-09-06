import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  // [SHELL-STATIC-BAR-1 2026-08-28] This test used to pin the compact PILL
  // treatment on the app-menu affordance: the "Swipe up" label, its
  // AD.bubbleOutPlay background and its 12px type.
  //
  // That affordance no longer exists. The owner made the footer bar STATIC —
  // no expand handle, no caret, no "Swipe up"/"Swipe down" label, and no
  // app-switcher icon row. Pinning the pill would now be pinning a design
  // that was deliberately removed.
  //
  // Following this file's own convention (see the [RESP-SMALL-1] note below),
  // the contract is RESTATED rather than deleted.
  //
  // [UI-SEAM-OFF-1 2026-09-05] The 40px height this test used to pin is GONE,
  // deliberately. With the icon row unreachable and the swipe pill deleted, the
  // height was holding a 40dp EMPTY strip across the bottom of every screen —
  // and the RAJ-INDIGO-1 footer seam that was positioned against it was removed
  // in the same commit, so nothing is pinned to that edge any more. Demanding
  // `height: 40` here was demanding the empty strip back.
  //
  // What still matters, and is what this now pins: the bar stays STATIC (no
  // swipe pill, in either direction) and the icon row stays compiled but
  // unreachable. If someone flips `_kShowAppSwitcherIcons` back on, the band
  // needs a height again — app_switcher_bar.dart says so at its own call site —
  // and that pairing is what the last assertion guards.
  test('app menu affordance is static — no swipe pill, no empty band', () {
    final switcher = File('lib/shell/v2/app_switcher_bar.dart').readAsStringSync();
    expect(switcher, isNot(contains("'Swipe up'")),
        reason: 'the bar is static; the swipe pill was removed on purpose');
    expect(switcher, isNot(contains("'Swipe down'")),
        reason: 'the bar is static; the swipe pill was removed on purpose');
    expect(switcher, contains('_kShowAppSwitcherIcons = false'),
        reason: 'the app-switcher icon row stays compiled but unreachable');
    // The pairing: an unreachable icon row must not leave a sized empty band.
    expect(switcher, isNot(contains('height: 40')),
        reason: 'with the icon row off there is nothing to give the band '
            'height — a 40dp empty strip across every screen is exactly what '
            '[UI-SEAM-OFF-1] removed. Restore this only together with '
            '_kShowAppSwitcherIcons = true.');
  });

  // [RESP-SMALL-1 2026-08-21] This test previously pinned the exact source line
  // `const double baseBump = 1.22;`. That line is gone: a FLAT 1.22 at every
  // width was the bug — it enlarged type by 22% on the smallest phones, which
  // is how a tester ended up unable to reach content on a ~3x4 inch screen.
  //
  // The contract it was protecting is still real and still worth a test, so it
  // is restated rather than deleted: 1.22 must survive for NORMAL phones (the
  // standing owner decision from [APP-TYPE-SCALE-2], made after 1.10 shipped
  // and was rejected as too small), and the 1.45 ceiling must survive with it.
  // What is no longer asserted is that 1.22 applies UNCONDITIONALLY.
  //
  // Deliberately matched loosely (`'1.22'` on the >=360 branch) instead of on a
  // whole formatted line: this is a source-text test, so a pin on exact
  // whitespace fails on a reformat and teaches people to edit the test instead
  // of thinking about the value.
  test('app-wide text scale is visibly larger on normal phones, bounded, '
      'and does NOT enlarge the smallest screens', () {
    final main = File('lib/main.dart').readAsStringSync();

    // The owner-mandated bump and ceiling for regular-width phones.
    expect(main, contains('1.22'),
        reason: 'the 1.22 base bump for >=360dp phones is an owner decision '
            '([APP-TYPE-SCALE-2]); 1.10 was shipped and rejected as too small');
    expect(main, contains('? 1.45'));

    // [RESP-SMALL-1] The bump must be width-aware, not a single constant.
    expect(main, isNot(contains('const double baseBump')),
        reason: 'a compile-time-constant baseBump means one value at every '
            'width, which is the small-screen bug: on a <320dp phone it '
            'resolved to a 20% enlargement of an already tiny screen');
    expect(main, contains('final double baseBump'));

    // Smallest tier must neither bump nor allow a large OS font to undo it.
    // Both are the final `else` of their ternary, hence ':' not '?'.
    expect(main, contains(': 1.00'),
        reason: 'phones under 320dp must get NO bump at all');
    expect(main, contains(': 1.10'),
        reason: 'the <320dp ceiling must sit just above its 1.00 bump — a '
            'ceiling ABOVE the bump cannot cap it, which is exactly why the '
            'old 1.20 ceiling failed to protect the small screen');
  });
}
