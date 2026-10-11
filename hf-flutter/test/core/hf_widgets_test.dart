import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';

Widget _host(Widget child, {ThemeData? theme}) => MaterialApp(
      theme: theme ?? buildHfTheme(),
      home: Scaffold(body: Padding(padding: const EdgeInsets.all(16), child: child)),
    );

void main() {
  setUp(() {
    // HapticFeedback talks to the platform channel; answer it so the call cannot fail in a test.
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async => null);
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  group('HfSegmented', () {
    testWidgets('tapping an option changes the selection', (tester) async {
      var selected = 0;
      await tester.pumpWidget(_host(StatefulBuilder(
        builder: (context, setState) => HfSegmented(
          options: const ['Everyone', 'Women-only', 'LGBTQ+'],
          selected: selected,
          onChanged: (i) => setState(() => selected = i),
        ),
      )));
      expect(selected, 0);
      await tester.tap(find.text('Women-only'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(selected, 1);
      await tester.tap(find.text('LGBTQ+'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(selected, 2);
    });

    testWidgets('tapping the selected option does not fire', (tester) async {
      var calls = 0;
      await tester.pumpWidget(_host(HfSegmented(
        options: const ['A', 'B'],
        selected: 0,
        onChanged: (_) => calls++,
      )));
      await tester.tap(find.text('A'));
      expect(calls, 0);
    });
  });

  group('HfSlideToConfirm', () {
    Widget slider({required VoidCallback onConfirm, required VoidCallback onFallback, bool enabled = true}) =>
        _host(HfSlideToConfirm(
          label: 'Slide to call Neha',
          icon: Icons.call_rounded,
          onConfirm: onConfirm,
          fallbackLabel: 'Or tap here to call',
          onFallback: onFallback,
          enabled: enabled,
        ));

    testWidgets('dragging past 90% confirms', (tester) async {
      var confirmed = 0;
      await tester.pumpWidget(slider(onConfirm: () => confirmed++, onFallback: () {}));
      await tester.drag(find.byKey(const ValueKey<String>('hf-slide-knob')), const Offset(700, 0));
      await tester.pump();
      expect(confirmed, 1);
      await tester.pumpAndSettle(); // the knob springs back
    });

    testWidgets('a short drag springs back without confirming', (tester) async {
      var confirmed = 0;
      await tester.pumpWidget(slider(onConfirm: () => confirmed++, onFallback: () {}));
      await tester.drag(find.byKey(const ValueKey<String>('hf-slide-knob')), const Offset(60, 0));
      await tester.pumpAndSettle();
      expect(confirmed, 0);
    });

    testWidgets('the fallback button is always there and calls onFallback', (tester) async {
      var fallback = 0;
      await tester.pumpWidget(slider(onConfirm: () {}, onFallback: () => fallback++));
      expect(find.text('Or tap here to call'), findsOneWidget);
      await tester.tap(find.text('Or tap here to call'));
      expect(fallback, 1);
    });

    testWidgets('disabled: neither the slide nor the fallback fires', (tester) async {
      var confirmed = 0;
      var fallback = 0;
      await tester.pumpWidget(slider(onConfirm: () => confirmed++, onFallback: () => fallback++, enabled: false));
      await tester.drag(find.byKey(const ValueKey<String>('hf-slide-knob')), const Offset(700, 0));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Or tap here to call'), warnIfMissed: false);
      expect(confirmed, 0);
      expect(fallback, 0);
    });
  });

  group('HfFloatingNav', () {
    const items = [
      HfNavItem(icon: Icons.search_rounded, label: 'Discover', tint: HfTint.lavender, keyName: 'nav-discover'),
      HfNavItem(icon: Icons.account_balance_wallet_outlined, label: 'Wallet', tint: HfTint.sky, keyName: 'nav-wallet'),
      HfNavItem(icon: Icons.person_outline_rounded, label: 'Me', tint: HfTint.blush, keyName: 'nav-me'),
    ];

    testWidgets('tapping an item calls onTap with its index', (tester) async {
      final taps = <int>[];
      await tester.pumpWidget(_host(HfFloatingNav(items: items, selected: 0, onTap: taps.add)));
      await tester.tap(find.byKey(const ValueKey<String>('nav-wallet')));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.byKey(const ValueKey<String>('nav-me')));
      await tester.pump(const Duration(milliseconds: 300));
      expect(taps, [1, 2]);
    });

    testWidgets('only the selected item shows its label', (tester) async {
      await tester.pumpWidget(_host(HfFloatingNav(items: items, selected: 1, onTap: (_) {})));
      expect(find.text('Wallet'), findsOneWidget);
      expect(find.text('Discover'), findsNothing);
      expect(find.text('Me'), findsNothing);
    });

    testWidgets('survives the largest system font without overflow', (tester) async {
      tester.platformDispatcher.textScaleFactorTestValue = 2.0;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pumpWidget(_host(HfFloatingNav(items: items, selected: 0, onTap: (_) {})));
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.takeException(), isNull);
    });
  });

  group('HfStatusPill', () {
    testWidgets('shows the right words for each presence', (tester) async {
      const expected = {
        HfPresence.online: 'Online now',
        HfPresence.busy: 'On a call',
        HfPresence.offline: 'Offline',
        HfPresence.away: 'Not taking calls',
      };
      for (final e in expected.entries) {
        await tester.pumpWidget(_host(HfStatusPill(status: e.key, animate: false)));
        expect(find.text(e.value), findsOneWidget, reason: '${e.key}');
      }
    });

    test('fromApi maps the server strings', () {
      expect(HfPresence.fromApi('online'), HfPresence.online);
      expect(HfPresence.fromApi('busy'), HfPresence.busy);
      expect(HfPresence.fromApi('away'), HfPresence.away);
      expect(HfPresence.fromApi('offline'), HfPresence.offline);
      expect(HfPresence.fromApi(null), HfPresence.offline);
      expect(HfPresence.fromApi('???'), HfPresence.offline);
    });
  });

  group('other shared widgets', () {
    testWidgets('HfTile shows value and caption in both themes', (tester) async {
      for (final theme in [buildHfTheme(), buildHfDarkTheme()]) {
        await tester.pumpWidget(_host(
          const HfTile(tint: HfTint.sky, icon: Icons.refresh_rounded, value: '23', caption: 'regulars', compact: true),
          theme: theme,
        ));
        expect(find.text('23'), findsOneWidget);
        expect(find.text('regulars'), findsOneWidget);
      }
    });

    testWidgets('HfChip variants render their label; tap fires', (tester) async {
      var taps = 0;
      await tester.pumpWidget(_host(Wrap(children: [
        HfChip.dark(label: 'All moods', onTap: () => taps++),
        const HfChip.filled(label: 'Naye dost', tint: HfTint.peach),
        const HfChip.outline(label: 'breakup'),
        const HfChip.selected(label: 'din kharab tha'),
      ])));
      for (final l in ['All moods', 'Naye dost', 'breakup', 'din kharab tha']) {
        expect(find.text(l), findsOneWidget);
      }
      expect(find.byIcon(Icons.check_rounded), findsOneWidget);
      await tester.tap(find.text('All moods'));
      expect(taps, 1);
    });

    testWidgets('HfVoiceBar toggles via onTap', (tester) async {
      var taps = 0;
      await tester.pumpWidget(_host(HfVoiceBar(
        title: 'Her voice',
        durationLabel: '0:20',
        heights: const [30, 55, 40, 75, 50],
        progress: 0.4,
        onTap: () => taps++,
      )));
      await tester.tap(find.text('Her voice'));
      expect(taps, 1);
      expect(find.text('0:20'), findsOneWidget);
    });

    testWidgets('HfSkeleton.hostCard renders without overflow', (tester) async {
      tester.view.physicalSize = const Size(780, 2400);
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(_host(const SingleChildScrollView(child: HfSkeleton.hostCard(animate: false))));
      expect(tester.takeException(), isNull);
    });

    testWidgets('showHfSheet shows title, content and footer', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: buildHfTheme(),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => showHfSheet<void>(
                  context,
                  title: 'Find your person',
                  onClear: () {},
                  footer: const Text('Show hosts'),
                  builder: (_) => ListView(children: const [Text('How are you feeling?')]),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Find your person'), findsOneWidget);
      expect(find.text('Clear all'), findsOneWidget);
      expect(find.text('How are you feeling?'), findsOneWidget);
      expect(find.text('Show hosts'), findsOneWidget);
    });

    testWidgets('HfVerifiedBadge has a semantics label', (tester) async {
      await tester.pumpWidget(_host(const HfVerifiedBadge()));
      expect(find.bySemanticsLabel('Video verified'), findsOneWidget);
    });
  });
}
