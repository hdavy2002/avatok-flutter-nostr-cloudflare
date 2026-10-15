import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/host_profile/ui/widgets/call_glow.dart';
import 'package:hf_app/features/host_profile/ui/widgets/profile_hero.dart';
import 'package:hf_app/features/host_profile/ui/widgets/voice_intro_player.dart';

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  bool reduced = false,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: buildHfTheme(),
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
          child: Scaffold(body: Center(child: child)),
        ),
      ),
    ),
  );
}

Color _glowColor(WidgetTester tester) {
  final box = tester.widget<DecoratedBox>(find.byKey(CallGlow.glowKey));
  final shadow = (box.decoration as BoxDecoration).boxShadow!.single;
  return shadow.color;
}

void main() {
  group('CallGlow', () {
    testWidgets('breathes, glows and shines while taps still reach the button', (
      tester,
    ) async {
      var taps = 0;
      await _pump(
        tester,
        CallGlow(
          child: SizedBox(
            width: 200,
            height: 56,
            child: ElevatedButton(
              onPressed: () => taps++,
              child: const Text('Call Asha'),
            ),
          ),
        ),
      );
      expect(find.byType(Breathing), findsOneWidget);
      final start = _glowColor(tester).a;
      await tester.pump(const Duration(milliseconds: 1400));
      final peak = _glowColor(tester).a;
      expect(peak, greaterThan(start));
      expect(tester.hasRunningAnimations, isTrue);
      await tester.tap(find.text('Call Asha'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(taps, 1);
      // Looping: replace the tree so the test ends cleanly.
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('reduced motion: a calm still glow, nothing loops', (
      tester,
    ) async {
      await _pump(
        tester,
        const CallGlow(child: SizedBox(width: 200, height: 56)),
        reduced: true,
      );
      await tester.pumpAndSettle();
      expect(find.byKey(CallGlow.glowKey), findsOneWidget);
      expect(find.byType(Breathing), findsNothing);
      expect(tester.hasRunningAnimations, isFalse);
    });
  });

  group('LiveBars', () {
    testWidgets('dance in primary while moving, stand still otherwise', (
      tester,
    ) async {
      final c = AnimationController(
        vsync: const TestVSync(),
        duration: const Duration(seconds: 1),
      );
      addTearDown(c.dispose);
      await _pump(tester, LiveBars(animation: c));
      List<double> heights() => tester
          .widgetList<Container>(
            find.descendant(
              of: find.byType(LiveBars),
              matching: find.byType(Container),
            ),
          )
          .map((w) => w.constraints!.maxHeight)
          .toList();
      final colors = tester
          .widgetList<Container>(
            find.descendant(
              of: find.byType(LiveBars),
              matching: find.byType(Container),
            ),
          )
          .map((w) => (w.decoration! as BoxDecoration).color)
          .toSet();
      expect(colors, {HfColors.primary, HfColors.deepOrange});
      final before = heights();
      c.value = 0.3;
      await tester.pump();
      expect(heights(), isNot(before));

      await _pump(tester, LiveBars(animation: c, moving: false));
      final still = heights();
      c.value = 0.8;
      await tester.pump();
      expect(heights(), still);
    });
  });

  testWidgets('the sun bands paint at phone sizes without errors', (
    tester,
  ) async {
    for (final size in const [Size(320, 440), Size(425, 440)]) {
      await _pump(
        tester,
        SizedBox.fromSize(
          size: size,
          child: const CustomPaint(painter: ProfileSunBandsPainter()),
        ),
      );
      expect(tester.takeException(), isNull);
    }
    expect(ProfileSunBandsPainter.base, HfColors.primary);
  });
}
