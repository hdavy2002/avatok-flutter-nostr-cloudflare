import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/format/money.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';

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

List<String> _assetNames(WidgetTester tester) => tester
    .widgetList<Image>(find.byType(Image))
    .map((i) => i.image)
    .whereType<AssetImage>()
    .map((a) => a.assetName)
    .toList();

/// The words of the speech bubble that are currently visible.
String _visibleWords(WidgetTester tester) {
  final text = tester.widget<Text>(find.byKey(SpeechBubble.textKey));
  final span = text.textSpan! as TextSpan;
  return (span.children!.first as TextSpan).text ?? '';
}

const _message = 'Namaste! I will show you around in a minute';

void main() {
  group('assets', () {
    test('every beaver pose has an animated clip and a still', () {
      for (final pose in BeaverPose.values) {
        expect(File(pose.animatedAsset).existsSync(), isTrue,
            reason: pose.animatedAsset);
        expect(File(pose.stillAsset).existsSync(), isTrue,
            reason: pose.stillAsset);
      }
      expect(BeaverPose.phoneTalk.animatedAsset,
          'assets/beaver/beaver_phone_talk.webp');
      expect(BeaverPose.values, hasLength(12));
    });

    test('the brand logo constant points at a bundled sticker', () {
      expect(kLogoAsset, 'assets/brand/logo2.png');
      expect(File(kLogoAsset).existsSync(), isTrue);
    });
  });

  group('BeaverGuide', () {
    testWidgets('plays the animated clip with normal motion', (tester) async {
      await _pump(tester, const BeaverGuide(pose: BeaverPose.wave));
      await tester.pump(const Duration(milliseconds: 600));
      expect(_assetNames(tester), contains(BeaverPose.wave.animatedAsset));
      expect(
        _assetNames(tester),
        isNot(contains(BeaverPose.wave.stillAsset)),
      );
      expect(
        find.byWidgetPredicate(
          (w) =>
              w is Semantics &&
              w.properties.label == BeaverGuide.defaultSemanticLabel,
        ),
        findsOneWidget,
      );
      expect(BeaverGuide.defaultSemanticLabel, 'Hello Fraands beaver');
      expect(tester.takeException(), isNull);
    });

    testWidgets('shows the still PNG with reduced motion', (tester) async {
      await _pump(
        tester,
        const BeaverGuide(pose: BeaverPose.phoneTalk),
        reduced: true,
      );
      await tester.pump();
      expect(_assetNames(tester), [BeaverPose.phoneTalk.stillAsset]);
      expect(
        find.descendant(
          of: find.byType(BeaverGuide),
          matching: find.byType(ScaleTransition),
        ),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('the bubble types word by word and ends with the full text', (
      tester,
    ) async {
      await _pump(tester, const BeaverGuide(message: _message));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 40));
      final early = _visibleWords(tester);
      expect(_message.startsWith(early), isTrue);
      expect(early.length, lessThan(_message.length));
      await tester.pump(const Duration(milliseconds: 800));
      expect(_visibleWords(tester), _message);
      expect(find.text(_message), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('reduced motion shows the full message at once', (
      tester,
    ) async {
      await _pump(
        tester,
        const BeaverGuide(
          message: _message,
          bubbleSide: BeaverBubbleSide.beside,
        ),
        reduced: true,
      );
      await tester.pump();
      expect(_visibleWords(tester), _message);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a new message types again', (tester) async {
      await _pump(tester, const SpeechBubble(text: 'First message here'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(_visibleWords(tester), 'First message here');
      await _pump(tester, const SpeechBubble(text: _message));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 40));
      expect(_visibleWords(tester).length, lessThan(_message.length));
      await tester.pump(const Duration(milliseconds: 800));
      expect(_visibleWords(tester), _message);
    });

    test('visibleText reveals whole words', () {
      expect(SpeechBubble.visibleText('a bb ccc', 0), '');
      expect(SpeechBubble.visibleText('a bb ccc', 0.5), 'a bb');
      expect(SpeechBubble.visibleText('a bb ccc', 1), 'a bb ccc');
    });
  });

  group('CountUpText', () {
    testWidgets('counts to the final value through the formatter', (
      tester,
    ) async {
      final seen = <num>[];
      String format(num v) {
        seen.add(v);
        return Money.paise(v as int);
      }

      await _pump(tester, CountUpText(value: 1000, formatter: format));
      expect(find.text(Money.paise(1000)), findsOneWidget);

      await _pump(tester, CountUpText(value: 5187, formatter: format));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text(Money.paise(5187)), findsNothing);
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text(Money.paise(5187)), findsOneWidget);
      expect(seen.every((v) => v is int), isTrue);
      expect(tester.takeException(), isNull);
    });

    testWidgets('counts up from [from] on first build', (tester) async {
      await _pump(
        tester,
        CountUpText(value: 42, from: 0, formatter: (v) => '$v min'),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('42 min'), findsNothing);
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('42 min'), findsOneWidget);
    });

    testWidgets('reduced motion shows the final value at once', (
      tester,
    ) async {
      await _pump(
        tester,
        CountUpText(value: 10, from: 0, formatter: (v) => '$v'),
        reduced: true,
      );
      expect(find.text('10'), findsOneWidget);
      await _pump(
        tester,
        CountUpText(value: 99, formatter: (v) => '$v'),
        reduced: true,
      );
      await tester.pump();
      expect(find.text('99'), findsOneWidget);
    });
  });

  group('ConfettiBurst', () {
    testWidgets('paints nothing with reduced motion', (tester) async {
      final controller = ConfettiController();
      await _pump(
        tester,
        ConfettiBurst(
          controller: controller,
          child: const SizedBox(width: 200, height: 200),
        ),
        reduced: true,
      );
      controller.fire();
      await tester.pump();
      expect(find.byKey(ConfettiBurst.paintKey), findsNothing);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    });

    testWidgets('bursts, then clears itself', (tester) async {
      final controller = ConfettiController();
      await _pump(
        tester,
        ConfettiBurst(
          controller: controller,
          child: const SizedBox(width: 200, height: 200),
        ),
      );
      expect(find.byKey(ConfettiBurst.paintKey), findsNothing);
      controller.fire();
      await tester.pump();
      expect(find.byKey(ConfettiBurst.paintKey), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.byKey(ConfettiBurst.paintKey), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 800));
      expect(find.byKey(ConfettiBurst.paintKey), findsNothing);
      expect(controller.shots, 1);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    });
  });

  group('StaggeredReveal and PopIn', () {
    testWidgets('reduced motion shows every child at once', (tester) async {
      await _pump(
        tester,
        const StaggeredReveal(
          children: [Text('One'), Text('Two'), Text('Three')],
        ),
        reduced: true,
      );
      for (final t in ['One', 'Two', 'Three']) {
        expect(find.text(t), findsOneWidget);
      }
      expect(
        find.descendant(
          of: find.byType(StaggeredReveal),
          matching: find.byType(Opacity),
        ),
        findsNothing,
      );
    });

    testWidgets('children end fully visible with normal motion', (
      tester,
    ) async {
      await _pump(
        tester,
        const StaggeredReveal(
          children: [Text('One'), Text('Two'), Text('Three')],
        ),
      );
      await tester.pump();
      final first = tester.widget<Opacity>(
        find
            .ancestor(of: find.text('Three'), matching: find.byType(Opacity))
            .first,
      );
      expect(first.opacity, lessThan(1));
      await tester.pumpAndSettle();
      for (final o in tester.widgetList<Opacity>(
        find.descendant(
          of: find.byType(StaggeredReveal),
          matching: find.byType(Opacity),
        ),
      )) {
        expect(o.opacity, 1);
      }
    });

    testWidgets('PopIn shows its child unchanged with reduced motion', (
      tester,
    ) async {
      await _pump(
        tester,
        const PopIn(child: Text('Hello')),
        reduced: true,
      );
      expect(find.text('Hello'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(PopIn),
          matching: find.byType(FadeTransition),
        ),
        findsNothing,
      );
    });
  });

  group('decorations build in both motion modes', () {
    for (final reduced in [false, true]) {
      testWidgets('reduced=$reduced', (tester) async {
        await _pump(
          tester,
          SizedBox(
            width: 360,
            height: 700,
            child: SunHill(
              riseFrom: 0.1,
              riseTo: 0.4,
              child: ListView(
                children: [
                  const SizedBox(
                    height: 160,
                    child: RibbonSweep(child: Text('Nice work')),
                  ),
                  const Breathing(child: Text('Breathe')),
                  const Row(children: [PulseDot(), HfLoader()]),
                  const RippleRings(size: 160, child: Text('Ringing')),
                  const DrawnCheck(confetti: true),
                  const HfBrandMark(size: 64, showWordmark: true),
                ],
              ),
            ),
          ),
          reduced: reduced,
        );
        await tester.pump(const Duration(milliseconds: 300));
        await tester.pump(const Duration(seconds: 2));
        expect(find.text('Nice work'), findsOneWidget);
        expect(find.text(Brand.name), findsOneWidget);
        expect(find.text('Breathe'), findsOneWidget);
        expect(find.text('Ringing'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      });
    }
  });
}
