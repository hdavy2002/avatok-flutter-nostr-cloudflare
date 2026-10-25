import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/feed_order.dart';
import 'package:shared_preferences/shared_preferences.dart';

// [HF-REELS-FRESH-OPEN-1] every open starts on a different first reel.
void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FeedOrder.enabled = true;
  });
  tearDown(() => FeedOrder.enabled = false);

  test('never starts on the same reel twice in a row', () async {
    FeedOrder.setRandomForTest(Random(7));
    String? prev;
    for (var i = 0; i < 30; i++) {
      final items = ['a', 'b', 'c', 'd', 'e'];
      await FeedOrder.freshStart<String>(items, (s) => s);
      expect(items.toSet(), {'a', 'b', 'c', 'd', 'e'}, reason: 'nothing lost or duplicated');
      if (prev != null) expect(items.first, isNot(prev));
      prev = items.first;
    }
  });

  test('one reel or none is left alone', () async {
    final one = ['a'];
    await FeedOrder.freshStart<String>(one, (s) => s);
    expect(one, ['a']);
    final none = <String>[];
    await FeedOrder.freshStart<String>(none, (s) => s);
    expect(none, isEmpty);
  });
}
