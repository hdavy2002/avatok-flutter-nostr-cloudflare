import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/features/demo/demo_audio.dart';
import 'package:hf_app/features/demo/demo_data.dart';
import 'package:hf_app/features/explore/data/explore_controller.dart';
import 'package:hf_app/features/explore/data/host_filters.dart';
import 'package:hf_app/features/host_profile/data/intro_player.dart';

import '../../support/fake_api_client.dart';
import '../call/call_harness.dart';
import '../explore/explore_test_support.dart';

/// True when [w] draws a bundled picture (an `Image.asset`, possibly wrapped to decode smaller).
bool _isAssetImage(Widget w, String name) {
  if (w is! Image) return false;
  var p = w.image;
  if (p is ResizeImage) p = p.imageProvider;
  return p is AssetImage && p.assetName.endsWith(name);
}

Future<void> _tapStar(WidgetTester tester, int n) async {
  final stars = find.byWidgetPredicate(
    (w) =>
        w is Icon &&
        (w.icon == Icons.star_rounded || w.icon == Icons.star_outline_rounded),
  );
  await tester.tap(stars.at(n - 1));
  await tester.pump();
}

void main() {
  group('Discover', () {
    testWidgets(
      'the demo hosts come first, with a Demo chip, ahead of real hosts',
      (tester) async {
        final api = fakeApi()
          ..onJson('GET', '/api/hf/hosts', pageJson([hostJson('real-one')]));
        final c = await pumpScreen(tester, api: api);
        // pumpScreen turns the demo off for the other Explore tests; here it is wanted.
        demoHostsInLists = true;
        await c.read(exploreControllerProvider.notifier).reload();
        await tester.pumpAndSettle();

        final items = c.read(exploreControllerProvider).items;
        expect(items.map((h) => h.slug).toList(), [
          kDemoNehaSlug,
          kDemoRohanSlug,
          'real-one',
        ]);
        expect(find.text('Neha'), findsOneWidget);
        expect(find.byKey(const ValueKey<String>('demo-chip')), findsWidgets);
        expect(
          find.byWidgetPredicate((w) => _isAssetImage(w, 'demo_neha.webp')),
          findsWidgets,
        );
      },
    );

    test('a filter or a lane shows real hosts only', () {
      demoHostsInLists = true;
      final real = [kDemoNehaCard]; // any list will do
      expect(withDemoHosts(const HostFilters(online: true), real).length, 1);
      expect(withDemoHosts(HostFilters.none, const []).length, 2);
      expect(
        withDemoHosts(HostFilters.none, const [kDemoNehaCard]).length,
        2,
        reason: 'no duplicate of a demo host',
      );
    });
  });

  testWidgets(
    'the demo profile renders from bundled pictures with no request',
    (tester) async {
      final api = fakeApi();
      await pumpScreen(tester, api: api, location: '/h/$kDemoNehaSlug');
      expect(find.text('Neha'), findsWidgets);
      expect(find.byKey(const ValueKey<String>('demo-chip')), findsOneWidget);
      expect(find.text('A calm ear after a long day'), findsOneWidget);
      expect(
        find.byWidgetPredicate((w) => _isAssetImage(w, 'demo_neha.webp')),
        findsWidgets,
      );
      expect(api.callsTo('GET', '/api/hosts/public/$kDemoNehaSlug'), isEmpty);
      expect(api.callsTo('GET', '/api/hf/wallet/estimate'), isEmpty);
    },
  );

  group('as a guest (signed out)', () {
    testWidgets('Call Neha opens the confirm step and the call, no sign-in', (
      tester,
    ) async {
      final api = fakeApi();
      final c = await pumpScreen(
        tester,
        api: api,
        location: '/h/$kDemoNehaSlug',
      );
      await tester.tap(find.text('Call Neha'));
      await tester.pumpAndSettle();
      expect(find.text('Call Neha'), findsWidgets);
      expect(find.text('about 96 min'), findsOneWidget);
      final callButton = find.text('Or tap here to call');
      await tester.ensureVisible(callButton);
      await tester.pump();
      await tester.tap(callButton);
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Ringing Neha…'), findsOneWidget);
      // The ringed avatar shows Neha's photo.
      expect(
        find.byWidgetPredicate((w) => _isAssetImage(w, 'demo_neha.webp')),
        findsWidgets,
      );
      expect(api.callsTo('POST', '/api/hf/calls'), isEmpty);
      await tester.pumpWidget(const SizedBox());
      c.dispose(); // the call was left ringing: stop its timers
    });

    testWidgets('Notify me on Rohan is a snackbar, no sign-in', (tester) async {
      final api = fakeApi();
      await pumpScreen(tester, api: api, location: '/h/$kDemoRohanSlug');
      await tester.tap(find.text('Notify me when free'));
      await tester.pump();
      expect(find.text(kDemoNotifyMessage), findsOneWidget);
      expect(
        api.callsTo('POST', '/api/hf/hosts/$kDemoRohanSlug/notify'),
        isEmpty,
      );
    });

    test('only demo locations skip the sign-in redirect', () {
      expect(isDemoUri(Uri.parse('/call/new?host=$kDemoNehaSlug')), isTrue);
      expect(isDemoUri(Uri.parse('/call/$kDemoCallId')), isTrue);
      expect(isDemoUri(Uri.parse('/call/new?host=asha')), isFalse);
      expect(isDemoUri(Uri.parse('/call/c1')), isFalse);
    });
  });

  group('simulated booking', () {
    testWidgets(
      'confirm shows the fake estimate; tap to call starts the demo call',
      (tester) async {
        prepareStorage();
        final api = FakeApiClient();
        final app = await pumpCallApp(
          tester,
          api: api,
          location: '/call/new?host=$kDemoNehaSlug',
        );
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.text('Call Neha'), findsOneWidget);
        expect(find.text('about 96 min'), findsOneWidget);
        expect(find.textContaining('₹342'), findsOneWidget);

        final callButton = find.text('Or tap here to call');
        await tester.ensureVisible(callButton);
        await tester.pump();
        await tester.tap(callButton);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 600));
        await tester.pump(const Duration(milliseconds: 600));
        expect(find.text('Ringing Neha…'), findsOneWidget);
        expect(api.calls, isEmpty, reason: 'the demo makes no request at all');
        await closeApp(tester);
        app.container.dispose(); // the call was left ringing: stop its timers
      },
    );

    testWidgets(
      'ringing, ringing you, connected, ended: summary says nothing was charged',
      (tester) async {
        prepareStorage();
        final api = FakeApiClient();
        await pumpCallApp(tester, api: api, location: '/call/$kDemoCallId');
        await tester.pump();
        expect(find.text('Ringing Neha…'), findsOneWidget);
        expect(find.text('Cancel call'), findsOneWidget);

        await tester.pump(const Duration(seconds: 3));
        await tester.pump();
        expect(find.text('Neha said yes'), findsOneWidget);

        await tester.pump(const Duration(seconds: 4));
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.text('Connected'), findsOneWidget);
        expect(find.text('End demo call'), findsOneWidget);
        expect(find.text('Cancel call'), findsNothing);

        await tester.pump(const Duration(seconds: 65));
        expect(find.text('01:05'), findsOneWidget);

        await tester.tap(find.text('End demo call'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.text('Call ended'), findsOneWidget);
        // Standard-plan calls show exact duration and per-second charges.
        expect(find.text('1 min 5 s'), findsOneWidget);
        expect(find.text('₹4.32'), findsOneWidget);
        expect(find.text('Demo — nothing was charged.'), findsOneWidget);
        expect(find.text('Rate your call'), findsOneWidget);
        expect(api.calls, isEmpty);
        await closeApp(tester);
      },
    );

    testWidgets('cancel works while it rings', (tester) async {
      prepareStorage();
      await pumpCallApp(
        tester,
        api: FakeApiClient(),
        location: '/call/$kDemoCallId',
      );
      await tester.pump();
      await tester.pump(const Duration(seconds: 3));
      await tester.tap(find.text('Cancel call'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Call cancelled.'), findsOneWidget);
      expect(find.text('Demo — nothing was charged.'), findsOneWidget);
      // Nothing else happens later.
      await tester.pump(const Duration(seconds: 10));
      expect(find.text('Connected'), findsNothing);
      await closeApp(tester);
    });

    testWidgets('rate, send, thank you, and back to Discover', (tester) async {
      prepareStorage();
      final api = FakeApiClient();
      await pumpCallApp(tester, api: api, location: '/call/$kDemoCallId');
      await tester.pump();
      await tester.pump(const Duration(seconds: 7));
      await tester.pump(const Duration(seconds: 20));
      await tester.tap(find.text('End demo call'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      await tester.tap(find.text('Rate your call'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('How was your call with Neha?'), findsOneWidget);
      await _tapStar(tester, 5);
      await tester.scrollUntilVisible(
        find.text('Send review'),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Send review'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Thank you!'), findsOneWidget);

      await tester.tap(find.text('Done'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('EXPLORE PAGE'), findsOneWidget);
      expect(api.calls, isEmpty);
      await closeApp(tester);
    });
  });

  testWidgets(
    'the demo voice clip plays 20 s with no audio and then completes',
    (tester) async {
      final p = DemoAwareIntroPlayer(() => throw StateError('no real player'));
      final states = <IntroPlayerState>[];
      final positions = <Duration>[];
      p.states.listen(states.add);
      p.positions.listen(positions.add);
      await p.play('${kDemoAudioPrefix}neha-intro');
      await tester.pump(const Duration(seconds: 10));
      expect(states, [IntroPlayerState.playing]);
      expect(positions.last, greaterThanOrEqualTo(const Duration(seconds: 9)));
      await tester.pump(const Duration(seconds: 11));
      expect(states.last, IntroPlayerState.completed);
      await p.dispose();
    },
  );
}
