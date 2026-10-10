import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/config/flags.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/update/update_check.dart';
import 'package:hf_app/core/update/update_gate.dart';

Finder _key(String k) => find.byKey(ValueKey<String>(k));

class _Store extends LinkOpener {
  _Store({this.result = true});

  final bool result;
  int opened = 0;

  @override
  Future<bool> playStore() async {
    opened += 1;
    return result;
  }
}

void main() {
  group('updateStatusFor', () {
    test('below the minimum is forced, below the latest is soft, otherwise none', () {
      expect(updateStatusFor(installed: 5, latest: 9, min: 7), UpdateStatus.forced);
      expect(updateStatusFor(installed: 7, latest: 9, min: 7), UpdateStatus.soft);
      expect(updateStatusFor(installed: 8, latest: 9, min: 7), UpdateStatus.soft);
      expect(updateStatusFor(installed: 9, latest: 9, min: 7), UpdateStatus.none);
      expect(updateStatusFor(installed: 12, latest: 9, min: 7), UpdateStatus.none);
    });

    test('zero means never prompt', () {
      expect(updateStatusFor(installed: 5, latest: 0, min: 0), UpdateStatus.none);
      expect(updateStatusFor(installed: 5, latest: 9, min: 0), UpdateStatus.soft);
      expect(updateStatusFor(installed: 5, latest: 0, min: 7), UpdateStatus.forced);
    });

    test('an unknown installed build never nags', () {
      expect(updateStatusFor(installed: -1, latest: 9, min: 7), UpdateStatus.none);
      expect(updateStatusFor(installed: 0, latest: 9, min: 7), UpdateStatus.none);
    });
  });

  group('UpdateGate', () {
    late List<Map<String, Object>> events;
    late _Store store;

    setUp(() {
      events = <Map<String, Object>>[];
      UpdateTelemetry.sink = (e, p) async => events.add({'event': e, ...p});
      store = _Store();
      LinkOpener.instance = store;
    });

    tearDown(() {
      UpdateTelemetry.resetSink();
      LinkOpener.instance = const LinkOpener();
    });

    Map<String, Object> ev(String kind, String action, int installed) =>
        {'event': 'hf_app_update_prompt', 'kind': kind, 'action': action, 'installed': installed};

    Future<void> pumpGate(
      WidgetTester tester, {
      required int installed,
      int latest = 0,
      int min = 0,
      Widget home = const Scaffold(body: Center(child: Text('the app'))),
    }) async {
      await tester.pumpWidget(ProviderScope(
        overrides: <Override>[
          installedBuildProvider.overrideWithValue(installed),
          flagsProvider.overrideWith(
            (ref) => HfFlags.fromJson({'hfAppLatestBuild': latest, 'hfAppMinBuild': min}),
          ),
        ],
        child: MaterialApp(
          theme: buildHfTheme(),
          builder: (context, child) => UpdateGate(child: child),
          home: home,
        ),
      ));
      await tester.pump();
      await tester.pump();
    }

    testWidgets('soft banner on top of the app when the build is below the latest', (tester) async {
      await pumpGate(tester, installed: 2005, latest: 2010, min: 2000);

      expect(_key('update-banner-button'), findsOneWidget);
      expect(find.text(UpdateCopy.bannerText), findsOneWidget);
      expect(find.text('the app'), findsOneWidget); // the app is still usable
      expect(_key('update-required'), findsNothing);
      expect(events, [ev('soft', 'shown', 2005)]);
    });

    testWidgets('the banner Update button opens the Play Store', (tester) async {
      await pumpGate(tester, installed: 2005, latest: 2010);
      await tester.tap(_key('update-banner-button'));
      await tester.pump();
      expect(store.opened, 1);
      expect(events.last, ev('soft', 'update_tapped', 2005));
    });

    testWidgets('Not now closes the banner and the app stays', (tester) async {
      await pumpGate(tester, installed: 2005, latest: 2010);
      await tester.tap(_key('update-banner-close'));
      await tester.pump();
      expect(_key('update-banner-button'), findsNothing);
      expect(find.text('the app'), findsOneWidget);
      expect(events.last, ev('soft', 'dismissed', 2005));
    });

    testWidgets('a store that cannot open says so on the banner', (tester) async {
      LinkOpener.instance = _Store(result: false);
      await pumpGate(tester, installed: 2005, latest: 2010);
      await tester.tap(_key('update-banner-button'));
      await tester.pump();
      expect(find.text(UpdateCopy.couldNotOpen), findsOneWidget);
    });

    testWidgets('blocking screen replaces the app when the build is below the minimum', (tester) async {
      await pumpGate(tester, installed: 2005, latest: 2010, min: 2008);

      expect(_key('update-required'), findsOneWidget);
      expect(find.text(UpdateCopy.forcedTitle), findsOneWidget);
      expect(find.text('the app'), findsNothing);
      expect(_key('update-banner-button'), findsNothing);
      expect(events, [ev('forced', 'shown', 2005)]);

      await tester.tap(_key('update-required-button'));
      await tester.pump();
      expect(store.opened, 1);
      expect(events.last, ev('forced', 'update_tapped', 2005));
    });

    testWidgets('nothing shows when the build is current', (tester) async {
      await pumpGate(tester, installed: 2010, latest: 2010, min: 2000);
      expect(_key('update-banner-button'), findsNothing);
      expect(_key('update-required'), findsNothing);
      expect(find.text('the app'), findsOneWidget);
      expect(events, isEmpty);
    });

    testWidgets('nothing shows when both numbers are 0', (tester) async {
      await pumpGate(tester, installed: 2005, latest: 0, min: 0);
      expect(_key('update-banner-button'), findsNothing);
      expect(_key('update-required'), findsNothing);
      expect(find.text('the app'), findsOneWidget);
      expect(events, isEmpty);
    });

    testWidgets('nothing shows when the installed build is unknown', (tester) async {
      await pumpGate(tester, installed: -1, latest: 2010, min: 2008);
      expect(_key('update-banner-button'), findsNothing);
      expect(_key('update-required'), findsNothing);
      expect(find.text('the app'), findsOneWidget);
      expect(events, isEmpty);
    });

    testWidgets('the app below the banner keeps its state when the banner closes', (tester) async {
      await pumpGate(
        tester,
        installed: 2005,
        latest: 2010,
        home: const Scaffold(body: TextField(key: ValueKey<String>('field'))),
      );
      await tester.enterText(_key('field'), 'kept');
      await tester.tap(_key('update-banner-close'));
      await tester.pump();
      expect(find.text('kept'), findsOneWidget);
    });
  });
}
