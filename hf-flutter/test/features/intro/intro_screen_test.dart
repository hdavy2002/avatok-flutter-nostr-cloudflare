import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/router/deep_link_handler.dart';
import 'package:hf_app/core/router/pending_intent.dart';
import 'package:hf_app/core/router/routes.dart';
import 'package:hf_app/core/router/startup_navigation.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/call/data/call_api.dart';
import 'package:hf_app/features/intro/ui/intro_screen.dart';

Future<ProviderContainer> pumpIntro(WidgetTester tester, {bool dark = false, String? activeCall, Future<String?> Function()? resume}) async {
  final router = GoRouter(initialLocation: Routes.intro, routes: [
    GoRoute(path: Routes.intro, builder: (_, __) => const IntroScreen()),
    for (final path in [Routes.explore, Routes.wallet, '/call/active'])
      GoRoute(path: path, builder: (_, __) => Scaffold(body: Text('LANDED $path'))),
  ]);
  final container = ProviderContainer(overrides: [
    appRouterProvider.overrideWithValue(router),
    pendingIntentProvider.overrideWithValue(PendingIntentStore(MemoryKeyValueStore())),
    activeCallResumeProvider.overrideWith((_) => resume?.call() ?? Future.value(activeCall)),
  ]);
  addTearDown(() { router.dispose(); container.dispose(); });
  await tester.pumpWidget(UncontrolledProviderScope(container: container,
    child: MaterialApp.router(theme: dark ? buildHfDarkTheme() : buildHfTheme(), routerConfig: router)));
  await tester.pumpAndSettle();
  return container;
}

