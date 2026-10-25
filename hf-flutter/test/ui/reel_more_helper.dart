import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// [HF-REEL-RAIL-2] Profile, save, share and the original post moved under the reel's "More" button.
Future<void> openReelMore(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('reel-more')).hitTestable().first);
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}
