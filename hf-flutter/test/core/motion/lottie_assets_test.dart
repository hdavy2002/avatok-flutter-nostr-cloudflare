import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/motion/motion.dart';
import 'package:lottie/lottie.dart';

/// The Lottie files are written by tool/gen_lottie.py. Each must parse with
/// the Lottie package the app ships and have a real length.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the asset list names the three generated files', () {
    expect(HfLottieAssets.all, [
      'assets/lottie/sparkle_burst.json',
      'assets/lottie/heart_pop.json',
      'assets/lottie/check_draw.json',
    ]);
  });

  for (final asset in HfLottieAssets.all) {
    test('$asset parses and has a duration', () async {
      final bytes = await File(asset).readAsBytes();
      final composition = await LottieComposition.fromBytes(bytes);
      expect(composition.duration, greaterThan(Duration.zero));
      expect(
        composition.duration,
        lessThanOrEqualTo(const Duration(seconds: 2)),
      );
    });
  }
}
