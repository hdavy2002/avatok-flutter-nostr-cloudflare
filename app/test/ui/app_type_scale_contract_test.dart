import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('app menu affordance uses the compact pill treatment', () {
    final switcher = File('lib/shell/v2/app_switcher_bar.dart').readAsStringSync();
    expect(switcher, contains("'Swipe up'"));
    expect(switcher, contains('height: 40'));
    expect(switcher, contains('color: AD.bubbleOutPlay'));
    expect(switcher, contains('fontSize: 12'));
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
