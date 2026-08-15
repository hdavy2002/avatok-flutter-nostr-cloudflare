import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('app menu affordance remains exactly three times the original 11px title', () {
    final switcher = File('lib/shell/v2/app_switcher_bar.dart').readAsStringSync();
    expect(switcher, contains("'Swipe up · menu'"));
    expect(switcher, contains('height: 64'));
    expect(switcher, contains('fontSize: 33'));
  });

  test('app-wide text scale is visibly larger while remaining bounded', () {
    final main = File('lib/main.dart').readAsStringSync();
    expect(main, contains('const double baseBump = 1.22;'));
    expect(main, contains('? 1.45'));
  });
}
