import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/unplayable_reels.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(UnplayableReels.resetForTest);

  test(
    '[HF-REEL-SKIP-1] a marked reel is remembered across a reload; expired entries are dropped',
    () async {
      final old = DateTime.now()
          .subtract(const Duration(days: 20))
          .millisecondsSinceEpoch;
      SharedPreferences.setMockInitialValues({
        'hf_unplayable_reels_v1': ['stale|$old'],
      });
      await UnplayableReels.load();
      expect(UnplayableReels.contains('stale'), isFalse);
      await UnplayableReels.mark('r1');
      UnplayableReels.resetForTest();
      await UnplayableReels.load();
      expect(UnplayableReels.contains('r1'), isTrue);
    },
  );

  test('only "can never play here" reasons count', () {
    expect(
      UnplayableReels.permanentReasons,
      containsAll(['appOnly', 'novideo', '150']),
    );
    expect(UnplayableReels.permanentReasons.contains('timeout'), isFalse);
    expect(UnplayableReels.permanentReasons.contains('load'), isFalse);
  });
}
