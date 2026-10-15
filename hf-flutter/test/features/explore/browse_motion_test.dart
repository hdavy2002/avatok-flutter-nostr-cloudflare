import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/explore/widgets/browse_motion.dart';

import 'explore_test_support.dart';

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

/// Opacity of the nearest [Opacity] above [of], or 1 when there is none (fully shown, no wrapper).
double _opacityAbove(WidgetTester tester, Finder of) {
  final o = find.ancestor(of: of, matching: find.byType(Opacity));
  if (o.evaluate().isEmpty) return 1;
  return tester.widget<Opacity>(o.first).opacity;
}

double _scaleAbove(WidgetTester tester, Finder of) {
  final t = find.ancestor(of: of, matching: find.byType(Transform));
  if (t.evaluate().isEmpty) return 1;
  return tester.widget<Transform>(t.first).transform.getMaxScaleOnAxis();
}

void main() {
  group('RiseIn', () {
    testWidgets('fades and rises in once, then rebuilds do not replay it', (
      tester,
    ) async {
      Widget card(String label) => RiseIn(
        key: const ValueKey('rise-neha'),
        child: Text(label, key: const Key('card')),
      );
      await _pump(tester, card('Neha'));
      expect(_opacityAbove(tester, find.byKey(const Key('card'))), lessThan(1));
      await tester.pump(const Duration(milliseconds: 200));
      final mid = _opacityAbove(tester, find.byKey(const Key('card')));
      expect(mid, greaterThan(0));
      expect(mid, lessThan(1));
      await tester.pumpAndSettle();
      expect(_opacityAbove(tester, find.byKey(const Key('card'))), 1);

      // Same key, new data: shown at once, no replay.
      await _pump(tester, card('Neha (updated)'));
      expect(find.text('Neha (updated)'), findsOneWidget);
      expect(_opacityAbove(tester, find.byKey(const Key('card'))), 1);
      expect(tester.hasRunningAnimations, isFalse);
    });

    testWidgets('index staggers the start, capped for late pages', (
      tester,
    ) async {
      await _pump(
        tester,
        const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            RiseIn(key: ValueKey('a'), child: Text('A')),
            RiseIn(key: ValueKey('b'), index: 3, child: Text('B')),
            RiseIn(key: ValueKey('z'), index: 40, child: Text('Z')),
          ],
        ),
      );
      await tester.pump(const Duration(milliseconds: 150));
      final a = _opacityAbove(tester, find.text('A'));
      final b = _opacityAbove(tester, find.text('B'));
      expect(a, greaterThan(b));
      // 40 items in: waits at most 5 x 70 ms, so it is fully in well under a second.
      await tester.pump(const Duration(milliseconds: 700));
      expect(_opacityAbove(tester, find.text('Z')), 1);
      await tester.pumpAndSettle();
    });

    testWidgets('animate: false and reduced motion show the card at once', (
      tester,
    ) async {
      await _pump(
        tester,
        const RiseIn(animate: false, child: Text('seen')),
      );
      expect(_opacityAbove(tester, find.text('seen')), 1);
      await _pump(
        tester,
        const RiseIn(key: ValueKey('r'), child: Text('reduced')),
        reduced: true,
      );
      expect(_opacityAbove(tester, find.text('reduced')), 1);
      expect(tester.hasRunningAnimations, isFalse);
    });
  });

  group('TapBounce', () {
    testWidgets('a press squeezes the chip, it springs back, taps still work', (
      tester,
    ) async {
      var taps = 0;
      await _pump(
        tester,
        TapBounce(
          child: HfChip.filled(
            key: const Key('chip'),
            label: 'Tension',
            tint: HfTint.peach,
            onTap: () => taps++,
          ),
        ),
      );
      expect(_scaleAbove(tester, find.byKey(const Key('chip'))), 1);
      final gesture = await tester.startGesture(
        tester.getCenter(find.byKey(const Key('chip'))),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        _scaleAbove(tester, find.byKey(const Key('chip'))),
        lessThan(0.97),
      );
      await gesture.up();
      await tester.pumpAndSettle();
      expect(taps, 1);
      expect(_scaleAbove(tester, find.byKey(const Key('chip'))), 1);
    });

    testWidgets('reduced motion: no bounce', (tester) async {
      await _pump(
        tester,
        TapBounce(
          child: HfChip.filled(
            key: const Key('chip'),
            label: 'Tension',
            tint: HfTint.peach,
            onTap: () {},
          ),
        ),
        reduced: true,
      );
      final gesture = await tester.startGesture(
        tester.getCenter(find.byKey(const Key('chip'))),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(_scaleAbove(tester, find.byKey(const Key('chip'))), 1);
      await gesture.up();
      await tester.pumpAndSettle();
    });
  });

  group('Explore screen', () {
    testWidgets('warm glow sits behind the header; cards rise in; online row '
        'shows the pulse dot', (tester) async {
      final api = fakeApi()
        ..onJson(
          'GET',
          '/api/hf/hosts',
          pageJson([
            hostJson('neha', name: 'Neha'),
            hostJson('rohan', name: 'Rohan', status: 'busy'),
          ]),
        );
      await pumpScreen(tester, api: api, liveSections: true);
      expect(find.byKey(WarmHeaderGlow.glowKey), findsOneWidget);
      expect(find.byType(RiseIn), findsWidgets);
      expect(find.byKey(const ValueKey('rise-neha')), findsWidgets);
      expect(
        find.byKey(const ValueKey<String>('online-now-pulse')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('no one online: no pulse dot', (tester) async {
      final api = fakeApi()
        ..onJson('GET', '/api/hf/hosts', pageJson(const []));
      await pumpScreen(tester, api: api, liveSections: true);
      expect(
        find.byKey(const ValueKey<String>('online-now-pulse')),
        findsNothing,
      );
    });

    testWidgets('pull to refresh uses the warm colours', (tester) async {
      final api = fakeApi()
        ..onJson('GET', '/api/hf/hosts', pageJson([hostJson('neha')]));
      await pumpScreen(tester, api: api);
      final indicator = tester.widget<RefreshIndicator>(
        find.byType(RefreshIndicator),
      );
      expect(indicator.color, HfColors.deepOrange);
      expect(indicator.backgroundColor, HfColors.butter);
    });

    testWidgets('mood chips are wrapped in a bounce', (tester) async {
      final api = fakeApi()
        ..onJson('GET', '/api/hf/hosts', pageJson([hostJson('neha')]));
      await pumpScreen(tester, api: api);
      expect(
        find.ancestor(
          of: find.byKey(const ValueKey<String>('mood-all')),
          matching: find.byType(TapBounce),
        ),
        findsOneWidget,
      );
    });

    testWidgets('empty filtered list: the sleepy beaver panel', (
      tester,
    ) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson(const []));
      await pumpScreen(tester, api: api, location: '/explore?online=1');
      expect(find.byKey(kStatePanelBeaverKey), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