Future<void> tapIntro(WidgetTester tester, String key) async {
  final target = find.byKey(ValueKey(key));
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

void main() {
  const channel = MethodChannel('hf/install_intro');
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (_) async => true);
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, null);
  });

  testWidgets('Back navigates previous pages, then exits without completing intro', (tester) async {
    var writes = 0;
    var exits = 0;
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'complete') writes++;
      return false;
    });
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'SystemNavigator.pop') exits++;
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(SystemChannels.platform, null));
    final c = await pumpIntro(tester);
    await tapIntro(tester, 'intro-next');
    await tapIntro(tester, 'intro-next');
    for (final expectedPage in [2, 1]) {
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.text('Page $expectedPage of 3'), findsOneWidget);
      expect(exits, 0);
    }
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(exits, 1);
    expect(writes, 0);
    expect(c.read(bootDoneProvider), isFalse);
    expect(c.read(appRouterProvider).routeInformationProvider.value.uri.path, Routes.intro);
  });

  testWidgets('a queued explicit link never starts slow call recovery', (tester) async {
    final recovery = Completer<String?>();
    var recoveryReads = 0;
    final c = await pumpIntro(tester, resume: () {
      recoveryReads++;
      return recovery.future;
    });
    await c.read(deepLinkHandlerProvider).handle('/wallet', source: 'push');
    await c.read(startupNavigationProvider).openLanding();
    await tester.pumpAndSettle();
    expect(find.text('LANDED /wallet'), findsOneWidget);
    expect(c.read(bootDoneProvider), isTrue);
    expect(recoveryReads, 0);
    recovery.complete(null);
  });

  testWidgets('slow recovery times out to Explore and a late result cannot navigate', (tester) async {
    final recovery = Completer<String?>();
    final c = await pumpIntro(tester, resume: () => recovery.future);
    final landing = c.read(startupNavigationProvider).openLanding();
    await tester.pump();
    await tester.pump(StartupNavigation.recoveryTimeout + const Duration(milliseconds: 100));
    await landing;
    await tester.pumpAndSettle();
    expect(find.text('LANDED /explore'), findsOneWidget);
    recovery.complete('active');
    await tester.pumpAndSettle();
    expect(find.text('LANDED /explore'), findsOneWidget);
  });

  testWidgets('a link arriving during recovery wins over active call and stored intent', (tester) async {
    final recovery = Completer<String?>();
    final c = await pumpIntro(tester, resume: () => recovery.future);
    await c.read(pendingIntentProvider).save('/explore');
    final landing = c.read(startupNavigationProvider).openLanding();
    await tester.pump();
    await c.read(deepLinkHandlerProvider).handle('/wallet', source: 'push');
    recovery.complete('active');
    await landing;
    await tester.pumpAndSettle();
    expect(find.text('LANDED /wallet'), findsOneWidget);
  });

  testWidgets('active-call recovery wins over stored pending intent', (tester) async {
    final c = await pumpIntro(tester, activeCall: 'active');
    await c.read(pendingIntentProvider).save('/wallet');
    await c.read(startupNavigationProvider).openLanding();
    await tester.pumpAndSettle();
    expect(find.text('LANDED /call/active'), findsOneWidget);
  });

  testWidgets('three pages explain browsing and pricing, then open Explore', (tester) async {
    final c = await pumpIntro(tester);
    expect(find.text('Page 1 of 3'), findsOneWidget);
    expect(c.read(bootDoneProvider), isFalse);
    await tapIntro(tester, 'intro-next');
    expect(find.text('Listen before you connect'), findsOneWidget);
    expect(find.text('You are charged only while connected.'), findsOneWidget);
    await tapIntro(tester, 'intro-next');
    expect(find.text('Page 3 of 3'), findsOneWidget);
    expect(find.text('Start exploring'), findsOneWidget);
    await tapIntro(tester, 'intro-next');
    expect(find.text('LANDED /explore'), findsOneWidget);
    expect(c.read(bootDoneProvider), isTrue);
  });

  testWidgets('links stay queued until Skip and a valid explicit target wins', (tester) async {
    final c = await pumpIntro(tester);
    await c.read(deepLinkHandlerProvider).handle('/wallet', source: 'push');
    expect(c.read(pendingLinkProvider), isNotNull);
    expect(find.byType(IntroScreen), findsOneWidget);
    await tapIntro(tester, 'intro-skip');
    expect(find.text('LANDED /wallet'), findsOneWidget);
  });

  testWidgets('an ignored pending link still lands on Explore', (tester) async {
    final c = await pumpIntro(tester);
    await c.read(deepLinkHandlerProvider).handle('https://example.test/private', source: 'link');
    await tapIntro(tester, 'intro-skip');
    expect(find.text('LANDED /explore'), findsOneWidget);
  });

  testWidgets('an active call is resumed after the intro', (tester) async {
    await pumpIntro(tester, activeCall: 'active');
    await tapIntro(tester, 'intro-skip');
    expect(find.text('LANDED /call/active'), findsOneWidget);
  });

  for (final dark in [false, true]) {
    testWidgets('photos retain white frames at 320px with 2x text, dark=$dark', (tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await pumpIntro(tester, dark: dark);
      for (final photo in ['find-person', 'listen-first', 'explore-freely']) {
        final frame = tester.widget<Container>(find.byKey(ValueKey('intro-photo-$photo')));
        final decoration = frame.decoration! as BoxDecoration;
        expect(decoration.color, Colors.white);
        expect(decoration.boxShadow, isNotEmpty);
        expect(tester.takeException(), isNull);
        await tester.ensureVisible(find.byKey(const ValueKey('intro-next')));
        await tester.pumpAndSettle();
        expect(tester.getSize(find.byKey(const ValueKey('intro-next'))).height,
          greaterThanOrEqualTo(48));
        if (photo != 'explore-freely') await tapIntro(tester, 'intro-next');
      }
    });
  }

  group('HF-MOTION-A motion', () {
    BeaverPose pose(WidgetTester tester) => tester
        .widget<BeaverGuide>(find.byKey(const ValueKey('intro-beaver')))
        .pose;
    double pillWidth(WidgetTester tester, int i) =>
        tester.getSize(find.byKey(ValueKey('intro-dot-pill-$i'))).width;

    testWidgets('the beaver guides each page (wave, point, thumbs) and the active dot is a pill', (tester) async {
      await pumpIntro(tester);
      expect(pose(tester), BeaverPose.wave);
      expect(find.text('Your language. Your mood. Your choice.'), findsOneWidget);
      expect(pillWidth(tester, 0), greaterThan(pillWidth(tester, 1)));
      await tapIntro(tester, 'intro-next');
      expect(pose(tester), BeaverPose.point);
      expect(pillWidth(tester, 1), greaterThan(pillWidth(tester, 0)));
      await tapIntro(tester, 'intro-next');
      expect(pose(tester), BeaverPose.thumbs);
      expect(pillWidth(tester, 2), greaterThan(pillWidth(tester, 1)));
      expect(find.byKey(const ValueKey('intro-blob')), findsOneWidget);
    });

    testWidgets('a horizontal swipe moves one page either way and never completes the intro', (tester) async {
      final c = await pumpIntro(tester);
      final title = find.text('Find the right person to talk to');
      await tester.fling(title, const Offset(-300, 0), 1200);
      await tester.pumpAndSettle();
      expect(find.text('Page 2 of 3'), findsOneWidget);
      await tester.fling(find.text('Listen before you connect'), const Offset(300, 0), 1200);
      await tester.pumpAndSettle();
      expect(find.text('Page 1 of 3'), findsOneWidget);
      await tapIntro(tester, 'intro-next');
      await tapIntro(tester, 'intro-next');
      await tester.fling(find.text('Explore freely'), const Offset(-300, 0), 1200);
      await tester.pumpAndSettle();
      expect(find.text('Page 3 of 3'), findsOneWidget);
      expect(c.read(bootDoneProvider), isFalse);
    });

    testWidgets('reduced motion shows every page in its final state at once', (tester) async {
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      await pumpIntro(tester);
      await tapIntro(tester, 'intro-next');
      // No fade or rise wraps the copy, and the whole bubble is readable straight away.
      final heading = find.text('Listen before you connect');
      expect(find.ancestor(of: heading, matching: find.byType(Opacity)), findsNothing);
      final bubble = tester.widget<Text>(find.byKey(SpeechBubble.textKey));
      final shown = (bubble.textSpan! as TextSpan).children!.first as TextSpan;
      expect(shown.text, 'You are charged only while connected.');
      expect(pillWidth(tester, 1), greaterThan(pillWidth(tester, 0)));
    });
  });
}
